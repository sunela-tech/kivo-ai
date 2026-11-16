"""Reference pictures from the PyTorch Pro models, for cloud/test/pro.browser.mjs.

  python cloud/test/make_pro_fixtures.py inkos1_pro inkos1_1_pro

For each model: the starting noise, and the 256 / 512 / 1024 px pictures that
Inkos1Pro.sample and engine.upscale_tiled make from it, as palette indices
(0 black, 1 white, 2.. colours). The browser test feeds the same noise to the
ONNX graphs and compares. Written to cloud/test/pro-fixtures/<model>/ (not committed).
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "cloud"))

from inkos.engine import upscale_tiled  # noqa: E402
from inkos.prompts import normalize_prompt  # noqa: E402
from pro_onnx import load_model  # noqa: E402

PROMPTS = {"inkos1_pro": "manga portrait, girl, long black hair, smiling, sailor uniform",
           "inkos1_1_pro": "colorful manga portrait, girl, red hair, blue sailor uniform",
           "inkos_motion1_pro": "color manga animation, character talking, color manga portrait, girl, long red hair"}
STEPS, GUIDANCE, SEED = 4, 3.0, 7


def indices(pic, color):
    if color:
        return pic[0].numpy().astype(np.uint8)
    return np.where(pic[0, 0].numpy(), 0, 1).astype(np.uint8)       # ink -> black (0), paper -> white (1)


def main(mids):
    torch.set_num_threads(2)
    for mid in mids:
        model, _, _ = load_model(mid)
        color = model.cfg.colors > 1
        R, C = model.cfg.base_resolution, model.cfg.planes
        frames = int(getattr(model.cfg, "frames", 0) or 0)
        prompt = normalize_prompt(PROMPTS[mid], model.cfg.max_prompt)
        out = Path(__file__).parent / "pro-fixtures" / mid
        out.mkdir(parents=True, exist_ok=True)
        shape = (1, C, frames, R, R) if frames else (1, C, R, R)
        noise = torch.randn(*shape, generator=torch.Generator().manual_seed(SEED))
        noise.numpy().astype("<f4").tofile(out / "noise.f32")
        with torch.no_grad():
            pic = model.sample([prompt], steps=STEPS, guidance=GUIDANCE, generator=torch.Generator().manual_seed(SEED))
            sizes = {}
            if frames:                                       # a clip: every frame, refined frame by frame
                clip = pic[0]
                for size in (256, 512):
                    ups = {R * 2: 1, R * 4: 2}[size]
                    out_frames = []
                    for f in range(frames):
                        p = clip[f: f + 1]
                        for _ in range(ups):
                            p = upscale_tiled(model, p)
                        out_frames.append(p[0].numpy().astype(np.uint8))
                    a = np.stack(out_frames)
                    a.tofile(out / f"expected_{size}.u8")
                    sizes[size] = {"black": float((a == 0).mean())}
            for size in (() if frames else (256, 512, 1024)):
                if size > R:
                    pic = upscale_tiled(model, pic)
                a = indices(pic, color)
                a.tofile(out / f"expected_{size}.u8")
                sizes[size] = {"black": float((a == 0).mean())}
        (out / "meta.json").write_text(json.dumps({"model": mid, "prompt": prompt, "steps": STEPS, "guidance": GUIDANCE,
                                                   "planes": C, "frames": frames, "sizes": sizes}, indent=1))
        print(mid, sizes)


if __name__ == "__main__":
    main(sys.argv[1:] or ["inkos1_pro"])
