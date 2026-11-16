"""Procedural colour manga clips for INKOS MOTION 1 Pro.

Every clip is FRAMES frames in the six-colour palette, drawn with the same
generators as the INKOS 1.1 Pro pictures, then moved:

  pan          a wide background, the camera panning left or right
  zoom         a background or portrait, the camera zooming in or out
  expression   a character changing expression, talking or blinking
  sway         a character tilting their head from side to side
  move         a character moving across a background
  weather      any picture with falling rain, snow or petals, or twinkling sparkles

The caption says what moves, then describes the picture the way the INKOS
1.1 Pro captions do, so the two models share a vocabulary.
Frames are drawn at twice the stored size and reduced without blending.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw

from .. import palette
from ..palette import BLACK, BLUE, RED, WHITE, YELLOW
from .manga_chars import EXPRESSIONS, character_tags, draw_character, pick, sample_character
from .manga_scenes import EFFECTS, SCENES, _head, make_composition, make_portrait, make_scene, new_ink

FRAMES = 12
FPS = 6
KINDS = ["pan", "zoom", "expression", "sway", "move", "weather"]
WEIGHTS = {"pan": 0.17, "zoom": 0.15, "expression": 0.18, "sway": 0.14, "move": 0.16, "weather": 0.2}
HEAD = "color manga animation"


def _seed(rng) -> int:
    return int(rng.integers(2 ** 31))


def _nearest(img: np.ndarray, x0: int, y0: int, size: int, out: int) -> np.ndarray:
    idx = np.linspace(0, size - 1, out).round().astype(int)
    return img[y0 + idx][:, x0 + idx]


def _scene(rng, w: int, h: int):
    name = pick(rng, tuple(SCENES))
    ink = new_ink(w, h, True)
    tags = SCENES[name](ink, rng)
    return ink, tags


def _bust(seed: int, a: dict, size: int, fx: str | None, cx, cy, sc, tilt=0.0, expr=None, base=None) -> np.ndarray:
    """One character on a background effect (or on `base`), drawn from a fixed seed."""
    rng = np.random.default_rng(seed)
    ink = new_ink(size, size, True)
    if base is not None:
        ink.img.paste(base)
    elif fx:
        EFFECTS[fx](ink, rng)
    draw_character(ink, rng, a, cx, cy, sc, tilt=tilt, expr=expr)
    return ink.finish()


# --------------------------------------------------------------------------
# clips (each returns frames at size S2 and the caption)
# --------------------------------------------------------------------------

def clip_pan(rng, S2: int):
    W = int(S2 * 1.6)
    ink, tags = _scene(rng, W, S2)
    img = ink.finish()
    right = rng.random() < 0.5
    xs = np.linspace(0, W - S2, FRAMES).round().astype(int)
    if not right:
        xs = xs[::-1]
    frames = [img[:, x: x + S2] for x in xs]
    head = pick(rng, ("manga background", "anime scenery", "detailed environment"))
    return frames, [f"camera panning {'right' if right else 'left'}", _head(head, True)] + tags


def clip_zoom(rng, S2: int):
    big = 2 * S2
    if rng.random() < 0.5:
        img, cap, _ = make_portrait(rng, big, True)
        cy = 0.42
    else:
        img, cap, _ = make_scene(rng, big, True)
        cy = 0.5
    zoom_in = rng.random() < 0.5
    fr = np.linspace(1.0, 0.5, FRAMES)
    if not zoom_in:
        fr = fr[::-1]
    frames = []
    for f in fr:
        c = int(big * f)
        x0 = (big - c) // 2
        y0 = int(np.clip(cy * big - c / 2, 0, big - c))
        frames.append(_nearest(img, x0, y0, c, S2))
    return frames, [f"zooming {'in' if zoom_in else 'out'}"] + cap.split(", ")


def clip_expression(rng, S2: int):
    a = sample_character(rng, True)
    seed = _seed(rng)
    fx = pick(rng, (None, None, *EFFECTS))
    sc = S2 * rng.uniform(0.2, 0.3)
    cx, cy = S2 / 2 + rng.uniform(-0.05, 0.05) * S2, S2 * 0.42
    mode = pick(rng, ("change", "change", "talk", "blink"))
    if mode == "change":
        e1 = pick(rng, tuple(set(EXPRESSIONS)))
        e2 = pick(rng, tuple(e for e in set(EXPRESSIONS) if e != e1))
        seq = [e1] * (FRAMES // 2) + [e2] * (FRAMES - FRAMES // 2)
        what = f"character changing expression from {e1} to {e2}"
    elif mode == "talk":
        seq = ["neutral", "neutral", "surprised", "surprised"] * (FRAMES // 4)
        what = "character talking"
    else:
        seq = ["winking" if f in (5, 6) else "smiling" for f in range(FRAMES)]
        what = "character winking"
    cache = {e: _bust(seed, a, S2, fx, cx, cy, sc, expr=e) for e in set(seq)}
    tags = [t for t in character_tags(a, True) if t != a["expr"]] + ([fx] if fx else [])
    return [cache[e] for e in seq], [what, _head("manga portrait", True)] + tags


def clip_sway(rng, S2: int):
    a = sample_character(rng, True)
    seed = _seed(rng)
    fx = pick(rng, (None, None, *EFFECTS))
    sc = S2 * rng.uniform(0.18, 0.26)
    cx, cy = S2 / 2, S2 * 0.42
    amp = rng.uniform(0.1, 0.2)
    frames = [_bust(seed, a, S2, fx, cx, cy, sc, tilt=amp * math.sin(2 * math.pi * f / FRAMES)) for f in range(FRAMES)]
    tags = character_tags(a, True) + ([fx] if fx else [])
    return frames, ["character swaying", _head("manga portrait", True)] + tags


def clip_move(rng, S2: int):
    a = sample_character(rng, True)
    ink, tags = _scene(rng, S2, S2)
    base = ink.img.copy()
    seed = _seed(rng)
    right = rng.random() < 0.5
    sc = S2 * rng.uniform(0.12, 0.17)
    xs = np.linspace(0.2, 0.8, FRAMES) * S2
    if not right:
        xs = xs[::-1]
    cy = S2 * rng.uniform(0.5, 0.6)
    frames = [_bust(seed, a, S2, None, x, cy - sc * 0.15 * abs(math.sin(math.pi * f / 3)), sc, base=base)
              for f, x in enumerate(xs)]
    outfit = next(t for t in character_tags(a) if t.endswith(a["outfit"]))
    return frames, [f"character moving {'right' if right else 'left'}", _head("manga illustration", True),
                    a["expr"], outfit] + tags[:2]


def _particles(rng, kind: str, S2: int):
    n = {"rain": 70, "snow": 45, "petals": 30, "sparkles": 14}[kind]
    p = rng.uniform(0, S2, (n, 2))
    loops = rng.integers(1, 3, n)                    # whole trips across the frame per clip: the loop is seamless
    return p, loops


def clip_weather(rng, S2: int):
    maker = pick(rng, (make_scene, make_scene, make_portrait, make_composition))
    img, cap, _ = maker(rng, S2, True)
    kind = pick(rng, ("rain", "snow", "petals", "sparkles"))
    p, loops = _particles(rng, kind, S2)
    rain_c = pick(rng, (BLUE, BLACK))
    frames = []
    for f in range(FRAMES):
        im = Image.fromarray(img.copy(), mode="L")
        d = ImageDraw.Draw(im)
        t = f / FRAMES
        for (x, y), k in zip(p, loops):
            if kind == "rain":
                yy = (y + t * k * S2 * 2) % S2
                xx = (x - (yy - y) * 0.25) % S2
                d.line([(xx, yy), (xx - 3, yy + 12)], fill=rain_c, width=max(1, S2 // 200))
            elif kind == "snow":
                yy = (y + t * k * S2) % S2
                xx = x + 6 * math.sin(2 * math.pi * (t * k + x / S2))
                r = max(2, S2 // 90)
                d.ellipse([xx - r, yy - r, xx + r, yy + r], fill=WHITE, outline=BLACK)
            elif kind == "petals":
                yy = (y + t * k * S2) % S2
                xx = (x + t * k * S2 * 0.5) % S2
                a = 2 * math.pi * (t * k + x / S2)
                r = max(3, S2 // 60)
                pts = [(xx + r * math.cos(a + q) * (1 if q % math.pi == 0 else 0.45),
                        yy + r * math.sin(a + q) * (1 if q % math.pi == 0 else 0.45)) for q in (0, math.pi / 2, math.pi, 3 * math.pi / 2)]
                d.polygon(pts, fill=RED, outline=BLACK)
            else:
                r = max(3, S2 // 40) * (0.4 + 0.6 * abs(math.sin(math.pi * (t * k * 2 + x / S2))))
                d.polygon([(x, y - r), (x + r * 0.25, y - r * 0.25), (x + r, y), (x + r * 0.25, y + r * 0.25),
                           (x, y + r), (x - r * 0.25, y + r * 0.25), (x - r, y), (x - r * 0.25, y - r * 0.25)], fill=YELLOW, outline=BLACK)
        frames.append(np.asarray(im, dtype=np.uint8))
    what = {"rain": "falling rain", "snow": "falling snow", "petals": "falling petals", "sparkles": "twinkling sparkles"}[kind]
    return frames, [what] + cap.split(", ")


CLIPS = {"pan": clip_pan, "zoom": clip_zoom, "expression": clip_expression, "sway": clip_sway, "move": clip_move,
         "weather": clip_weather}


def sample(rng, size: int = 128) -> tuple[np.ndarray, str, str]:
    """-> (frames uint8 [FRAMES, size, size] palette indices, caption, kind)."""
    names = list(CLIPS)
    w = np.array([WEIGHTS[n] for n in names])
    kind = names[int(rng.choice(len(names), p=w / w.sum()))]
    frames, tags = CLIPS[kind](rng, 2 * size)
    clip = np.stack([palette.reduce(np.asarray(f, dtype=np.uint8), 2) for f in frames])
    return clip, ", ".join([HEAD] + [t for t in tags if t]), kind
