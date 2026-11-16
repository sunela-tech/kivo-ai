"""Training task for INKOS MOTION 1 Pro (video diffusion over palette clips)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from .. import bitmap, palette, paths
from ..config import Config
from ..data import store
from .tasks import _to_device


class MotionProTask:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        root = paths.data_dir(cfg.id)
        self.train = store.ClipSet(root, "train")
        self.val = store.ClipSet(root, "val", pool=1)
        self.bs = int(cfg.train.batch_size)
        self.seed = int(cfg.train.seed)
        if int(self.train.meta.get("frames", 0)) != int(cfg.model.frames) or \
                int(self.train.meta.get("resolution", 0)) != int(cfg.model.base_resolution):
            raise SystemExit(f"data in {root} has a different clip shape. Run:  python -m inkos data prepare --model {cfg.id}")
        t = cfg.train
        self.kw = dict(caption_dropout=float(t.caption_dropout), self_cond_prob=float(t.self_cond_prob))

    @property
    def dataset_size(self) -> int:
        return len(self.train)

    @property
    def steps_per_epoch(self) -> int:
        return self.train.steps_per_epoch(self.bs)

    def build_model(self):
        from ..models.inkos_motion_pro import InkosMotionPro, MotionProConfig
        return InkosMotionPro(MotionProConfig.from_dict(self.cfg.model))

    def train_batches(self, epoch: int, skip: int):
        return self.train.batches(epoch, self.bs, self.seed, skip)

    to_device = staticmethod(_to_device)

    @staticmethod
    def batch_len(batch) -> int:
        return batch["clip"].shape[0]

    def loss(self, model, batch):
        return model.loss(batch, **self.kw)

    @torch.no_grad()
    def validate(self, model, device, max_batches: int) -> dict:
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
        """Every preview prompt as a GIF, plus a sheet of their frames 0, 4, 8 and 11."""
        from ..vector.motion import gif_bytes
        model.eval()
        out_dir.mkdir(parents=True, exist_ok=True)
        prompts = list(self.cfg.preview_prompts)[:4]
        s = self.cfg.sample
        clips = model.sample(prompts, steps=int(s.get("preview_steps", 12)), guidance=float(s.guidance),
                             generator=torch.Generator().manual_seed(4321)).cpu().numpy()
        files, images = [], []
        for i, clip in enumerate(clips):
            f = out_dir / f"{i:02d}.gif"
            f.write_bytes(gif_bytes(list(clip.astype(np.uint8)), fps=int(self.cfg.motion.fps)))
            files.append(str(f.relative_to(paths.ROOT)))
            images += [palette.idx_to_image(clip[k].astype(np.uint8)) for k in (0, 4, 8, len(clip) - 1)]
        bitmap.save_png(bitmap.contact_sheet(images, 4, 128), out_dir / "sheet.png")
        return files
