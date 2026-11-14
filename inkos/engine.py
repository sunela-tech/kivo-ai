"""Local inference engine: loads installed weights and turns prompts into PNGs.

This module never trains and never writes to runs/ (except caching a
checkpoint's summary). It reads, in order of preference:

  1. models/<id>/weights.pt     installed with `python -m inkos export`
  2. runs/<id>/checkpoints/last.pt   the newest training checkpoint (EMA weights)

Whatever it uses, it reports the real amount of training behind those weights.
"""
from __future__ import annotations

import json
import random
import threading
import time

import torch

from . import bitmap, paths
from .config import Config, load_config, model_fingerprint, model_ids
from .data import store
from .prompts import normalize_prompt
from .training.trainer import atomic_write_json, checkpoint_summary, pick_device, pid_alive, read_state

_param_cache: dict[str, int] = {}


def build_model(cfg: Config):
    if cfg.architecture == "inkscript-transformer":
        from .models.inkos1 import Inkos1, Inkos1Config
        return Inkos1(Inkos1Config.from_dict(cfg.model))
    from .models.inkos1_pro import Inkos1Pro, ProConfig
    return Inkos1Pro(ProConfig.from_dict(cfg.model))


def param_count(cfg: Config) -> int:
    key = model_fingerprint(cfg)
    if key not in _param_cache:
        _param_cache[key] = sum(p.numel() for p in build_model(cfg).parameters())
    return _param_cache[key]


# --------------------------------------------------------------------------
# what weights exist
# --------------------------------------------------------------------------

def _checkpoint_info(model_id: str) -> dict | None:
    ck = paths.run_dir(model_id) / "checkpoints" / "last.pt"
    if not ck.exists():
        return None
    side = ck.with_suffix(".json")
    if not side.exists() or side.stat().st_mtime < ck.stat().st_mtime - 1:
        data = torch.load(ck, map_location="cpu", weights_only=False)
        atomic_write_json(side, checkpoint_summary(data))
    info = json.loads(side.read_text())
    return {"source": "checkpoint", "path": str(ck), "bytes": ck.stat().st_size, "mtime": ck.stat().st_mtime, **info}


def _installed_info(model_id: str) -> dict | None:
    d = paths.model_dir(model_id)
    try:
        man = json.loads((d / "manifest.json").read_text())
        w = d / man["file"]
        st = w.stat()
    except (OSError, ValueError, KeyError):
        return None
    return {"source": "installed", "path": str(w), "bytes": st.st_size, "mtime": st.st_mtime,
            "exported_at": man.get("exported_at"), "dtype": man.get("dtype"), "sha256": man.get("sha256"),
            "fingerprint": man.get("fingerprint"), **man.get("training", {})}


def weights_info(model_id: str, cfg: Config | None = None) -> dict | None:
    """The weights inference will use, or None if the model has never been trained here."""
    cfg = cfg or load_config(model_id)
    fp = model_fingerprint(cfg)
    for info in (_installed_info(model_id), _checkpoint_info(model_id)):
        if info and info.get("fingerprint") == fp:
            return info
    return None


