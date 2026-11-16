"""Convert an installed INKOS Pro model into ONNX graphs that run in a browser.

  python cloud/pro_onnx.py inkos1_pro [--check]

Reads models/<id>/weights.pt (written by `python -m inkos export`) and writes
cloud/public/weights/<id>/:

  text.onnx      prompt characters -> text features, mask, pooled vector
  step.onnx      one denoising step with classifier-free guidance:
                 (x, self_cond, t, t_next / t, guidance, text...) -> (x_next, x0)
  refiner.onnx   the learned 2x refiner: +-1 picture -> logits at twice the size
  manifest.json  file sizes, hashes, model shape, sampling defaults and the
                 weights' real training record

The weights are stored as float16 and widened to float32 when the browser
loads them (a Cast on every weight, folded away by onnxruntime at load time),
so all arithmetic runs in float32 on both WebGPU and WebAssembly. Nothing is
trained or changed here; --check runs the graphs with onnxruntime and
compares them with the PyTorch model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from inkos.config import load_config  # noqa: E402
from inkos.engine import build_model  # noqa: E402
from inkos.models.inkos1_pro import PAD_ID, Inkos1Pro  # noqa: E402

OUT = ROOT / "cloud" / "public" / "weights"
OPSET = 17


# ---------------------------------------------------------------------------
# export wrappers: the same arithmetic as Inkos1Pro.sample / upscale, as graphs

class TextGraph(nn.Module):
    def __init__(self, model: Inkos1Pro):
        super().__init__()
        self.enc = model.text

    def forward(self, ids):
        enc = self.enc
        mask = ids != PAD_ID
        x = enc.tok(ids) + enc.pos(torch.arange(ids.shape[1], device=ids.device))
        for b in enc.blocks:
            x = b(x, mask)
        x = enc.norm(x)
        m = mask.unsqueeze(-1).to(x.dtype)
        pooled = (x * m).sum(1) / m.sum(1)
        return x, mask, pooled


class StepGraph(nn.Module):
    """Row 0 of text/mask/pooled is the prompt, row 1 the empty prompt (as in Inkos1Pro.sample)."""

    def __init__(self, model: Inkos1Pro):
        super().__init__()
        self.unet = model.unet
        self.color = model.cfg.colors > 1

    def forward(self, x, sc, t, ratio, guidance, text, mask, pooled):
        # x, sc: [1,C,R,R] for a picture, [1,C,F,R,R] for a MOTION clip (softmax over dim 1 either way)
        out = self.unet(torch.cat([x, x]), torch.cat([t, t]), text, mask, pooled, torch.cat([sc, sc]))
        cond, unc = out[0:1], out[1:2]
        logits = unc + guidance * (cond - unc)
        x0 = torch.softmax(logits, dim=1) * 2 - 1 if self.color else torch.tanh(logits / 2)
        return x0 + ratio * (x - x0), x0


class RefinerGraph(nn.Module):
    def __init__(self, model: Inkos1Pro):
        super().__init__()
        self.refiner = model.refiner

    def forward(self, x):
        return self.refiner(x)


def _plain_attention(self, x, ctx=None, mask=None):
    """_Attention.forward written with MatMul / Softmax, as exported.

    Same result as scaled_dot_product_attention (a masked key gets -1e9, whose
    exp is exactly 0 in float32; every prompt keeps its <bos> key), but it
    exports without the NaN guards that WebGPU cannot run."""
    B, T, D = x.shape
    ctx = x if ctx is None else ctx
    S = ctx.shape[1]
    hd = D // self.h
    q = self.q(x).view(B, T, self.h, hd).transpose(1, 2)
    k, v = self.kv(ctx).view(B, S, 2, self.h, hd).permute(2, 0, 3, 1, 4)
    a = torch.matmul(q, k.transpose(-1, -2)) * (1.0 / math.sqrt(hd))
    if mask is not None:
        a = a + (1.0 - mask[:, None, None, :].to(a.dtype)) * -1e9
    a = torch.matmul(torch.softmax(a, dim=-1), v)
    return self.out(a.transpose(1, 2).reshape(B, T, D))


def load_model(mid: str) -> tuple[Inkos1Pro, dict, object]:
    cfg = load_config(mid)
    d = ROOT / "models" / mid
    man = json.loads((d / "manifest.json").read_text())
    model = build_model(cfg)
    model.load_state_dict({k: v.float() for k, v in torch.load(d / man["file"], map_location="cpu", weights_only=True).items()})
    return model.eval(), man, cfg


# ---------------------------------------------------------------------------
# float16 storage

def store_half(path: Path):
    """Keep every float32 weight as float16 plus a Cast back to float32."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    m = onnx.load(str(path))
    g = m.graph
    casts, keep = [], []
    for init in g.initializer:
        if init.data_type == TensorProto.FLOAT and int(np.prod(init.dims)) >= 16:
            a = numpy_helper.to_array(init).astype(np.float16)
            half = numpy_helper.from_array(a, init.name + "__f16")
            keep.append(half)
            casts.append(helper.make_node("Cast", [half.name], [init.name], to=TensorProto.FLOAT, name=init.name + "__cast"))
        else:
            keep.append(init)
    del g.initializer[:]
    g.initializer.extend(keep)
    nodes = casts + list(g.node)
    del g.node[:]
    g.node.extend(nodes)
    onnx.checker.check_model(m)
    onnx.save(m, str(path))


