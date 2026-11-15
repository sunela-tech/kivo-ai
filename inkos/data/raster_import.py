"""Add your own licensed artwork to the INKOS 1 Pro training set.

  python -m inkos data import --model inkos1_pro --dir ~/my_manga \
      --license "own work" --source "my sketchbook scans"

Each image is fitted onto a white square, reduced to pure black/white (or,
for INKOS 1.1 Pro, to the six palette colours) and stored next to the
procedural data. A caption is read from a .txt file with
the same name; otherwise --caption or the folder and file name are used.

A license statement is mandatory and is recorded in the dataset metadata.
Only import material you made or are licensed to train on.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

import numpy as np
from PIL import Image

from .. import bitmap, palette, paths
from ..config import Config
from ..prompts import normalize_prompt
from . import manga_scenes, store
from .prepare_raster import read_meta, write_meta

EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


def quantize(img: Image.Image, size: int) -> np.ndarray:
    """Fit an image onto a white square and snap every pixel to the nearest palette colour."""
    img = img.convert("RGBA")
    img = Image.alpha_composite(Image.new("RGBA", img.size, (255, 255, 255, 255)), img).convert("RGB")
    s = size / max(img.size)
    nw, nh = max(1, round(img.width * s)), max(1, round(img.height * s))
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(img.resize((nw, nh), Image.LANCZOS), ((size - nw) // 2, (size - nh) // 2))
    return palette.image_to_idx(canvas)


def import_folder(cfg: Config, folder: str | None, license: str | None, source: str | None = None,
                  caption: str | None = None, log=print) -> dict:
    if cfg.architecture != "bit-diffusion-unet":
        raise SystemExit("image import is for INKOS 1 Pro (inkos1_pro). INKOS 1 is trained on drawing programs.")
    if not folder or not Path(folder).is_dir():
        raise SystemExit("--dir must be a folder of images")
    if not license or not license.strip():
        raise SystemExit('--license is required, e.g. --license "own work" or --license "CC BY 4.0". '
                         "Only import artwork you are allowed to train on.")
    root = Path(folder)
    out = paths.data_dir(cfg.id)
    out.mkdir(parents=True, exist_ok=True)
    meta = read_meta(out, cfg)
    res = int(meta["resolution"])
    color = meta.get("palette") is not None
    slug = re.sub(r"[^a-z0-9]+", "-", root.name.lower()).strip("-") or "set"
    for f in out.glob(f"train-import-{slug}-*.npz"):          # re-importing a folder replaces it
        meta["shards"]["train"].pop(f.name, None)
        f.unlink()
    files = sorted(p for p in root.rglob("*") if p.suffix.lower() in EXTENSIONS)
    kind = manga_scenes.KINDS.index("import")
    size = int(cfg.data.shard_size)
    images, caps, n_ok, n_skip, shard = [], [], 0, 0, 0

    def flush():
        nonlocal images, caps, shard
        if images:
            name = f"train-import-{slug}-{shard:05d}.npz"
            store.write_raster_shard(out / name, images, caps, [kind] * len(images))
            meta["shards"]["train"][name] = len(images)
            shard += 1
        images, caps = [], []

    for f in files:
        try:
            with Image.open(f) as im:
                im.seek(0)
                if color:
                    bits = quantize(im, res)
                else:
                    bits = bitmap.binarize(im, res, cfg.data.get("binarize", "otsu"))
        except Exception as e:
            log(f"  skipped {f.name}: {e}")
            n_skip += 1
            continue
        ratio = float((bits != palette.WHITE).mean()) if color else float(bits.mean())
        if ratio < 0.002 or ratio > 0.98:
            n_skip += 1
            continue
        txt = f.with_suffix(".txt")
        cap = txt.read_text(errors="replace") if txt.exists() else (caption or f"{root.name}, {f.stem}".replace("_", " ").replace("-", " "))
        images.append(bits)
        caps.append(normalize_prompt(cap, int(cfg.model.max_prompt)))
        n_ok += 1
        if len(images) >= size:
            flush()
    flush()
    meta["by_kind"]["train"]["import"] = sum(v for k, v in meta["shards"]["train"].items() if k.startswith("train-import-"))
    meta["sources"] = [s for s in meta["sources"] if s.get("slug") != slug]
    if n_ok:
        meta["sources"].append({"name": source or root.name, "license": license.strip(), "items": n_ok, "imported": True,
                                "slug": slug, "added": time.strftime("%Y-%m-%d")})
    write_meta(out, meta)
    log(f"imported {n_ok} images from {root} ({n_skip} skipped), license: {license.strip()}")
    log(f"training set is now {meta['train_count']} images")
    if not meta["shards"]["val"]:
        log("note: there is no validation split yet; run  python -m inkos data prepare --model inkos1_pro")
    return meta
