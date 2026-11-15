"""Training task for INKOS 1 Pro."""
from __future__ import annotations

from pathlib import Path

import torch

from .. import bitmap, palette, paths
from ..config import Config
from ..data import store
from .tasks import _to_device


class ProTask:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        root = paths.data_dir(cfg.id)
        self.train = store.RasterSet(root, "train")
        self.val = store.RasterSet(root, "val", pool=1)
        self.bs = int(cfg.train.batch_size)
        self.seed = int(cfg.train.seed)
        self.color = int(cfg.model.get("colors", 1)) > 1
        if self.train.color != self.color:
            raise SystemExit(f"data in {root} is {'colour' if self.train.color else 'black-and-white'} but {cfg.name} "
                             f"is not. Delete that folder and run:  python -m inkos data prepare --model {cfg.id}")
        t = cfg.train
        self.kw = dict(caption_dropout=float(t.caption_dropout), self_cond_prob=float(t.self_cond_prob),
                       refiner_crop=int(t.refiner_crop), refiner_crops=int(t.refiner_crops))

    @property
    def dataset_size(self) -> int:
        return len(self.train)

    @property
    def steps_per_epoch(self) -> int:
        return self.train.steps_per_epoch(self.bs)

    def build_model(self):
        from ..models.inkos1_pro import Inkos1Pro, ProConfig
        return Inkos1Pro(ProConfig.from_dict(self.cfg.model))

    def train_batches(self, epoch: int, skip: int):
        return self.train.batches(epoch, self.bs, self.seed, skip)

    to_device = staticmethod(_to_device)

    @staticmethod
    def batch_len(batch) -> int:
        return batch["image"].shape[0]

    def loss(self, model, batch):
        return model.loss(batch, **self.kw)

    @torch.no_grad()
    def validate(self, model, device, max_batches: int) -> dict:
        """Same noise for every call, so numbers from different checkpoints are comparable."""
        model.eval()
        g = torch.Generator().manual_seed(1234)
        tot, n = {}, 0
        for i, batch in enumerate(self.val.batches(0, self.bs, self.seed, shuffle=False)):
            if i >= max_batches:
                break
            loss, m = model.loss(_to_device(batch, device), generator=g, **{**self.kw, "caption_dropout": 0.0})
            m["loss"] = loss.item()
            for k, v in m.items():
                tot[k] = tot.get(k, 0.0) + v
            n += 1
        return {k: v / max(1, n) for k, v in tot.items()}

    @torch.no_grad()
    def preview(self, model, device, out_dir: Path) -> list[str]:
        model.eval()
        out_dir.mkdir(parents=True, exist_ok=True)
        prompts = list(self.cfg.preview_prompts)
        s = self.cfg.sample
        g = torch.Generator().manual_seed(4321)
        ink = model.sample(prompts, steps=int(s.get("preview_steps", 16)), guidance=float(s.guidance), generator=g)
        files, images = [], []
        for i in range(len(prompts)):
            img = palette.idx_to_image(ink[i].cpu().numpy()) if self.color else bitmap.ink_to_image(ink[i, 0].cpu().numpy())
            f = out_dir / f"{i:02d}.png"
            bitmap.save_png(img, f)
            files.append(str(f.relative_to(paths.ROOT)))
            images.append(img)
        bitmap.save_png(bitmap.contact_sheet(images, 4, 256), out_dir / "sheet.png")
        return files
