"""Plans: three usage tiers for the INKOS app.

Defined in configs/plans.yaml. A plan limits generation only: which models,
the largest size, images per day and the number of projects. The active plan
is a local setting (settings.json); daily usage is counted in usage.json.
There are no accounts, license keys or payments behind this.
"""
from __future__ import annotations

import json
import os
import threading
import time

import yaml

from . import paths

_lock = threading.Lock()


class PlanError(Exception):
    """A request the active plan does not include."""


def _read_json(name: str) -> dict:
    try:
        return json.loads((paths.ROOT / name).read_text())
    except (OSError, ValueError):
        return {}


def _write_json(name: str, obj: dict):
    f = paths.ROOT / name
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2))
    os.replace(tmp, f)


def load() -> dict:
    """-> {'default': id, 'plans': [plan, ...]} from configs/plans.yaml."""
    raw = yaml.safe_load((paths.CONFIGS / "plans.yaml").read_text())
    plans = raw.get("plans") or []
    ids = [p["id"] for p in plans]
    if not plans or len(set(ids)) != len(ids):
        raise ValueError("configs/plans.yaml needs at least one plan and unique ids")
    if raw.get("default") not in ids:
        raw["default"] = ids[0]
    for p in plans:
        p.setdefault("name", p["id"].title())
        for key in ("tagline", "price", "max_size", "images_per_day", "projects"):
            p.setdefault(key, None)
        p["models"] = list(p.get("models") or [])
    return raw


def current() -> dict:
    """The active plan."""
    cfg = load()
    by_id = {p["id"]: p for p in cfg["plans"]}
    return by_id.get(_read_json("settings.json").get("plan"), by_id[cfg["default"]])


def set_plan(plan_id: str) -> dict:
    cfg = load()
    if plan_id not in {p["id"] for p in cfg["plans"]}:
        raise PlanError(f"unknown plan '{plan_id}'; choose one of {[p['id'] for p in cfg['plans']]}")
    with _lock:
        settings = _read_json("settings.json")
        settings["plan"] = plan_id
        _write_json("settings.json", settings)
    return current()


def images_today() -> int:
    u = _read_json("usage.json")
    return int(u.get("images", 0)) if u.get("date") == time.strftime("%Y-%m-%d") else 0


def record_image() -> int:
    """Count one generated image against today's allowance."""
    with _lock:
        n = images_today() + 1
        _write_json("usage.json", {"date": time.strftime("%Y-%m-%d"), "images": n})
        return n


def check_generate(model_id: str, model_name: str, size: int):
    """Raise PlanError if the active plan does not allow this generation."""
    p = current()
    if model_id not in p["models"]:
        raise PlanError(f"{model_name} is not part of the {p['name']} plan. Switch plans on the Plans page.")
    if p["max_size"] and size > int(p["max_size"]):
        raise PlanError(f"The {p['name']} plan generates up to {p['max_size']} px. Switch plans for {size} px.")
    if p["images_per_day"] is not None and images_today() >= int(p["images_per_day"]):
        raise PlanError(f"Today's {p['images_per_day']} images of the {p['name']} plan are used up. "
                        "Switch plans, or continue tomorrow.")


def check_new_project(existing: int):
    p = current()
    if p["projects"] is not None and existing >= int(p["projects"]):
        raise PlanError(f"The {p['name']} plan holds {p['projects']} project{'s' if p['projects'] != 1 else ''}. "
                        "Switch plans to add more.")


def summary() -> dict:
    cfg = load()
    p = current()
    used = images_today()
    limit = p["images_per_day"]
    return {"current": p["id"], "default": cfg["default"], "plans": cfg["plans"],
            "usage": {"date": time.strftime("%Y-%m-%d"), "images": used, "limit": limit,
                      "remaining": None if limit is None else max(0, int(limit) - used)}}
