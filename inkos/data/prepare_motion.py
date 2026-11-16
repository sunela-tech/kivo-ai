"""Build the INKOS MOTION 1 Pro training set: procedural colour manga clips.

  python -m inkos data prepare --model inkos_motion1_pro

Each clip is FRAMES frames at the base resolution in the six-colour palette
(inkos/data/manga_motion.py). Deterministic for a given config seed.
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
from . import manga_motion, store


def _shard(job) -> dict:
    path, seed, n, res, max_prompt = job
    rng = np.random.default_rng(seed)
    clips, caps, kinds, counts = [], [], [], {}
    while len(clips) < n:
        clip, cap, kind = manga_motion.sample(rng, res)
        ink = float((clip != palette.WHITE).mean())
        if ink < 0.004 or ink > 0.985:
            continue
        clips.append(clip)
        caps.append(normalize_prompt(cap, max_prompt))
        kinds.append(manga_motion.KINDS.index(kind))
        counts[kind] = counts.get(kind, 0) + 1
    store.write_clip_shard(Path(path), clips, caps, kinds)
    return {"file": Path(path).name, "n": n, "counts": counts}


def prepare_motion(cfg: Config, count: int | None = None, workers: int | None = None, log=print, **_) -> dict:
    t0 = time.time()
    out = paths.data_dir(cfg.id)
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.npz"):
        f.unlink()
    res, frames = int(cfg.model.base_resolution), int(cfg.model.frames)
    if frames != manga_motion.FRAMES:
        raise SystemExit(f"the clip generator makes {manga_motion.FRAMES} frames; configs/{cfg.id}.yaml asks for {frames}")
    n_train = int(count or cfg.data.count)
    n_val = int(min(cfg.data.val_count, max(32, n_train // 20)))
    size = int(cfg.data.shard_size)
    jobs = []
    for split, n in (("train", n_train), ("val", n_val)):
        for i, s in enumerate(range(0, n, size)):
            jobs.append((str(out / f"{split}-{i:05d}.npz"), [int(cfg.data.seed), 0 if split == "train" else 1, i],
                         min(size, n - s), res, int(cfg.model.max_prompt)))
    workers = workers or max(1, min(mp.cpu_count(), 8))
    log(f"drawing {n_train} training and {n_val} validation clips ({frames} frames at {res} px) with {workers} workers ...")
    meta = {"format": "clip-idx4-v1", "palette": palette.ID, "model": cfg.id, "kinds": manga_motion.KINDS,
            "resolution": res, "frames": frames, "fps": manga_motion.FPS,
            "shards": {"train": {}, "val": {}}, "by_kind": {"train": {}, "val": {}}}
    done = 0
    with mp.Pool(workers) as pool:
        for i, r in enumerate(pool.imap_unordered(_shard, jobs)):
            split = "val" if r["file"].startswith("val") else "train"
            meta["shards"][split][r["file"]] = r["n"]
            for k, v in r["counts"].items():
                meta["by_kind"][split][k] = meta["by_kind"][split].get(k, 0) + v
            done += r["n"]
            log(f"  [{i + 1}/{len(jobs)}] {done} clips")
    meta.update(train_count=sum(meta["shards"]["train"].values()), val_count=sum(meta["shards"]["val"].values()),
                sources=[{"name": "INKOS procedural manga generator, animated (camera moves, expressions, "
                                  "movement, weather)", "license": "this repository"}],
                seed=int(cfg.data.seed), created=time.strftime("%Y-%m-%dT%H:%M:%S"), seconds=round(time.time() - t0, 1))
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    log(f"done: {meta['train_count']} train / {meta['val_count']} val in {meta['seconds']} s  ->  {out}")
    return meta
