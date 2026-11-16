"""Plans: four usage tiers for the INKOS app.

Defined in configs/plans.yaml. A plan limits generation only: which models,
the largest size, a daily usage allowance in tokens, and the number of
projects. Every generation costs tokens according to the computation it
takes (cost()); the allowance resets every day. The active plan is a local
setting (settings.json); today's usage is counted in usage.json. There are no
accounts, license keys or payments behind this.
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
    """-> {'default': id, 'usage': {...}, 'plans': [plan, ...]} from configs/plans.yaml."""
    raw = yaml.safe_load((paths.CONFIGS / "plans.yaml").read_text())
    plans = raw.get("plans") or []
    ids = [p["id"] for p in plans]
    if not plans or len(set(ids)) != len(ids):
        raise ValueError("configs/plans.yaml needs at least one plan and unique ids")
    if raw.get("default") not in ids:
        raw["default"] = ids[0]
    raw.setdefault("usage", {"unit": "tokens", "period": "day", "costs": {}, "steps": {"min": 1, "max": 1000}})
    for p in plans:
        p.setdefault("name", p["id"].title())
        for key in ("tagline", "price", "max_size", "tokens_per_day", "projects"):
            p.setdefault(key, None)
        p["models"] = list(p.get("models") or [])
    return raw


def cost(model_id: str, size: int, steps: int | None = None, cfg: dict | None = None) -> int:
    """Tokens one generation takes. Same formula as INKOS Cloud's Worker (cloud/src/usage.js)."""
    usage = (cfg or load())["usage"]
    c = usage["costs"].get(model_id)
    if c is None:
        raise PlanError(f"no usage cost for '{model_id}' in configs/plans.yaml")
    if "per_step" in c:
        lo, hi = int(usage["steps"]["min"]), int(usage["steps"]["max"])
        if steps is None or not lo <= int(steps) <= hi:
            raise PlanError(f"steps must be between {lo} and {hi}")
        base = float(c["per_step"]) * int(steps)
    else:
        base = float(c.get("image", c.get("clip", 0)))
    factor = float((c.get("sizes") or {}).get(int(size), (c.get("sizes") or {}).get(str(size), 1.0)))
    return int(round(base * factor))


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


def used_today() -> dict:
    u = _read_json("usage.json")
    if u.get("date") != time.strftime("%Y-%m-%d"):
        return {"tokens": 0, "images": 0}
    return {"tokens": int(u.get("tokens", 0)), "images": int(u.get("images", 0))}


def record(tokens: int) -> dict:
    """Count one generation and its tokens against today's allowance."""
    with _lock:
        u = used_today()
        u = {"date": time.strftime("%Y-%m-%d"), "tokens": u["tokens"] + int(tokens), "images": u["images"] + 1}
        _write_json("usage.json", u)
        return u


def check_generate(model_id: str, model_name: str, size: int, steps: int | None = None) -> int:
    """Raise PlanError if the active plan does not allow this generation; otherwise return its cost in tokens."""
    p = current()
    if model_id not in p["models"]:
        raise PlanError(f"{model_name} is not part of the {p['name']} plan. Switch plans on the Plans page.")
    if p["max_size"] and size > int(p["max_size"]):
        raise PlanError(f"The {p['name']} plan generates up to {p['max_size']} px. Switch plans for {size} px.")
    tokens = cost(model_id, size, steps)
    limit = p["tokens_per_day"]
    if limit is not None and used_today()["tokens"] + tokens > int(limit):
        raise PlanError(f"This needs {tokens:,} tokens and {max(0, int(limit) - used_today()['tokens']):,} of today's "
                        f"{int(limit):,} are left on the {p['name']} plan. Switch plans, or continue tomorrow.")
    return tokens


def check_new_project(existing: int):
    p = current()
    if p["projects"] is not None and existing >= int(p["projects"]):
        raise PlanError(f"The {p['name']} plan holds {p['projects']} project{'s' if p['projects'] != 1 else ''}. "
                        "Switch plans to add more.")


def usage_summary(p: dict | None = None) -> dict:
    p = p or current()
    u = used_today()
    limit = p["tokens_per_day"]
    return {"date": time.strftime("%Y-%m-%d"), "tokens": u["tokens"], "images": u["images"], "limit": limit,
            "remaining": None if limit is None else max(0, int(limit) - u["tokens"]),
            "percent": None if not limit else round(min(100.0, 100.0 * u["tokens"] / int(limit)), 1)}


def summary() -> dict:
    cfg = load()
    p = current()
    return {"current": p["id"], "default": cfg["default"], "plans": cfg["plans"], "costs": cfg["usage"],
            "usage": usage_summary(p)}
