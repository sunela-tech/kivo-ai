"""Model evaluation.

  python -m inkos eval --model inkos1
  python -m inkos eval --model inkos1_pro --n 8

Scores the newest checkpoint (or --checkpoint) on the held-out validation
split and on freshly generated samples, and writes
runs/<model>/eval/report.json plus a comparison sheet. Every number is
computed here from the weights on disk.

INKOS 1
  loss / perplexity / token and pointer accuracy  (teacher forced, per data family)
  syntax_valid_free     share of programs that parse when sampled WITHOUT the grammar mask
  complete              share that end properly within the token budget (with the mask)
  text_recall           share of reference text strings reproduced exactly on the page
  bar_count_match, bar_height_mae   are the bars the ones the prompt asked for
  iou                   ink overlap between the generated and the reference drawing

INKOS 1 Pro
  base_bce / refiner_bce / bit accuracy at fixed noise, split by noise level
  refiner_iou           how well 2x refinement of reduced real images restores them
  ink_ratio, edge_density, speckle  for generated images against real ones
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import torch

from . import bitmap, paths
from .config import Config, model_fingerprint
from .data import store
from .engine import build_model, weights_info
from .training.trainer import checkpoint_summary, pick_device


def load_weights(cfg: Config, checkpoint: str | None, device) -> tuple:
    """-> (model in eval mode, description of the weights)."""
    model = build_model(cfg)
    if checkpoint:
        ck = torch.load(checkpoint, map_location="cpu", weights_only=False)
        if ck.get("fingerprint") != model_fingerprint(cfg):
            raise SystemExit(f"{checkpoint} does not match configs/{cfg.id}.yaml")
        sd, info = ck["ema"], {"source": "checkpoint", "path": checkpoint, **checkpoint_summary(ck)}
    else:
        info = weights_info(cfg.id, cfg)
        if info is None:
            raise SystemExit(f"{cfg.name} has no weights to evaluate; train it first")
        raw = torch.load(info["path"], map_location="cpu", weights_only=info["source"] == "installed")
        sd = raw if info["source"] == "installed" else raw["ema"]
    model.load_state_dict({k: (v.float() if v.is_floating_point() else v) for k, v in sd.items()})
    return model.eval().requires_grad_(False).to(device), info


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


# --------------------------------------------------------------------------
# INKOS 1
# --------------------------------------------------------------------------

@torch.no_grad()
def eval_inkos1(cfg: Config, model, device, n: int, out: Path) -> dict:
    import torch.nn.functional as F

    from .vector import lang
    from .vector.render import render
    val = store.VectorSet(paths.data_dir(cfg.id), "val")
    kinds = val.kinds
    V = lang.VOCAB

    # 1. teacher-forced, per family
    agg = {}
    for batch in val.batches(0, 64, 0, shuffle=False):
        batch = {k: v.to(device) for k, v in batch.items()}
        logits = model(batch["prompt"], batch["prompt_mask"], batch["tokens"])
        tgt = batch["targets"]
        ce = F.cross_entropy(logits.flatten(0, 1).float(), tgt.flatten(), ignore_index=-100, reduction="none").view_as(tgt)
        valid = tgt != -100
        hit = (logits.argmax(-1) == tgt) & valid
        ptr = (tgt >= V) & valid
        for b in range(tgt.shape[0]):
            for key in ("all", kinds[int(batch["kind"][b])]):
                a = agg.setdefault(key, np.zeros(5))
                a += [float(ce[b][valid[b]].sum()), int(valid[b].sum()), int(hit[b].sum()), int((hit[b] & ptr[b]).sum()), int(ptr[b].sum())]
    tf = {k: {"loss": a[0] / a[1], "perplexity": float(np.exp(a[0] / a[1])), "token_acc": a[2] / a[1],
              "pointer_acc": (a[3] / a[4]) if a[4] else None, "tokens": int(a[1])} for k, a in agg.items()}

    # 2. free-running generation against references
    rng = np.random.default_rng(0)
    idx = rng.choice(len(val), min(n, len(val)), replace=False)
    s = cfg.sample
    gen_stats = {}
    sheet = []
    free_ok = complete = 0
    for j, i in enumerate(idx):
        prompt, toks, kind = val.get(int(i))
        ref_ops, _ = lang.decode(list(toks) + [lang.EOS], len(prompt))
        g = torch.Generator().manual_seed(int(i))
        res = model.generate(prompt, float(s.temperature), float(s.top_p), generator=g)
        free = model.generate(prompt, float(s.temperature), float(s.top_p), constrain=False,
                              generator=torch.Generator().manual_seed(int(i)))
        free_ok += int(free["complete"])
        complete += int(res["complete"])
        a = render(res["ops"], prompt, 128, seed=0)
        b = render(ref_ops, prompt, 128, seed=0)
        st = gen_stats.setdefault(kinds[kind], {"n": 0, "iou": 0.0, "text_ref": 0, "text_hit": 0, "bars": 0, "bar_match": 0, "bar_err": []})
        st["n"] += 1
        st["iou"] += _iou(bitmap.image_to_ink(a), bitmap.image_to_ink(b))
        ref_text = [lang.resolve_text(op[5], prompt) for op in ref_ops if op[0] == "TEXT"]
        got_text = [lang.resolve_text(op[5], prompt) for op in res["ops"] if op[0] == "TEXT"]
        pool = list(got_text)
        for t in ref_text:
            st["text_ref"] += 1
            if t in pool:
                pool.remove(t)
                st["text_hit"] += 1
        if kinds[kind] == "bar":
            rb = sorted([op[1:] for op in ref_ops if op[0] in ("RECT", "BOX")])
            gb = sorted([op[1:] for op in res["ops"] if op[0] in ("RECT", "BOX")])
            st["bars"] += 1
            if len(rb) == len(gb):
                st["bar_match"] += 1
                st["bar_err"] += [abs(min(r[1], r[3]) - min(q[1], q[3])) for r, q in zip(rb, gb)]
        if j < 24:
            sheet += [render(res["ops"], prompt, 192, seed=0), render(ref_ops, prompt, 192, seed=0)]
    by_kind = {}
    tot = {"n": 0, "iou": 0.0, "text_ref": 0, "text_hit": 0, "bars": 0, "bar_match": 0, "bar_err": []}
    for k, st in sorted(gen_stats.items()):
        by_kind[k] = {"n": st["n"], "iou": st["iou"] / st["n"],
                      "text_recall": (st["text_hit"] / st["text_ref"]) if st["text_ref"] else None}
        for key in tot:
            tot[key] = tot[key] + st[key]
    bitmap.save_png(bitmap.contact_sheet(sheet, 8, 192), out / "samples.png")
    report = {
        "teacher_forced": tf["all"], "teacher_forced_by_kind": {k: v for k, v in tf.items() if k != "all"},
        "generated": {
            "n": int(len(idx)), "syntax_valid_free": free_ok / len(idx), "complete": complete / len(idx),
            "iou": tot["iou"] / max(1, tot["n"]),
            "text_recall": (tot["text_hit"] / tot["text_ref"]) if tot["text_ref"] else None,
            "bar_count_match": (tot["bar_match"] / tot["bars"]) if tot["bars"] else None,
            "bar_height_mae_grid": float(np.mean(tot["bar_err"])) if tot["bar_err"] else None,
            "by_kind": by_kind,
        },
        "samples": "samples.png  (pairs: generated, then reference)",
    }
    return report


# --------------------------------------------------------------------------
# INKOS 1 Pro
# --------------------------------------------------------------------------

def image_stats(ink: np.ndarray) -> dict:
    """ink: bool [N, H, W]."""
    edges = (ink[:, :, 1:] != ink[:, :, :-1]).mean() + (ink[:, 1:, :] != ink[:, :-1, :]).mean()
    pad = np.pad(ink, ((0, 0), (1, 1), (1, 1)))
    lonely = ink & ~(pad[:, :-2, 1:-1] | pad[:, 2:, 1:-1] | pad[:, 1:-1, :-2] | pad[:, 1:-1, 2:])
    return {"ink_ratio": float(ink.mean()), "ink_ratio_std": float(ink.mean(axis=(1, 2)).std()),
            "edge_density": float(edges / 2), "speckle": float(lonely.sum() / max(1, ink.sum()))}


@torch.no_grad()
def eval_pro(cfg: Config, model, device, n: int, out: Path) -> dict:
    import torch.nn.functional as F

    from .models.inkos1_pro import downsample2
    val = store.RasterSet(paths.data_dir(cfg.id), "val", pool=1)
    g = torch.Generator().manual_seed(99)
    buckets = [(0.02, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.0)]
    bce = np.zeros(len(buckets))
    acc = np.zeros(len(buckets))
    ref_iou, real_lr, caps, nb = [], [], [], 0
    for bi, batch in enumerate(val.batches(0, 8, 0, shuffle=False)):
        if bi >= 6:
            break
        hr = batch["image"].to(device)
        lr = downsample2(hr)
        text, mask, pooled = model.text(batch["caption"])
        for k, (lo, hi) in enumerate(buckets):
            t = (lo + (hi - lo) * torch.rand(hr.shape[0], generator=g)).to(device)
            tb = t.view(-1, 1, 1, 1)
            x_t = (1 - tb) * (lr * 2 - 1) + tb * torch.randn(lr.shape, generator=g).to(device)
            logits = model.unet(x_t, t, text, mask, pooled)
            bce[k] += F.binary_cross_entropy_with_logits(logits.float(), lr).item()
            acc[k] += ((logits > 0) == (lr > 0.5)).float().mean().item()
        up = model.upscale(lr > 0.5)
        for a, b in zip(up[:, 0].cpu().numpy(), (hr[:, 0] > 0.5).cpu().numpy()):
            ref_iou.append(_iou(a, b))
        real_lr.append((lr[:, 0] > 0.5).cpu().numpy())
        caps += batch["caption"]
        nb += 1
    real = np.concatenate(real_lr)
    k = min(n, len(caps))
    s = cfg.sample
    gens = []
    for i in range(0, k, 4):
        ink = model.sample(caps[i: i + 4], steps=int(s.steps), guidance=float(s.guidance),
                           generator=torch.Generator().manual_seed(1000 + i))
        gens.append(ink[:, 0].cpu().numpy())
    gen = np.concatenate(gens) if gens else np.zeros((0, 1, 1), bool)
    sheet = []
    for a, b in zip(gen[:16], real[:16]):
        sheet += [bitmap.ink_to_image(a), bitmap.ink_to_image(b)]
    if sheet:
        bitmap.save_png(bitmap.contact_sheet(sheet, 8, 256), out / "samples.png")
    rs, gs = image_stats(real), (image_stats(gen) if len(gen) else {})
    return {
        "denoising_by_noise_level": [{"t": f"{lo}-{hi}", "bce": bce[i] / nb, "bit_acc": acc[i] / nb} for i, (lo, hi) in enumerate(buckets)],
        "base_bce": float(bce.mean() / nb), "base_bit_acc": float(acc.mean() / nb),
        "refiner_iou": float(np.mean(ref_iou)),
        "real_images": rs, "generated_images": {"n": int(len(gen)), **gs},
        "stat_gap": {key: abs(gs[key] - rs[key]) for key in gs},
        "samples": "samples.png  (pairs: generated, then a real image with the same caption)",
    }


def run(cfg: Config, checkpoint: str | None = None, n: int = 200, device: str | None = None) -> dict:
    dev = pick_device(device)
    model, info = load_weights(cfg, checkpoint, dev)
    out = paths.run_dir(cfg.id) / "eval"
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    if cfg.architecture == "inkscript-transformer":
        body = eval_inkos1(cfg, model, dev, n, out)
    else:
        body = eval_pro(cfg, model, dev, min(n, 32), out)
    report = {
        "model": cfg.id, "name": cfg.name,
        "weights": {k: info.get(k) for k in ("source", "path", "epochs_completed", "epoch_progress", "global_step", "samples_seen")},
        "target_epochs": int(cfg.target_epochs), "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "seconds": round(time.time() - t0, 1), **body,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2))
    return report
