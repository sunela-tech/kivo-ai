"""Write a contact sheet of prepared training samples, to eyeball a dataset."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from .. import bitmap, paths
from ..config import Config
from . import store


def contact_sheet(cfg: Config, n: int = 48, out: str | None = None, split: str = "train") -> Path:
    root = paths.data_dir(cfg.id)
    rng = np.random.default_rng(0)
    images = []
    if cfg.architecture == "inkscript-transformer":
        from ..vector import lang
        from ..vector.render import render
        ds = store.VectorSet(root, split)
        for i in rng.choice(len(ds), min(n, len(ds)), replace=False):
            prompt, toks, _ = ds.get(int(i))
            ops, _ = lang.decode(list(toks) + [lang.EOS], len(prompt))
            images.append(render(ops, prompt, 256, seed=int(i)))
        cell = 256
    else:
        ds = store.RasterSet(root, split, pool=1)
        batch = next(ds.batches(0, min(n, 64), 0))
        images = [bitmap.ink_to_image(im[0].numpy() > 0.5) for im in batch["image"]]
        cell = 256
    path = Path(out) if out else paths.run_dir(cfg.id) / f"dataset-{split}.png"
    return bitmap.save_png(bitmap.contact_sheet(images, 8, cell), path)
