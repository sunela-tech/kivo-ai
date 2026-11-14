"""Where things live on disk. Override the root with INKOS_HOME."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("INKOS_HOME") or Path(__file__).resolve().parent.parent)

CONFIGS = ROOT / "configs"
DATA = ROOT / "data"          # prepared training data (generated locally, not in git)
RUNS = ROOT / "runs"          # training runs: checkpoints, metrics, state
MODELS = ROOT / "models"      # exported, installed inference weights
PROJECTS = ROOT / "projects"  # generated images, grouped by project
WEB = ROOT / "web"            # the HTML interface


def run_dir(model_id: str) -> Path:
    return RUNS / model_id


def model_dir(model_id: str) -> Path:
    return MODELS / model_id


def data_dir(model_id: str) -> Path:
    return DATA / model_id
