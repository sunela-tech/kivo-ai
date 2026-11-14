"""What is specific to each model during training: data, loss, validation, previews."""
from __future__ import annotations

from pathlib import Path

import torch

from .. import bitmap, paths
from ..config import Config
from ..data import store


def _to_device(batch: dict, device) -> dict:
    return {k: v.to(device, non_blocking=True) if torch.is_tensor(v) else v for k, v in batch.items()}


class Inkos1Task:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        root = paths.data_dir(cfg.id)
        self.train = store.VectorSet(root, "train")
        self.val = store.VectorSet(root, "val")
        self.bs = int(cfg.train.batch_size)
        self.seed = int(cfg.train.seed)

    @property
    def dataset_size(self) -> int:
        return len(self.train)

    @property
    def steps_per_epoch(self) -> int:
        return self.train.steps_per_epoch(self.bs)

    def build_model(self):
        from ..models.inkos1 import Inkos1, Inkos1Config
        return Inkos1(Inkos1Config.from_dict(self.cfg.model))

    def train_batches(self, epoch: int, skip: int):
        return self.train.batches(epoch, self.bs, self.seed, skip)

    to_device = staticmethod(_to_device)

    @staticmethod
    def batch_len(batch) -> int:
        return batch["tokens"].shape[0]

    @staticmethod
    def loss(model, batch):
        return model.loss(batch)

    @torch.no_grad()
    def validate(self, model, device, max_batches: int) -> dict:
        model.eval()
        tot, n = {}, 0
        for i, batch in enumerate(self.val.batches(0, self.bs, self.seed)):
            if i >= max_batches:
                break
            loss, m = model.loss(_to_device(batch, device))
            m["loss"] = loss.item()
            for k, v in m.items():
                tot[k] = tot.get(k, 0.0) + v
            n += 1
        return {k: v / max(1, n) for k, v in tot.items()}

    @torch.no_grad()
    def preview(self, model, device, out_dir: Path) -> list[str]:
        from ..vector.render import render
        model.eval()
        out_dir.mkdir(parents=True, exist_ok=True)
        files, images = [], []
        s = self.cfg.sample
        for i, prompt in enumerate(self.cfg.preview_prompts):
            g = torch.Generator().manual_seed(1000 + i)
            res = model.generate(prompt, float(s.temperature), float(s.top_p), generator=g)
            img = render(res["ops"], prompt, 256, seed=i)
            f = out_dir / f"{i:02d}.png"
            bitmap.save_png(img, f)
            files.append(str(f.relative_to(paths.ROOT)))
            images.append(img)
        bitmap.save_png(bitmap.contact_sheet(images, 4, 256), out_dir / "sheet.png")
        return files


def get_task(cfg: Config):
    if cfg.architecture == "inkscript-transformer":
        return Inkos1Task(cfg)
    if cfg.architecture == "bit-diffusion-unet":
        from .task_pro import ProTask
        return ProTask(cfg)
    raise ValueError(f"unknown architecture {cfg.architecture!r}")
