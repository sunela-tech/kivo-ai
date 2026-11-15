"""Prepare INKOS Cloud's static files from this repository.

  python cloud/build.py

Writes (all generated, not committed), under cloud/public/:

  weights/<model>.bin    float16 weights of INKOS 1 and 1.1, tensors back to back
  weights/<model>.json   tensor index, model shape and the weights' training record
  weights/<pro>/         INKOS 1 Pro and 1.1 Pro as ONNX graphs + manifest.json (pro_onnx.py)
  data/font.json         the single-stroke font, already smoothed
  data/app.json          models, plans, palette and drawing-language constants
  style.css              the shared stylesheet, copied from web/

and cloud/src/static.gen.js, the page and engine bundled into the Worker.

All four models run in the browser. Their installed weights
(models/<id>/weights.pt) are converted as they are: nothing is trained here.
A Pro model that is not installed is left out of the cloud app.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import torch
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from inkos import palette  # noqa: E402
from inkos.config import load_config  # noqa: E402
from inkos.vector import font, lang  # noqa: E402
from inkos.vector import render as R  # noqa: E402

OUT = ROOT / "cloud" / "public"
VECTOR_MODELS = ("inkos1", "inkos1_1")         # drawing-program models: a small JavaScript port runs them
PRO_MODELS = ("inkos1_pro", "inkos1_1_pro")    # pixel diffusion: ONNX graphs run by onnxruntime-web
ALL_MODELS = VECTOR_MODELS + PRO_MODELS


def export_weights(mid: str) -> dict:
    cfg = load_config(mid)
    d = ROOT / "models" / mid
    man = json.loads((d / "manifest.json").read_text())
    sd = torch.load(d / man["file"], map_location="cpu", weights_only=True)
    tensors, offset, chunks = {}, 0, []
    for name, t in sd.items():
        if name == "head.weight":          # tied to tok.weight
            continue
        a = t.to(torch.float16).contiguous().numpy().astype("<f2")
        tensors[name] = {"offset": offset, "shape": list(a.shape)}
        offset += a.size
        chunks.append(a.ravel())
    (OUT / "weights").mkdir(parents=True, exist_ok=True)
    np.concatenate(chunks).tofile(OUT / "weights" / f"{mid}.bin")
    index = {
        "model": mid, "name": cfg.name, "dtype": "float16", "elements": offset, "tensors": tensors,
        "config": {**cfg.model.plain(), "vocab": lang.VOCAB_COLOR if cfg.model.get("color") else lang.VOCAB},
        "fingerprint": man["fingerprint"], "sha256_pt": man["sha256"], "training": man["training"],
    }
    (OUT / "weights" / f"{mid}.json").write_text(json.dumps(index))
    return index


def export_font():
    glyphs = {ch: [np.round(st, 5).ravel().tolist() for st in strokes] for ch, strokes in font.GLYPHS.items()}
    (OUT / "data").mkdir(parents=True, exist_ok=True)
    (OUT / "data" / "font.json").write_text(json.dumps({"adv": font.ADV, "line_h": font.LINE_H, "glyphs": glyphs},
                                                       separators=(",", ":")))


def export_pro(mid: str) -> dict | None:
    """ONNX graphs of an installed Pro model, or None when it is not installed."""
    if not (ROOT / "models" / mid / "manifest.json").exists():
        print(f"{mid}: not installed (python -m inkos export --model {mid}); left out of the cloud app")
        return None
    import pro_onnx
    installed = json.loads((ROOT / "models" / mid / "manifest.json").read_text())
    done = OUT / "weights" / mid / "manifest.json"
    if done.exists():                                    # already exported from these exact weights
        prev = json.loads(done.read_text())
        if prev.get("sha256_pt") == installed["sha256"] and all(
                (done.parent / f["name"]).exists() and (done.parent / f["name"]).stat().st_size == f["bytes"] for f in prev["files"]):
            return prev
    return pro_onnx.export_graphs(mid)


def check_runtime():
    """The page imports onnxruntime-web from /ort/<version>/; it must be the installed version."""
    want = json.loads((ROOT / "cloud" / "node_modules" / "onnxruntime-web" / "package.json").read_text())["version"]
    src = (OUT / "engine" / "pro.js").read_text()
    if f"ORT_VERSION = '{want}'" not in src:
        raise SystemExit(f"public/engine/pro.js does not name onnxruntime-web {want} (npm install, then update ORT_VERSION)")


def export_app(indexes: dict, pros: dict):
    plans = yaml.safe_load((ROOT / "configs" / "plans.yaml").read_text())
    models = []
    for mid in ALL_MODELS:
        cfg = load_config(mid)
        m = {"id": mid, "name": cfg.name, "summary": " ".join(cfg.summary.split()), "specialties": list(cfg.specialties),
             "palette": bool(cfg.get("palette")), "target_epochs": int(cfg.target_epochs),
             "sizes": list(cfg.inference.sizes), "default_size": int(cfg.inference.default_size),
             "examples": list(cfg.preview_prompts), "engine": "pro" if mid in PRO_MODELS else "vector",
             "cloud": mid in indexes or mid in pros, "sample": cfg.sample.plain(), "max_prompt": int(cfg.model.max_prompt)}
        if mid in indexes:
            ix = indexes[mid]
            m.update(training=ix["training"], params=sum(int(np.prod(t["shape"])) for t in ix["tensors"].values()),
                     weights_bytes=ix["elements"] * 2)
        if mid in pros:
            pm = pros[mid]
            m.update(training=pm["training"], params=pm["params"], weights_bytes=sum(f["bytes"] for f in pm["files"]))
        models.append(m)
    cloud = {m["id"] for m in models if m["cloud"]}
    app = {
        "models": models,
        "plans": [{**p, "models": [m for m in p["models"] if m in cloud]} for p in plans["plans"]],
        "default_plan": plans["default"],
        "palette": {"names": list(palette.NAMES), "rgb": [list(c) for c in palette.RGB]},
        "lang": {"GRID": lang.GRID, "PAD": lang.PAD, "BOS": lang.BOS, "EOS": lang.EOS, "NAMES": lang.NAMES,
                 "COORD0": lang.COORD0, "CHAR0": lang.CHAR0, "VOCAB": lang.VOCAB, "COLOR0": lang.COLOR0,
                 "VOCAB_COLOR": lang.VOCAB_COLOR, "PATH_MIN": lang.PATH_MIN, "FIXED_ARGS": lang.FIXED_ARGS,
                 "MAX_PATH_POINTS": lang.MAX_PATH_POINTS, "MAX_TEXT_ITEMS": lang.MAX_TEXT_ITEMS},
        "render": {"STROKE": R.STROKE, "MIN_STROKE_PX": R.MIN_STROKE_PX, "WOBBLE": R.WOBBLE},
    }
    (OUT / "data" / "app.json").write_text(json.dumps(app, indent=1))
    return app


STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".json": "application/json"}


def export_static():
    """Bundle the page, the engine and its data into the Worker script (src/static.gen.js).

    The weights are not bundled: they go to Workers KV (see README.md)."""
    files = {}
    for f in sorted(OUT.rglob("*")):
        rel = "/" + f.relative_to(OUT).as_posix()
        if f.is_file() and f.suffix in STATIC_TYPES and not rel.startswith("/weights/"):
            files[rel] = {"type": STATIC_TYPES[f.suffix], "body": f.read_text(encoding="utf-8")}
    files["/"] = files["/index.html"]
    src = ("// Generated by cloud/build.py from cloud/public/. Do not edit.\n"
           f"export default {json.dumps(files, separators=(',', ':'))};\n")
    (ROOT / "cloud" / "src" / "static.gen.js").write_text(src, encoding="utf-8")
    print(f"bundled {len(files) - 1} static files ({len(src) // 1024} KB) into src/static.gen.js")


def main():
    check_runtime()
    indexes = {mid: export_weights(mid) for mid in VECTOR_MODELS}
    pros = {mid: pm for mid in PRO_MODELS if (pm := export_pro(mid))}
    export_font()
    export_app(indexes, pros)
    shutil.copyfile(ROOT / "web" / "style.css", OUT / "style.css")    # one stylesheet for both apps
    export_static()
    sizes = {**{mid: ix["elements"] * 2 for mid, ix in indexes.items()},
             **{mid: sum(f["bytes"] for f in pm["files"]) for mid, pm in pros.items()}}
    for mid, info in {**indexes, **pros}.items():
        t = info["training"]
        print(f"{mid}: {sizes[mid] / 1e6:.1f} MB, {t['epochs_completed']} epochs + "
              f"{100 * t['epoch_progress']:.1f}%, {t['samples_seen']} samples")
    print(f"wrote {OUT}/weights, {OUT}/data")


if __name__ == "__main__":
    main()
