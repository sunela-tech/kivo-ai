"""Reference outputs from the Python implementation, for cloud/test/engine.test.mjs.

  python cloud/test/make_fixtures.py

Greedy decoding (temperature 0) is deterministic, so the JavaScript port must
produce exactly the same tokens from the same weights.
"""
import base64
import json
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from inkos import palette  # noqa: E402
from inkos.engine import Engine  # noqa: E402
from inkos.prompts import normalize_prompt  # noqa: E402
from inkos.vector import lang  # noqa: E402
from inkos.vector.font import wrap_text  # noqa: E402
from inkos.vector.render import render  # noqa: E402

PROMPTS = {
    "inkos1": ["note Groceries: milk; eggs; bread", "todo: [x] Pay rent; Call Anna", "bar chart: 3, 7, 5, 9",
               "flowchart: Start -> Check -> Done", "house icon"],
    "inkos1_1": ["blue note Groceries: milk; eggs", "colorful bar chart: Mon 3, Tue 7, Wed 5",
                 "black and red todo: [x] Pay rent; Call Anna", "red heart"],
}
CLEAN_OPS = [("CLEAN",), ("W", 2), ("RECT", 4, 4, 123, 123), ("TEXT", 8, 8, 8, 112, [(6, 13)]),
             ("LINE", [(10, 40), (60, 50), (110, 40)]), ("CURVE", [(10, 60), (40, 75), (80, 55), (118, 70)]),
             ("POLY", [(20, 80), (40, 80), (30, 98)]), ("FILL", [(60, 80), (80, 80), (70, 98)]),
             ("BLOB", [(90, 80), (110, 80), (100, 98)]), ("CIRC", 30, 112, 8), ("DISC", 60, 112, 6),
             ("ELLI", 95, 112, 14, 6), ("W", 4), ("DASH",), ("LINE", [(10, 25), (118, 25)]), ("SOLID",),
             ("ERASE",), ("DISC", 60, 112, 2), ("INK",), ("BOX", 112, 8, 120, 16)]
COLOR_OPS = [("COLOR", 2)] + CLEAN_OPS[:8] + [("COLOR", 4)] + CLEAN_OPS[8:12] + [("COLOR", 3), ("BOX", 100, 30, 120, 50),
                                                                                    ("COLOR", 5), ("FBLOB", [(70, 60), (90, 60), (80, 75)])]
PROMPT = "note: Buy milk; Call Anna"


def pix(img):
    a = np.asarray(img)
    if img.mode == "1":
        a = np.where(a, palette.WHITE, palette.BLACK)
    return base64.b64encode(a.astype(np.uint8).tobytes()).decode()


def main():
    eng = Engine("cpu")
    out = {"models": {}, "normalize": [], "wrap": [], "render": []}
    for mid, prompts in PROMPTS.items():
        model = eng._load(mid)["model"]
        color = bool(model.cfg.vocab > lang.VOCAB)
        cases = []
        for p in prompts:
            p = normalize_prompt(p, 256)
            res = model.generate(p, temperature=0.0, max_tokens=200)
            # hand-drawn wobble depends on the random generator, which JavaScript cannot
            # reproduce, so compare geometry with the ruler-straight pen
            clean = [o for o in res["ops"] if o != ("HAND",)]
            cases.append({"prompt": p, "tokens": res["tokens"], "complete": res["complete"],
                          "render256": pix(render(clean, p, 256, seed=0, color=color))})
        # first-step logits of the first prompt, for a numeric check
        p = cases[0]["prompt"]
        with torch.no_grad():
            lg = model(torch.tensor([lang.prompt_tokens(p)]), torch.ones(1, len(p), dtype=torch.bool),
                       torch.tensor([[lang.BOS] + cases[0]["tokens"][:5]]))[0]
        out["models"][mid] = {"color": color, "cases": cases, "logits": lg[:6].tolist()}
    for t in ["Groceries\n milk \n\neggs", "note Café:\nmilk", "a → b “quoted”", "tab\there", "x" * 300, ""]:
        out["normalize"].append([t, normalize_prompt(t, 256)])
    for t, n in [("one two three", 7), ("abcdefghij", 4), ("", 5), ("a  b", 3), ("Woke up early and went", 10)]:
        out["wrap"].append([t, n, wrap_text(t, n)])
    for ops, color in ((CLEAN_OPS, False), (COLOR_OPS, True)):
        for size in (256, 512):
            img = render(ops, PROMPT, size, seed=0, color=color)
            out["render"].append({"ops": [list(o) for o in ops], "prompt": PROMPT, "size": size, "color": color, "pixels": pix(img)})
    f = Path(__file__).with_name("fixtures.json")
    f.write_text(json.dumps(out))
    print(f"wrote {f} ({f.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
