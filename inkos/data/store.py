"""On-disk training sets and the batch iterators the trainer uses.

Two formats, one per model:

  VectorSet  (INKOS 1)      shards of ragged arrays: prompt bytes + program tokens
  RasterSet  (INKOS 1 Pro)  shards of bit-packed 1-bit images + captions

An epoch is exactly one pass over the training split. The order of an epoch
is a pure function of (seed, epoch), which is what lets an interrupted run
resume in the middle of an epoch.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from .. import bitmap
from ..vector import lang


def _meta(root: Path) -> dict:
    f = root / "meta.json"
    if not f.exists():
        raise FileNotFoundError(
            f"no prepared dataset in {root}. Run:  python -m inkos data prepare --model {root.name}")
    return json.loads(f.read_text())


def dataset_info(root: Path) -> dict | None:
    try:
        return _meta(root)
    except FileNotFoundError:
        return None


# --------------------------------------------------------------------------
# INKOS 1: vector programs
# --------------------------------------------------------------------------

def write_vector_shard(path: Path, samples: list[tuple[str, list[int], int]]):
    """samples: (prompt, tokens, kind index)."""
    prompts = [np.frombuffer(p.encode("ascii", "replace"), dtype=np.uint8) for p, _, _ in samples]
    toks = [np.asarray(t, dtype=np.int16) for _, t, _ in samples]
    np.savez_compressed(
        path,
        prompt=np.concatenate(prompts) if prompts else np.zeros(0, np.uint8),
        prompt_off=np.cumsum([0] + [len(p) for p in prompts]).astype(np.int64),
        tokens=np.concatenate(toks) if toks else np.zeros(0, np.int16),
        tok_off=np.cumsum([0] + [len(t) for t in toks]).astype(np.int64),
        kind=np.asarray([k for _, _, k in samples], dtype=np.uint8),
    )


class VectorSet:
    def __init__(self, root: Path, split: str = "train"):
        self.root = Path(root)
        self.meta = _meta(self.root)
        self.kinds = self.meta["kinds"]
        P, PO, T, TO, K = [], [np.zeros(1, np.int64)], [], [np.zeros(1, np.int64)], []
        p_base = t_base = 0
        for f in sorted(self.root.glob(f"{split}-*.npz")):
            z = np.load(f)
            P.append(z["prompt"])
            PO.append(z["prompt_off"][1:] + p_base)
            p_base += len(z["prompt"])
            T.append(z["tokens"])
            TO.append(z["tok_off"][1:] + t_base)
            t_base += len(z["tokens"])
            K.append(z["kind"])
        if not P:
            raise FileNotFoundError(f"no {split} shards in {self.root}")
        self.prompt = np.concatenate(P)
        self.tokens = np.concatenate(T)
        self.prompt_off = np.concatenate(PO)
        self.tok_off = np.concatenate(TO)
        self.kind = np.concatenate(K)
        self.n = len(self.kind)
        self.lengths = (np.diff(self.prompt_off) + np.diff(self.tok_off)).astype(np.int32)

    def __len__(self) -> int:
        return self.n

    def get(self, i: int) -> tuple[str, np.ndarray, int]:
        p = self.prompt[self.prompt_off[i]: self.prompt_off[i + 1]].tobytes().decode("ascii")
        t = self.tokens[self.tok_off[i]: self.tok_off[i + 1]].astype(np.int64)
        return p, t, int(self.kind[i])

    def steps_per_epoch(self, batch_size: int) -> int:
        return (self.n + batch_size - 1) // batch_size

    def epoch_batches(self, epoch: int, batch_size: int, seed: int, shuffle: bool = True) -> list[np.ndarray]:
        """Index batches for one epoch; similar lengths are grouped to cut padding."""
        if not shuffle:
            order = np.argsort(self.lengths, kind="stable")
            return [order[i: i + batch_size] for i in range(0, self.n, batch_size)]
        rng = np.random.default_rng([seed, epoch])
        order = rng.permutation(self.n)
        chunk = batch_size * 64
        batches = []
        for s in range(0, self.n, chunk):
            part = order[s: s + chunk]
            part = part[np.argsort(self.lengths[part], kind="stable")]
            batches.extend(part[i: i + batch_size] for i in range(0, len(part), batch_size))
        perm = rng.permutation(len(batches))
        return [batches[i] for i in perm]

    def collate(self, idx: np.ndarray) -> dict:
        """-> prompt [B,P] (token ids), prompt_mask [B,P], tokens [B,T] (BOS + program),
        targets [B,T] (program + EOS, -100 on padding)."""
        items = [self.get(int(i)) for i in idx]
        B = len(items)
        P = max(len(p) for p, _, _ in items)
        T = max(len(t) for _, t, _ in items) + 1
        prompt = np.zeros((B, P), dtype=np.int64)
        pmask = np.zeros((B, P), dtype=bool)
        tokens = np.zeros((B, T), dtype=np.int64)
        targets = np.full((B, T), -100, dtype=np.int64)
        for b, (p, t, _) in enumerate(items):
            prompt[b, : len(p)] = lang.prompt_tokens(p)
            pmask[b, : len(p)] = True
            tokens[b, 0] = lang.BOS
            tokens[b, 1: len(t) + 1] = t
            targets[b, : len(t)] = t
            targets[b, len(t)] = lang.EOS
        return {"prompt": torch.from_numpy(prompt), "prompt_mask": torch.from_numpy(pmask),
                "tokens": torch.from_numpy(tokens), "targets": torch.from_numpy(targets),
                "kind": torch.from_numpy(np.asarray([k for _, _, k in items], dtype=np.int64))}

    def batches(self, epoch: int, batch_size: int, seed: int, skip: int = 0, shuffle: bool = True):
        for idx in self.epoch_batches(epoch, batch_size, seed, shuffle)[skip:]:
            yield self.collate(idx)


# --------------------------------------------------------------------------
# INKOS 1 Pro: 1-bit raster images
# --------------------------------------------------------------------------

def write_raster_shard(path: Path, images: list[np.ndarray], captions: list[str], kinds: list[int]):
    """images: bool arrays (H, W) with ink = True, or uint8 arrays of palette indices.

    Black-and-white is stored at one bit per pixel ('bits'), colour at four
    bits per pixel ('idx4').
    """
    caps = [np.frombuffer(c.encode("ascii", "replace"), dtype=np.uint8) for c in captions]
    stack = np.stack(images)
    pixels = {"bits": bitmap.pack(stack)} if stack.dtype == bool else {"idx4": bitmap.pack4(stack)}
    np.savez_compressed(
        path,
        **pixels,
        caption=np.concatenate(caps) if caps else np.zeros(0, np.uint8),
        caption_off=np.cumsum([0] + [len(c) for c in caps]).astype(np.int64),
        kind=np.asarray(kinds, dtype=np.uint8),
    )


class RasterSet:
    """Streams shards so the full set never has to sit in memory.

    Shard order is shuffled per epoch and images are shuffled inside a window
    of `pool` shards.
    """

    def __init__(self, root: Path, split: str = "train", pool: int = 3):
        self.root = Path(root)
        self.meta = _meta(self.root)
        self.kinds = self.meta["kinds"]
        self.res = int(self.meta["resolution"])
        self.color = self.meta.get("palette") is not None
        self.files = sorted(self.root.glob(f"{split}-*.npz"))
        if not self.files:
            raise FileNotFoundError(f"no {split} shards in {self.root}")
        counts = self.meta["shards"][split]
        self.counts = [int(counts[f.name]) for f in self.files]
        self.n = sum(self.counts)
        self.pool = pool

    def __len__(self) -> int:
        return self.n

    def steps_per_epoch(self, batch_size: int) -> int:
        return (self.n + batch_size - 1) // batch_size

    def _groups(self, epoch: int, seed: int, shuffle: bool):
        order = np.arange(len(self.files))
        if shuffle:
            order = np.random.default_rng([seed, epoch, 7]).permutation(len(self.files))
        return [order[i: i + self.pool] for i in range(0, len(order), self.pool)]

    def _load(self, group, epoch: int, seed: int, gi: int, shuffle: bool):
        bits, caps, kinds = [], [], []
        for i in group:
            z = np.load(self.files[int(i)])
            off = z["caption_off"]
            raw = z["caption"].tobytes().decode("ascii")
            bits.append(z["idx4"] if self.color else z["bits"])
            caps.extend(raw[off[k]: off[k + 1]] for k in range(len(off) - 1))
            kinds.append(z["kind"])
        bits, kinds = np.concatenate(bits), np.concatenate(kinds)
        if shuffle:
            order = np.random.default_rng([seed, epoch, gi, 11]).permutation(len(kinds))
            bits, kinds, caps = bits[order], kinds[order], [caps[int(i)] for i in order]
        return bits, caps, kinds

    def batches(self, epoch: int, batch_size: int, seed: int, skip: int = 0, shuffle: bool = True):
        """Yields {'image', 'caption': [str], 'kind'}.

        image is float [B,1,H,W] in {0,1} (ink = 1) for black-and-white data
        and long [B,H,W] of palette indices for colour data.

        Shard groups are chained: what is left over after the last full batch
        of a group opens the next one, so an epoch is always ceil(n / batch)
        batches. `skip` resumes mid-epoch without reading the skipped groups.
        """
        groups = self._groups(epoch, seed, shuffle)
        plan, carry = [], 0
        for gi, g in enumerate(groups):
            avail = carry + sum(self.counts[int(i)] for i in g)
            last = gi == len(groups) - 1
            nb = (avail + batch_size - 1) // batch_size if last else avail // batch_size
            plan.append((nb, carry))
            carry = 0 if last else avail - nb * batch_size
        done = 0
        pending = None
        for gi, g in enumerate(groups):
            nb, carry_in = plan[gi]
            if done + nb <= skip:
                nxt = plan[gi + 1] if gi + 1 < len(groups) else (0, 0)
                if nxt[1] > 0 and done + nb + nxt[0] > skip:     # its tail opens the resume group
                    bits, caps, kinds = self._load(g, epoch, seed, gi, shuffle)
                    k = nxt[1]
                    pending = (bits[-k:], caps[-k:], kinds[-k:])
                done += nb
                continue
            bits, caps, kinds = self._load(g, epoch, seed, gi, shuffle)
            if pending is not None:
                bits = np.concatenate([pending[0], bits])
                caps = pending[1] + caps
                kinds = np.concatenate([pending[2], kinds])
            for b in range(nb):
                if done >= skip:
                    sl = slice(b * batch_size, (b + 1) * batch_size)
                    if self.color:
                        image = torch.from_numpy(bitmap.unpack4(bits[sl]).astype(np.int64))
                    else:
                        image = torch.from_numpy(bitmap.unpack(bits[sl], self.res)).unsqueeze(1).float()
                    yield {"image": image, "caption": caps[sl], "kind": torch.from_numpy(kinds[sl].astype(np.int64))}
                done += 1
            used = nb * batch_size
            pending = (bits[used:], caps[used:], kinds[used:]) if used < len(kinds) else None
