"""Turn a training checkpoint into installed inference weights.

  python -m inkos export --model inkos1

Reads runs/<model>/checkpoints/last.pt, keeps only the averaged (EMA) weights,
and writes models/<model>/weights.pt + manifest.json. The manifest records how
much training those weights actually received; the interface shows it as is.
Nothing in models/ is ever written by training, and nothing in runs/ is
needed for inference.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

import torch

from . import __version__, paths
from .config import Config, model_fingerprint
from .training.trainer import checkpoint_summary

MANIFEST_FORMAT = 1


def latest_checkpoint(model_id: str) -> Path | None:
    p = paths.run_dir(model_id) / "checkpoints" / "last.pt"
    return p if p.exists() else None


def _relative(p: Path) -> str:
    try:
        return str(p.resolve().relative_to(paths.ROOT.resolve()))
    except ValueError:
        return p.name


def export(cfg: Config, checkpoint: str | None = None, half: bool = True) -> dict:
    src = Path(checkpoint) if checkpoint else latest_checkpoint(cfg.id)
    if not src or not src.exists():
        raise SystemExit(f"no checkpoint for {cfg.id}. Train first:  python -m inkos train --model {cfg.id}")
    ck = torch.load(src, map_location="cpu", weights_only=False)
    if ck.get("fingerprint") != model_fingerprint(cfg):
        raise SystemExit(f"{src} does not match configs/{cfg.id}.yaml (different model shape)")
    n_params = sum(v.numel() for v in {v.data_ptr(): v for v in ck["ema"].values()}.values())   # tied weights once
    weights = {k: (v.half() if half and v.is_floating_point() else v) for k, v in ck["ema"].items()}
    out = paths.model_dir(cfg.id)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "weights.pt.tmp"
    torch.save(weights, tmp)
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
    os.replace(tmp, out / "weights.pt")
    manifest = {
        "format": MANIFEST_FORMAT, "model": cfg.id, "name": cfg.name, "architecture": cfg.architecture,
        "fingerprint": ck["fingerprint"], "config": ck["config"],
        "params": int(n_params), "dtype": "float16" if half else "float32",
        "file": "weights.pt", "bytes": (out / "weights.pt").stat().st_size, "sha256": digest,
        "training": checkpoint_summary(ck, target_epochs=int(cfg.target_epochs)),
        "source_checkpoint": _relative(src), "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "inkos_version": __version__, "torch_version": torch.__version__,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return {k: v for k, v in manifest.items() if k != "config"}
