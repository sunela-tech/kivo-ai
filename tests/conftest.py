"""Shared fixtures: a throw-away INKOS home with tiny versions of all six models."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from inkos import paths  # noqa: E402

TINY = {
    "inkos1": {
        "model": {"d_model": 64, "n_layers": 2, "n_heads": 4, "d_ff": 128},
        "data": {"count": 320, "val_count": 40, "shard_size": 160},
        "train": {"batch_size": 16, "val_batches": 2, "warmup_steps": 2, "val_every_steps": 1000, "log_every": 2,
                  "lr": 2.0e-3},
        "preview_prompts": ["house icon", "note: milk; eggs"],
    },
    "inkos1_pro": {
        "model": {"base_resolution": 64, "channels": [16, 32], "attn_levels": [1], "heads": 2, "text_dim": 32,
                  "text_layers": 1, "text_heads": 2, "refiner_channels": 8, "refiner_blocks": 1},
        "data": {"count": 48, "val_count": 16, "shard_size": 16, "resolution": 128},
        "train": {"batch_size": 8, "val_batches": 1, "warmup_steps": 2, "val_every_steps": 1000, "log_every": 1,
                  "refiner_crop": 32, "lr": 1.0e-3},
        "sample": {"steps": 8, "preview_steps": 2, "guidance": 2.0},           # 8: the smallest the plans allow
        "inference": {"sizes": [64, 128, 256], "default_size": 128},
        "preview_prompts": ["manga portrait, girl"],
    },
}
TINY["inkos1_1"] = {**TINY["inkos1"], "preview_prompts": ["red heart", "blue note: milk; eggs"]}
TINY["inkos1_1_pro"] = {**TINY["inkos1_pro"], "preview_prompts": ["color manga portrait, girl, red hair"]}
TINY["inkos_motion1"] = {**TINY["inkos1"], "preview_prompts": ["spinning yellow sun", "typing blue note: milk; eggs"]}
TINY["inkos_motion1_pro"] = {
    "model": {"base_resolution": 32, "channels": [16, 32], "attn_levels": [1], "heads": 2, "text_dim": 32,
              "text_layers": 1, "text_heads": 2, "refiner_channels": 8, "refiner_blocks": 1},
    "data": {"count": 8, "val_count": 4, "shard_size": 4},
    "train": {"batch_size": 2, "val_batches": 1, "warmup_steps": 2, "val_every_steps": 1000, "log_every": 1, "lr": 1.0e-3},
    "sample": {"steps": 8, "preview_steps": 2, "guidance": 2.0},
    "inference": {"sizes": [64, 128], "default_size": 64},
    "preview_prompts": ["color manga animation, falling snow, color anime scenery"],
}


def _merge(a: dict, b: dict) -> dict:
    for k, v in b.items():
        a[k] = _merge(a.get(k, {}), v) if isinstance(v, dict) else v
    return a


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Point every INKOS directory at tmp_path and install tiny model configs."""
    (tmp_path / "configs").mkdir()
    for mid, patch in TINY.items():
        cfg = yaml.safe_load((REPO / "configs" / f"{mid}.yaml").read_text())
        (tmp_path / "configs" / f"{mid}.yaml").write_text(yaml.safe_dump(_merge(cfg, patch)))
    (tmp_path / "configs" / "plans.yaml").write_text((REPO / "configs" / "plans.yaml").read_text())
    for name, sub in (("ROOT", ""), ("CONFIGS", "configs"), ("DATA", "data"), ("RUNS", "runs"),
                      ("MODELS", "models"), ("PROJECTS", "projects")):
        monkeypatch.setattr(paths, name, tmp_path / sub if sub else tmp_path)
    monkeypatch.setattr(paths, "WEB", REPO / "web")
    from inkos.data import prepare
    monkeypatch.setattr(prepare, "SOURCES", tmp_path / "data" / "sources")
    return tmp_path
