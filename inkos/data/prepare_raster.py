"""Build the INKOS 1 Pro / INKOS 1.1 Pro training set: procedural manga images
at 512 x 512, black-and-white with screentone or in the six-colour palette.

Shards written here are named train-synth-*.npz / val-*.npz. Artwork you
import yourself (data import) lives in train-import-*.npz and is left alone
when the synthetic part is rebuilt.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import time
from pathlib import Path

import numpy as np

from .. import palette, paths
from ..config import Config
from ..prompts import normalize_prompt
from . import manga_scenes, store

PROCEDURAL_SOURCE = {"name": "INKOS procedural manga generator (characters, backgrounds, pages, props)",
                     "license": "this repository"}


def _shard(job) -> dict:
    path, seed, n, res, max_prompt, color = job
    rng = np.random.default_rng(seed)
    images, caps, kinds, counts = [], [], [], {}
    while len(images) < n:
        bits, cap, kind = manga_scenes.sample(rng, res, color)
        ratio = float((bits != palette.WHITE).mean()) if color else float(bits.mean())
        if ratio < 0.004 or ratio > 0.97:
            continue
        images.append(bits)
        caps.append(normalize_prompt(cap, max_prompt))
        kinds.append(manga_scenes.KINDS.index(kind))
        counts[kind] = counts.get(kind, 0) + 1
    store.write_raster_shard(Path(path), images, caps, kinds)
    return {"file": Path(path).name, "n": n, "counts": counts}


def read_meta(out: Path, cfg: Config) -> dict:
    f = out / "meta.json"
    if f.exists():
        return json.loads(f.read_text())
    color = int(cfg.model.get("colors", 1)) > 1
    return {"format": "idx4-v1" if color else "bits-v1", "palette": palette.ID if color else None, "model": cfg.id,
            "kinds": manga_scenes.KINDS, "resolution": int(cfg.data.resolution),
            "shards": {"train": {}, "val": {}}, "by_kind": {"train": {}, "val": {}}, "sources": [], "train_count": 0,
            "val_count": 0}


def write_meta(out: Path, meta: dict):
    meta["train_count"] = sum(meta["shards"]["train"].values())
    meta["val_count"] = sum(meta["shards"]["val"].values())
    (out / "meta.json").write_text(json.dumps(meta, indent=2))


def prepare_pro(cfg: Config, count: int | None = None, workers: int | None = None,
                download: bool = True, log=print) -> dict:
    t0 = time.time()
    out = paths.data_dir(cfg.id)
    out.mkdir(parents=True, exist_ok=True)
    meta = read_meta(out, cfg)
    res = int(cfg.data.resolution)
    color = int(cfg.model.get("colors", 1)) > 1
    if meta["resolution"] != res or (meta.get("palette") is not None) != color:
        raise SystemExit(f"existing data in {out} has a different resolution or colour mode; delete that folder first")
    for f in list(out.glob("train-synth-*.npz")) + list(out.glob("val-*.npz")):
        f.unlink()
    meta["shards"]["train"] = {k: v for k, v in meta["shards"]["train"].items() if k.startswith("train-import-")}
    meta["shards"]["val"] = {}
    kept = {k: v for k, v in meta["by_kind"]["train"].items() if k == "import"}
    meta["by_kind"] = {"train": kept, "val": {}}

    n_train = int(count or cfg.data.count)
    n_val = int(min(cfg.data.val_count, max(64, n_train // 20)))
    size = int(cfg.data.shard_size)
    jobs = []
    for split, n, prefix in (("train", n_train, "train-synth"), ("val", n_val, "val")):
        for i, s in enumerate(range(0, n, size)):
            jobs.append((str(out / f"{prefix}-{i:05d}.npz"), [int(cfg.data.seed), 0 if split == "train" else 1, i],
                         min(size, n - s), res, int(cfg.model.max_prompt), color))
    workers = workers or max(1, min(mp.cpu_count(), 8))
    log(f"drawing {n_train} training and {n_val} validation images at {res} px with {workers} workers ...")
    done = 0
    with mp.Pool(workers) as pool:
        for i, r in enumerate(pool.imap_unordered(_shard, jobs)):
            split = "val" if r["file"].startswith("val") else "train"
            meta["shards"][split][r["file"]] = r["n"]
            for k, v in r["counts"].items():
                meta["by_kind"][split][k] = meta["by_kind"][split].get(k, 0) + v
            done += r["n"]
            if (i + 1) % 5 == 0 or i + 1 == len(jobs):
                log(f"  [{i + 1}/{len(jobs)}] {done} images")
    meta["sources"] = [PROCEDURAL_SOURCE] + [s for s in meta["sources"] if s.get("imported")]
    meta["seed"] = int(cfg.data.seed)
    meta["created"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_meta(out, meta)
    log(f"done: {meta['train_count']} train / {meta['val_count']} val in {time.time() - t0:.0f} s  ->  {out}")
    return meta