def export_graphs(mid: str) -> dict:
    model, man, cfg = load_model(mid)
    pc = model.cfg
    R, C, D = pc.base_resolution, pc.planes, pc.text_dim
    out = OUT / mid
    out.mkdir(parents=True, exist_ok=True)
    # Static shapes: the prompt and the empty prompt, padded to the full length.
    # Padding is masked, so it changes nothing; static shapes let onnxruntime
    # fold all shape arithmetic and keep every node on the GPU.
    L = pc.max_prompt + 1
    ids = torch.full((2, L), PAD_ID, dtype=torch.long)
    ids[:, 0] = 96
    ids[0, 1:12] = torch.arange(40, 51)
    frames = int(getattr(pc, "frames", 0) or 0)
    x = torch.randn(1, C, frames, R, R) if frames else torch.randn(1, C, R, R)
    one = torch.ones(1)
    kw = dict(opset_version=OPSET, do_constant_folding=True, dynamo=False)
    from inkos.models import inkos1_pro as P
    original = P._Attention.forward
    P._Attention.forward = _plain_attention
    try:
        with torch.no_grad():
            text, mask, pooled = TextGraph(model)(ids)
            torch.onnx.export(TextGraph(model), (ids,), out / "text.onnx", input_names=["ids"],
                              output_names=["text", "mask", "pooled"], **kw)
            torch.onnx.export(StepGraph(model), (x, torch.zeros_like(x), one, one * 0.9, one * 3, text, mask, pooled),
                              out / "step.onnx",
                              input_names=["x", "self_cond", "t", "ratio", "guidance", "text", "mask", "pooled"],
                              output_names=["x_next", "x0"], **kw)
    finally:
        P._Attention.forward = original
    with torch.no_grad():
        torch.onnx.export(RefinerGraph(model), (torch.ones(1, C, 64, 64),), out / "refiner.onnx",
                          input_names=["x"], output_names=["logits"],
                          dynamic_axes={"x": {2: "h", 3: "w"}, "logits": {2: "h2", 3: "w2"}}, **kw)
    files = []
    for name in ("text", "step", "refiner"):
        p = out / f"{name}.onnx"
        store_half(p)
        data = p.read_bytes()
        files.append({"name": p.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    manifest = {
        "model": mid, "name": cfg.name, "format": "onnx", "opset": OPSET, "files": files,
        "media": cfg.get("media", "image"), "motion": cfg.get("motion"),
        "config": {"base_resolution": R, "planes": C, "colors": pc.colors, "max_prompt": pc.max_prompt, "frames": frames,
                   "text_length": L, "bos_id": int(ids[0, 0]), "pad_id": PAD_ID, "first_char": 32, "n_chars": 95, "text_dim": D},
        "sample": cfg.sample.plain(), "sizes": list(cfg.inference.sizes), "default_size": int(cfg.inference.default_size),
        "params": int(man["params"]), "fingerprint": man["fingerprint"], "sha256_pt": man["sha256"],
        "training": man["training"], "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return manifest


# ---------------------------------------------------------------------------
# parity check against PyTorch

def check(mid: str, steps: int = 4) -> dict:
    import onnxruntime as ort

    model, _, _ = load_model(mid)
    out = OUT / mid
    so = ort.SessionOptions()
    sess = {n: ort.InferenceSession(str(out / f"{n}.onnx"), so, providers=["CPUExecutionProvider"]) for n in ("text", "step", "refiner")}
    prompt = "manga portrait, girl, long black hair, smiling"
    ids, _ = model.text.tokenize([prompt, ""], "cpu")
    full = np.zeros((2, model.cfg.max_prompt + 1), np.int64)
    full[:, : ids.shape[1]] = ids.numpy()
    text_o, mask_o, pooled_o = sess["text"].run(None, {"ids": full})
    n = ids.shape[1]
    with torch.no_grad():
        text_t, mask_t, pooled_t = model.text([prompt, ""])
    report = {"text_max_abs": float(np.abs(text_o[:, :n][mask_o[:, :n]] - text_t.numpy()[mask_t.numpy()]).max()),
              "pooled_max_abs": float(np.abs(pooled_o - pooled_t.numpy()).max()),
              "mask_equal": bool((mask_o[:, :n] == mask_t.numpy()).all() and not mask_o[:, n:].any())}

    # the full sampler with fixed noise, in PyTorch and through the graphs
    R, C, g = model.cfg.base_resolution, model.cfg.planes, 3.0
    frames = int(getattr(model.cfg, "frames", 0) or 0)
    shape = (1, C, frames, R, R) if frames else (1, C, R, R)
    noise = torch.randn(*shape, generator=torch.Generator().manual_seed(7))
    ts = torch.linspace(1.0, 0.0, steps + 1).tolist()
    x_t, sc_t = noise.clone(), torch.zeros_like(noise)
    x_o, sc_o = noise.numpy().copy(), np.zeros_like(noise.numpy())
    with torch.no_grad():
        for i in range(steps):
            t = torch.full((2,), ts[i])
            o = model.unet(torch.cat([x_t, x_t]), t, text_t, mask_t, pooled_t, torch.cat([sc_t, sc_t]))
            cond, unc = o.chunk(2)
            logits = unc + g * (cond - unc)
            x0 = model.estimate(logits)
            sc_t = x0
            x_t = x0 + (ts[i + 1] / ts[i]) * (x_t - x0)
            f = lambda v: np.array([v], dtype=np.float32)  # noqa: E731
            x_o, sc_o = sess["step"].run(None, {"x": x_o, "self_cond": sc_o, "t": f(ts[i]), "ratio": f(ts[i + 1] / ts[i]),
                                                "guidance": f(g), "text": text_o, "mask": mask_o, "pooled": pooled_o})
    report["x0_max_abs"] = float(np.abs(sc_o - sc_t.numpy()).max())
    if C > 1:
        pic_t = logits.argmax(1).numpy()
        pic_o = sc_o.argmax(1)
    else:
        pic_t = (logits > 0).numpy()
        pic_o = sc_o > 0
    report["picture_agreement"] = float((pic_t == pic_o).mean())

    # refiner
    with torch.no_grad():
        pic = torch.from_numpy(pic_o[:, 0] if frames else pic_o)
        inp = (F.one_hot(pic, C).permute(0, 3, 1, 2).float() * 2 - 1) if C > 1 else pic.float() * 2 - 1
        ref_t = model.refiner(inp[..., :96, :80]).numpy()
    ref_o = sess["refiner"].run(None, {"x": inp[..., :96, :80].numpy()})[0]
    report["refiner_max_abs"] = float(np.abs(ref_o - ref_t).max())

    # speed of one step on this machine's CPU through onnxruntime
    feed = {"x": x_o, "self_cond": sc_o, "t": np.array([0.5], np.float32), "ratio": np.array([0.9], np.float32),
            "guidance": np.array([g], np.float32), "text": text_o, "mask": mask_o, "pooled": pooled_o}
    sess["step"].run(None, feed)
    t0 = time.time()
    sess["step"].run(None, feed)
    report["step_seconds_cpu"] = round(time.time() - t0, 3)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="+")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    for mid in a.models:
        man = export_graphs(mid)
        print(mid, ", ".join(f"{f['name']} {f['bytes'] / 1e6:.1f} MB" for f in man["files"]))
        if a.check:
            print(json.dumps(check(mid), indent=1))


if __name__ == "__main__":
    main()
