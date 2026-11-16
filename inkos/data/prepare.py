"""Build the training sets.

  python -m inkos data prepare --model inkos1
  python -m inkos data prepare --model inkos1_pro

INKOS 1 is trained on drawing programs: procedural notes / charts / diagrams /
symbols, open-licensed stroke icons, and Quick, Draw! sketches. INKOS 1.1 uses
the same material with colour schemes applied (inkos/data/colorize.py).
INKOS 1 Pro is trained on 1-bit raster images: the procedural manga set plus
any folders of your own licensed artwork imported with `data import`.

Everything is deterministic for a given config seed.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import time
from pathlib import Path

import numpy as np

from .. import paths
from ..config import Config
from ..vector import lang
from . import animate, colorize, quickdraw, store, svg_icons, synth_charts, synth_diagrams, synth_notes, synth_symbols

SOURCES = paths.DATA / "sources"
FAMILIES = {
    "notes": synth_notes.GENERATORS,
    "charts": synth_charts.GENERATORS,
    "diagrams": synth_diagrams.GENERATORS,
    "symbols": synth_symbols.GENERATORS,
}
V_KINDS = [k for fam in FAMILIES.values() for k in fam] + ["icon", "sketch"]

_W: dict = {}   # per-worker state


# --------------------------------------------------------------------------
# INKOS 1
# --------------------------------------------------------------------------

def _v_init(max_prompt: int, max_tokens: int, icon_dir: str | None, sketch_dir: str | None, color: bool,
            motion: bool = False):
    _W["max_prompt"], _W["max_tokens"], _W["color"], _W["motion"] = max_prompt, max_tokens, color or motion, motion
    _W["vocab"] = lang.VOCAB_MOTION if motion else lang.VOCAB_COLOR if color else lang.VOCAB
    _W["icons"] = svg_icons.load_sets(Path(icon_dir)) if icon_dir else []
    _W["sketches"] = quickdraw.load(Path(sketch_dir)) if sketch_dir else []


def _synth(family: str, rng):
    """-> (Doc, kind name) from one of the procedural families."""
    gens = FAMILIES[family]
    names = list(gens)
    w = np.array([gens[n][1] for n in names], dtype=float)
    w /= w.sum()
    while True:
        name = names[int(rng.choice(len(names), p=w))]
        d = gens[name][0](rng)
        if d is None or not d.prompt or len(d.prompt) > _W["max_prompt"]:
            continue
        if len(lang.encode(d.ops)) + 1 > _W["max_tokens"]:
            continue
        return d, name


def _v_shard(job) -> dict:
    path, seed, plan = job
    rng = np.random.default_rng(seed)
    out, counts = [], {}
    for family, ref, flag in plan:
        d, kind = None, family
        if family == "icon":
            _, cap, svg = _W["icons"][ref]
            d = svg_icons.make_sample(rng, cap, svg, bool(flag), _W["max_tokens"] - 1)
        elif family == "sketch":
            cat, line = _W["sketches"][ref]
            d = quickdraw.make_sample(rng, cat, line, _W["max_tokens"] - 1)
        if family in FAMILIES or d is None or len(d.prompt) > _W["max_prompt"]:
            fam = family if family in FAMILIES else "symbols"   # unusable icon/sketch -> a symbol instead
            d, kind = _synth(fam, rng)
        if _W["color"]:
            plain = (d.prompt, list(d.ops))
            colorize.colorize(d, rng, _W["max_prompt"])
            if len(lang.encode(d.ops, _W["vocab"])) + 1 > _W["max_tokens"]:
                d.prompt, d.ops = plain                         # the coloured version is too long
        if _W["motion"]:
            animate.animate(d, kind, rng, _W["max_prompt"], _W["max_tokens"])
        toks = lang.encode(d.ops, _W["vocab"])
        k = V_KINDS.index(kind)
        out.append((d.prompt, toks, k))
        counts[kind] = counts.get(kind, 0) + 1
    store.write_vector_shard(Path(path), out)
    return {"file": Path(path).name, "n": len(out), "counts": counts}


def fetch_sources(cfg: Config, log=print, download: bool = True) -> dict:
    """Make sure icon sets and sketches are on disk. Returns what is available."""
    icon_dir, sketch_dir = SOURCES / "icons", SOURCES / "quickdraw"
    mix = cfg.data.mix
    n_sketch = int(cfg.data.count * mix.get("sketches", 0)) + int(cfg.data.val_count * mix.get("sketches", 0))
    per_class = int(np.ceil(n_sketch / len(quickdraw.CATEGORIES))) + 2 if n_sketch else 0
    if download:
        if mix.get("icons", 0) > 0:
            log("icon sets (MIT / ISC licensed, from the npm registry):")
            try:
                svg_icons.fetch(icon_dir, log=log)
            except OSError as e:
                log(f"  could not download icon sets: {e}")
        if per_class:
            log(f"Quick, Draw! sketches (CC BY 4.0), {per_class} per category:")
            try:
                quickdraw.fetch(sketch_dir, per_class, log=log)
            except OSError as e:
                log(f"  could not download sketches: {e}")
    have_icons = any(icon_dir.glob("*/*.svg"))
    have_sketches = any(sketch_dir.glob("*.ndjson"))
    return {"icons": str(icon_dir) if have_icons else None, "sketches": str(sketch_dir) if have_sketches else None}


def prepare_inkos1(cfg: Config, count: int | None = None, workers: int | None = None,
                   download: bool = True, log=print) -> dict:
    t0 = time.time()
    out = paths.data_dir(cfg.id)
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.npz"):
        f.unlink()
    n_train = int(count or cfg.data.count)
    n_val = int(min(cfg.data.val_count, max(200, n_train // 20)))
    src = fetch_sources(cfg, log, download)

    mix = dict(cfg.data.mix)
    if not src["icons"] and mix.get("icons"):
        log("! no icon sets available: their share goes to procedural symbols")
        mix["symbols"] = mix.get("symbols", 0) + mix.pop("icons")
    if not src["sketches"] and mix.get("sketches"):
        log("! no sketches available: their share goes to symbols and diagrams")
        s = mix.pop("sketches")
        mix["symbols"] = mix.get("symbols", 0) + s / 2
        mix["diagrams"] = mix.get("diagrams", 0) + s / 2
    total = sum(mix.values())
    mix = {k: v / total for k, v in mix.items() if v > 0}

    n_icons = len(svg_icons.load_sets(Path(src["icons"]))) if src["icons"] else 0
    n_sk = len(quickdraw.load(Path(src["sketches"]))) if src["sketches"] else 0
    rng = np.random.default_rng(cfg.data.seed)

    def plan_for(n: int, offset: int) -> list:
        """A shuffled list of (family, source index, flag)."""
        plan = []
        for fam, share in mix.items():
            k = int(round(n * share))
            if fam == "icons":
                # every icon once in its canonical pose, then random poses
                refs = [(i % n_icons, 1 if i < n_icons and offset == 0 else 0) for i in range(k)]
                plan += [("icon", r, c) for r, c in refs]
            elif fam == "sketches":
                # train and validation read different sketches
                idx = (np.arange(k) + offset) % max(1, n_sk)
                plan += [("sketch", int(i), 0) for i in idx]
            else:
                plan += [(fam, 0, 0)] * k
        order = rng.permutation(len(plan))
        return [plan[i] for i in order]

    # sketches are stored category by category; spread picks over all categories
    if n_sk:
        perm = np.random.default_rng(cfg.data.seed + 5).permutation(n_sk)
    jobs = []
    for split, n, off in (("train", n_train, 0), ("val", n_val, int(n_train * mix.get("sketches", 0)) + 1)):
        plan = plan_for(n, off)
        if n_sk:
            plan = [(f, int(perm[r]) if f == "sketch" else r, c) for f, r, c in plan]
        size = int(cfg.data.shard_size)
        for s in range(0, len(plan), size):
            jobs.append((str(out / f"{split}-{s // size:05d}.npz"),
                         [cfg.data.seed, 0 if split == "train" else 1, s // size], plan[s: s + size]))

    workers = workers or max(1, min(mp.cpu_count(), 8))
    log(f"generating {n_train} training and {n_val} validation drawings with {workers} workers ...")
    stats: dict[str, dict] = {"train": {}, "val": {}}
    sizes = {"train": 0, "val": 0}
    motion = bool(cfg.model.get("motion"))
    color = bool(cfg.model.get("color")) or motion
    init = (cfg.model.max_prompt, cfg.model.max_program, src["icons"], src["sketches"], color, motion)
    with mp.Pool(workers, initializer=_v_init, initargs=init) as pool:
        for i, res in enumerate(pool.imap_unordered(_v_shard, jobs)):
            split = res["file"].split("-")[0]
            sizes[split] += res["n"]
            for k, v in res["counts"].items():
                stats[split][k] = stats[split].get(k, 0) + v
            log(f"  [{i + 1}/{len(jobs)}] {res['file']}  ({sizes['train'] + sizes['val']} drawings)")

    sources = [{"name": "INKOS procedural generators (notes, charts, diagrams, symbols)", "license": "this repository"}]
    if src["icons"]:
        for s in sorted(Path(src["icons"]).glob("*/SOURCE.json")):
            j = json.loads(s.read_text())
            sources.append({"name": f"{j['package']} {j.get('version')}", "license": j["license"], "items": j["icons"]})
    if src["sketches"]:
        sources.append({"name": "Quick, Draw! Dataset (Google Creative Lab)", "license": "CC BY 4.0",
                        "url": "https://github.com/googlecreativelab/quickdraw-dataset"})
    meta = {
        "format": "inkscript-v1", "model": cfg.id, "kinds": V_KINDS, "grid": lang.GRID,
        "vocab": lang.VOCAB_MOTION if motion else lang.VOCAB_COLOR if color else lang.VOCAB,
        "palette": "eink6" if color else None, "motion": motion,
        "train_count": sizes["train"], "val_count": sizes["val"], "by_kind": stats,
        "distinct_icons": n_icons, "distinct_sketches": n_sk, "seed": cfg.data.seed,
        "sources": sources, "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "seconds": round(time.time() - t0, 1),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    log(f"done: {sizes['train']} train / {sizes['val']} val in {meta['seconds']} s  ->  {out}")
    return meta


def prepare(cfg: Config, **kw) -> dict:
    if cfg.architecture == "inkscript-transformer":
        return prepare_inkos1(cfg, **kw)
    if cfg.architecture == "video-diffusion-unet":
        from .prepare_motion import prepare_motion
        return prepare_motion(cfg, **kw)
    from .prepare_raster import prepare_pro
    return prepare_pro(cfg, **kw)