def memory_estimate(cfg: Config, params: int) -> dict:
    """Rough working-memory needs in MB (model + activations, excluding the ~300 MB Python/PyTorch runtime)."""
    w = params * 4 / 1e6
    if cfg.architecture == "inkscript-transformer":
        m = cfg.model
        cache = m.n_layers * 2 * (m.max_prompt + m.max_program) * m.d_model * 4 / 1e6
        infer = {str(s): round(w + cache + (s * (4 if s <= 256 else 3 if s <= 512 else 2)) ** 2 * 2 / 1e6) for s in cfg.inference.sizes}
        train = round(w * 4 + int(cfg.train.batch_size) * 28 + 250)
    else:
        m = cfg.model
        g = (m.base_resolution // m.patch) ** 2
        act = 2 * sum(c * g / 4 ** i for i, c in enumerate(m.channels)) * 4 * 12 / 1e6       # two guided branches
        tile = m.refiner_channels * 6 * 288 * 288 * 4 * 4 / 1e6
        infer = {str(s): round(w + act + (0 if s <= m.base_resolution else tile)) for s in cfg.inference.sizes}
        train = round(w * 4 + int(cfg.train.batch_size) * 330)
    return {"weights_mb": round(w, 1), "inference_mb": infer, "training_mb": train,
            "training_batch_size": int(cfg.train.batch_size)}


def model_status(model_id: str) -> dict:
    """Everything the dashboard shows about one model. All numbers come from files on disk."""
    cfg = load_config(model_id)
    params = param_count(cfg)
    st = read_state(model_id)
    if st and st.get("fingerprint") != model_fingerprint(cfg):
        st = None
    running = bool(st and st.get("status") == "training" and pid_alive(st.get("pid")))
    installed = _installed_info(model_id)
    if st is None and installed and installed.get("fingerprint") == model_fingerprint(cfg):
        # no run on this machine, but the installed weights carry their own training record
        training = {"status": "not running", "epochs_completed": installed.get("epochs_completed", 0),
                    "epoch_progress": installed.get("epoch_progress", 0.0), "global_step": installed.get("global_step", 0),
                    "samples_seen": installed.get("samples_seen", 0), "train_seconds": installed.get("train_seconds"),
                    "loss": None, "val": installed.get("val") or {}, "previews": [],
                    "message": "No training run on this machine yet. These numbers are the record stored with the "
                               "installed weights; training continues from them."}
    elif st is None:
        training = {"status": "not started", "epochs_completed": 0, "epoch_progress": 0.0, "global_step": 0,
                    "samples_seen": 0, "loss": None, "val": {}, "previews": []}
    else:
        training = dict(st)
        if st.get("status") == "training" and not running:
            training["status"] = "interrupted"
            training["message"] = "the training process is no longer running; resume to continue from the last checkpoint"
    training["target_epochs"] = int(cfg.target_epochs)
    training["running"] = running
    ds = store.dataset_info(paths.data_dir(model_id))
    dataset = None
    if ds:
        dataset = {"train_count": ds.get("train_count"), "val_count": ds.get("val_count"), "by_kind": ds.get("by_kind", {}).get("train", {}),
                   "sources": ds.get("sources", []), "created": ds.get("created"), "resolution": ds.get("resolution")}
    w = weights_info(model_id, cfg)
    ck = _checkpoint_info(model_id)
    newer = bool(w and ck and w["source"] == "installed" and ck.get("samples_seen", 0) > w.get("samples_seen", 0))
    return {
        "id": model_id, "name": cfg.name, "architecture": cfg.architecture, "summary": cfg.summary,
        "specialties": list(cfg.specialties), "params": params, "params_m": round(params / 1e6, 2),
        "sizes": list(cfg.inference.sizes), "default_size": int(cfg.inference.default_size),
        "max_prompt": int(cfg.model.max_prompt), "sample_defaults": cfg.sample.plain(),
        "examples": list(cfg.preview_prompts), "training": training, "dataset": dataset, "weights": w,
        "newer_checkpoint": newer, "memory": memory_estimate(cfg, params),
        "data_target": int(cfg.data.count),
    }


# --------------------------------------------------------------------------
# engine
# --------------------------------------------------------------------------

class Engine:
    """Loads models on demand and keeps them in memory. Thread-safe; one generation at a time."""

    def __init__(self, device: str | None = None):
        self.device = pick_device(device)
        self._loaded: dict[str, dict] = {}
        self._lock = threading.Lock()

    def unload(self, model_id: str | None = None):
        with self._lock:
            if model_id:
                self._loaded.pop(model_id, None)
            else:
                self._loaded.clear()

    def _load(self, model_id: str) -> dict:
        cfg = load_config(model_id)
        info = weights_info(model_id, cfg)
        if info is None:
            raise RuntimeError(f"{cfg.name} has no trained weights yet. Train it first:  "
                               f"python -m inkos data prepare --model {model_id}  then  python -m inkos train --model {model_id}")
        cur = self._loaded.get(model_id)
        if cur and cur["info"]["path"] == info["path"] and cur["info"]["mtime"] == info["mtime"]:
            return cur
        model = build_model(cfg)
        if info["source"] == "installed":
            sd = torch.load(info["path"], map_location="cpu", weights_only=True)
        else:
            sd = torch.load(info["path"], map_location="cpu", weights_only=False)["ema"]
        model.load_state_dict({k: (v.float() if v.is_floating_point() else v) for k, v in sd.items()})
        model.eval().requires_grad_(False).to(self.device)
        cur = {"cfg": cfg, "model": model, "info": info}
        self._loaded[model_id] = cur
        return cur

    def generate(self, model_id: str, prompt: str, size: int | None = None, seed: int | None = None,
                 steps: int | None = None, guidance: float | None = None, temperature: float | None = None,
                 progress=None) -> dict:
        """-> {'image': PIL mode '1', 'meta': {...}}. progress({'stage', 'fraction', 'detail'})."""
        with self._lock:
            m = self._load(model_id)
            cfg, model = m["cfg"], m["model"]
            size = int(size or cfg.inference.default_size)
            if size not in cfg.inference.sizes:
                raise ValueError(f"{cfg.name} supports sizes {list(cfg.inference.sizes)}")
            seed = int(seed) if seed is not None else random.SystemRandom().randrange(2 ** 31)
            text = normalize_prompt(prompt, int(cfg.model.max_prompt))
            note = progress or (lambda p: None)
            t0 = time.time()
            gen = torch.Generator().manual_seed(seed)
            meta = {"model": model_id, "model_name": cfg.name, "prompt": text, "size": size, "seed": seed}
            if cfg.architecture == "inkscript-transformer":
                img, extra = self._inkos1(model, cfg, text, size, seed, gen, temperature, note)
            else:
                img, extra = self._pro(model, cfg, text, size, gen, steps, guidance, note)
            note({"stage": "encoding PNG", "fraction": 1.0, "detail": ""})
            info = m["info"]
            meta.update(extra)
            meta.update({
                "seconds": round(time.time() - t0, 2), "ink_ratio": round(bitmap.ink_ratio(img), 4),
                "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "weights": {"source": info["source"], "epochs_completed": info.get("epochs_completed", 0),
                            "epoch_progress": info.get("epoch_progress", 0.0), "samples_seen": info.get("samples_seen", 0),
                            "target_epochs": int(cfg.target_epochs)},
            })
            return {"image": img, "meta": meta}

    # -- INKOS 1 --------------------------------------------------------------
    def _inkos1(self, model, cfg, text, size, seed, gen, temperature, note):
        from .vector import lang
        from .vector.render import render
        s = cfg.sample
        temperature = float(s.temperature if temperature is None else temperature)
        budget = int(cfg.model.max_program)

        def on_token(step, total):
            if step % 8 == 0:
                note({"stage": "writing drawing program", "fraction": min(0.9, step / total), "detail": f"{step} tokens"})

        res = model.generate(text, temperature, float(s.top_p), budget, generator=gen, progress=on_token)
        note({"stage": "rasterising", "fraction": 0.93, "detail": f"{len(res['tokens'])} tokens"})
        img = render(res["ops"], text, size, seed=seed)
        return img, {"temperature": temperature, "top_p": float(s.top_p), "tokens": len(res["tokens"]),
                     "complete": bool(res["complete"]), "program": lang.describe(res["ops"])}

    # -- INKOS 1 Pro ----------------------------------------------------------
    def _pro(self, model, cfg, text, size, gen, steps, guidance, note):
        s = cfg.sample
        steps = int(steps or s.steps)
        guidance = float(s.guidance if guidance is None else guidance)
        base = int(cfg.model.base_resolution)
        ups = {base: 0, base * 2: 1, base * 4: 2}[size]
        share = 1.0 - 0.08 * ups

        def on_step(i, n):
            note({"stage": "denoising", "fraction": share * i / n, "detail": f"step {i} of {n}"})

        ink = model.sample([text], steps=steps, guidance=guidance, generator=gen, progress=on_step)
        for k in range(ups):
            note({"stage": f"refining to {base * 2 ** (k + 1)} px", "fraction": share + 0.08 * k, "detail": ""})
            ink = upscale_tiled(model, ink)
        img = bitmap.ink_to_image(ink[0, 0].cpu().numpy())
        return img, {"steps": steps, "guidance": guidance, "base_resolution": base, "refiner_passes": ups}


@torch.no_grad()
def upscale_tiled(model, ink: torch.Tensor, tile: int = 256, overlap: int = 16) -> torch.Tensor:
    """2x refine in overlapping tiles so memory stays flat at any size."""
    B, _, H, W = ink.shape
    if max(H, W) <= tile + 2 * overlap:
        return model.upscale(ink)
    out = torch.zeros(B, 1, 2 * H, 2 * W, dtype=torch.bool, device=ink.device)
    for y in range(0, H, tile):
        for x in range(0, W, tile):
            y0, x0 = max(0, y - overlap), max(0, x - overlap)
            y1, x1 = min(H, y + tile + overlap), min(W, x + tile + overlap)
            up = model.upscale(ink[:, :, y0:y1, x0:x1])
            ty, tx = 2 * (y - y0), 2 * (x - x0)
            h, w = 2 * min(tile, H - y), 2 * min(tile, W - x)
            out[:, :, 2 * y: 2 * y + h, 2 * x: 2 * x + w] = up[:, :, ty: ty + h, tx: tx + w]
    return out


def all_status() -> list[dict]:
    return [model_status(mid) for mid in model_ids()]
