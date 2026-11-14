"""Hardware compatibility checks.

  python -m inkos doctor            what this machine has and what each model needs
  python -m inkos doctor --bench    also measure real training / generation speed

The benchmark runs a few genuine optimisation steps on random data shaped like
a training batch, so the samples-per-second figure (and the projected time to
the target epoch count) is measured, not guessed.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import sys
import time

import torch

from . import __version__, paths
from .config import load_config, model_ids


def _ram_bytes() -> tuple[int | None, int | None]:
    total = avail = None
    try:
        total = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        pass
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    avail = int(line.split()[1]) * 1024
    except OSError:
        pass
    return total, avail


def probe() -> dict:
    total, avail = _ram_bytes()
    hw = {
        "inkos": __version__, "python": platform.python_version(), "torch": torch.__version__,
        "os": f"{platform.system()} {platform.release()}", "machine": platform.machine(),
        "cpu_threads": os.cpu_count(), "torch_threads": torch.get_num_threads(),
        "ram_gb": round(total / 2 ** 30, 1) if total else None,
        "ram_available_gb": round(avail / 2 ** 30, 1) if avail else None,
        "disk_free_gb": round(shutil.disk_usage(paths.ROOT).free / 2 ** 30, 1),
        "cuda": None, "mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
    }
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        hw["cuda"] = {"name": p.name, "vram_gb": round(p.total_memory / 2 ** 30, 1), "count": torch.cuda.device_count()}
    hw["device"] = "cuda" if hw["cuda"] else "mps" if hw["mps"] else "cpu"
    return hw


def read_bench() -> dict:
    try:
        return json.loads((paths.RUNS / "hardware.json").read_text())
    except (OSError, ValueError):
        return {}


def checks(hw: dict, status: dict) -> list[dict]:
    """Verdicts for one model: [{'level': ok|warn|fail, 'text': ...}]."""
    out = []
    mem = status["memory"]
    need = (max(mem["inference_mb"].values()) + 400) / 1024
    ram = hw.get("ram_available_gb") or hw.get("ram_gb")
    if ram is None:
        out.append({"level": "warn", "text": f"inference needs about {need:.1f} GB RAM; could not read this machine's memory"})
    elif ram >= need:
        out.append({"level": "ok", "text": f"inference: needs about {need:.1f} GB RAM, {ram} GB available"})
    else:
        out.append({"level": "fail", "text": f"inference: needs about {need:.1f} GB RAM but only {ram} GB is available"})
    tneed = mem["training_mb"] / 1024
    heavy = status["architecture"] != "inkscript-transformer"
    if hw["cuda"]:
        v = hw["cuda"]["vram_gb"]
        lvl = "ok" if v >= tneed else "warn"
        out.append({"level": lvl, "text": f"training: about {tneed:.1f} GB at batch {mem['training_batch_size']}; GPU {hw['cuda']['name']} has {v} GB"
                    + ("" if lvl == "ok" else " - lower train.batch_size")})
    elif heavy:
        out.append({"level": "warn", "text": "training: no CUDA GPU found. This model trains on a CPU, but far too slowly to "
                    "reach its target; use a GPU (about 8 GB or more) for real training"})
    else:
        out.append({"level": "ok", "text": f"training: runs on this CPU (about {tneed:.1f} GB RAM); a GPU is faster but not required"})
    if hw["disk_free_gb"] < 5:
        out.append({"level": "warn", "text": f"only {hw['disk_free_gb']} GB of disk free; datasets and checkpoints need several GB"})
    return out


def _peak_rss_mb() -> float | None:
    try:
        import resource
        v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(v / (1024 * 1024 if sys.platform == "darwin" else 1024), 0)
    except Exception:
        return None


def benchmark(model_id: str, device: torch.device, steps: int = 3) -> dict:
    """Time real training steps and one generation for a model on this machine."""
    from .engine import build_model
    cfg = load_config(model_id)
    model = build_model(cfg).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-5)
    B = int(cfg.train.batch_size)
    if cfg.architecture == "inkscript-transformer":
        from .vector import lang
        P, T = 48, 112
        batch = {"prompt": torch.randint(lang.CHAR0, lang.VOCAB, (B, P), device=device),
                 "prompt_mask": torch.ones(B, P, dtype=torch.bool, device=device),
                 "tokens": torch.randint(3, lang.VOCAB, (B, T), device=device),
                 "targets": torch.randint(3, lang.VOCAB, (B, T), device=device)}
        loss_fn = lambda: model.loss(batch)[0]
    else:
        R = int(cfg.data.resolution)
        batch = {"image": (torch.rand(B, 1, R, R, device=device) < 0.2).float(), "caption": ["manga portrait, girl"] * B}
        loss_fn = lambda: model.loss(batch, refiner_crops=int(cfg.train.refiner_crops))[0]
    model.train()
    times = []
    for i in range(steps + 1):
        t0 = time.time()
        loss = loss_fn()
        opt.zero_grad()
        loss.backward()
        opt.step()
        if device.type == "cuda":
            torch.cuda.synchronize()
        if i:
            times.append(time.time() - t0)
    train_sps = B / (sum(times) / len(times))
    model.eval()
    t0 = time.time()
    with torch.no_grad():
        if cfg.architecture == "inkscript-transformer":
            model.generate("bar chart: 3, 7, 5, 9", max_tokens=120)
            gen_note = "one drawing, 120-token budget"
        else:
            model.sample(["manga portrait"], steps=4, guidance=float(cfg.sample.guidance))
            gen_note = "4 of the default denoising steps"
    gen_s = time.time() - t0
    if cfg.architecture != "inkscript-transformer":
        gen_s = gen_s / 4 * int(cfg.sample.steps)
        gen_note = f"{cfg.sample.steps} denoising steps at 256 px (extrapolated from 4)"
    n = int(cfg.data.count)
    res = {"model": model_id, "device": str(device), "batch_size": B, "train_samples_per_sec": round(train_sps, 2),
           "seconds_per_epoch": round(n / train_sps), "dataset_size_assumed": n,
           "seconds_to_target": round(n / train_sps * int(cfg.target_epochs)), "target_epochs": int(cfg.target_epochs),
           "generation_seconds": round(gen_s, 2), "generation_note": gen_note, "peak_rss_mb": _peak_rss_mb(),
           "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    return res


def _dur(sec: float) -> str:
    for unit, n in (("years", 365 * 86400), ("days", 86400), ("hours", 3600), ("minutes", 60)):
        if sec >= n:
            return f"{sec / n:.1f} {unit}"
    return f"{sec:.0f} s"


def report(bench: bool = False) -> dict:
    from .engine import model_status
    from .training.trainer import pick_device
    hw = probe()
    print(f"INKOS {hw['inkos']}  |  Python {hw['python']}  |  PyTorch {hw['torch']}  |  {hw['os']} {hw['machine']}")
    print(f"CPU threads {hw['cpu_threads']}  |  RAM {hw['ram_gb']} GB ({hw['ram_available_gb']} GB available)  |  disk free {hw['disk_free_gb']} GB")
    print("GPU: " + (f"{hw['cuda']['name']}, {hw['cuda']['vram_gb']} GB" if hw["cuda"] else "Apple MPS" if hw["mps"] else "none (CPU only)"))
    results = read_bench()
    for mid in model_ids():
        st = model_status(mid)
        print(f"\n{st['name']}  -  {st['params_m']} M parameters, weights {st['memory']['weights_mb']} MB (float32)")
        for c in checks(hw, st):
            print(f"  [{c['level']:>4}] {c['text']}")
        if bench:
            print("  benchmarking ...", flush=True)
            results[mid] = benchmark(mid, pick_device(None))
        b = results.get(mid)
        if b:
            print(f"  measured on {b['device']}: training {b['train_samples_per_sec']} samples/s at batch {b['batch_size']}; "
                  f"one epoch of {b['dataset_size_assumed']:,} samples = {_dur(b['seconds_per_epoch'])}; "
                  f"{b['target_epochs']:,} epochs = {_dur(b['seconds_to_target'])}")
            print(f"  generation: {b['generation_seconds']} s ({b['generation_note']}); peak process memory {b['peak_rss_mb']} MB")
    if bench:
        paths.RUNS.mkdir(parents=True, exist_ok=True)
        (paths.RUNS / "hardware.json").write_text(json.dumps(results, indent=2))
    return {"hardware": hw, "bench": results}
