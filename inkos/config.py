"""Model configurations.

Each model is described by one YAML file in configs/. The two shipped files
are configs/inkos1.yaml and configs/inkos1_pro.yaml; they share nothing, so
either model can be reconfigured and retrained without touching the other.
"""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

import yaml

from . import paths


class Config(dict):
    """dict with attribute access, nested."""

    def __getattr__(self, k: str) -> Any:
        try:
            v = self[k]
        except KeyError as e:
            raise AttributeError(k) from e
        return v

    def __setattr__(self, k: str, v: Any) -> None:
        self[k] = v

    @staticmethod
    def wrap(obj):
        if isinstance(obj, dict):
            return Config({k: Config.wrap(v) for k, v in obj.items()})
        if isinstance(obj, list):
            return [Config.wrap(v) for v in obj]
        return obj

    def plain(self) -> dict:
        return json.loads(json.dumps(self))


def model_ids() -> list[str]:
    order = {"inkos1": 0, "inkos1_pro": 1, "inkos1_1": 2, "inkos1_1_pro": 3}
    ids = [p.stem for p in paths.CONFIGS.glob("*.yaml") if p.stem != "plans"]
    return sorted(ids, key=lambda i: (order.get(i, 9), i))


def load_config(model_id: str, overrides: list[str] | None = None) -> Config:
    path = paths.CONFIGS / f"{model_id}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"unknown model '{model_id}' (no {path})")
    cfg = Config.wrap(yaml.safe_load(path.read_text()))
    if cfg.get("id") != model_id:
        raise ValueError(f"{path}: id must be '{model_id}'")
    for item in overrides or []:
        key, _, raw = item.partition("=")
        node = cfg
        parts = key.strip().split(".")
        for p in parts[:-1]:
            node = node[p]
        node[parts[-1]] = Config.wrap(yaml.safe_load(raw))
    return cfg


def model_fingerprint(cfg: Config) -> str:
    """Hash of everything that fixes the weight shapes. Checkpoints carry it."""
    blob = json.dumps({"arch": cfg.architecture, "model": cfg.model}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def clone(cfg: Config) -> Config:
    return Config.wrap(copy.deepcopy(cfg.plain()))
