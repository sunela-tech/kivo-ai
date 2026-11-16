"""INKOS MOTION 1: animated InkScript programs -> frames -> GIF.

A MOTION 1 program is an INKOS 1.1 program with two more state commands:

  ("AT", k)          the drawing commands that follow start at time slot k (0..15)
  ("ANIM", effect)   and appear or move with this effect:

    STILL   appear at once                 BLINK   appear, then blink on and off
    DRAW    drawn along their length;      SPIN    appear, then turn around their centre
            text is typed letter by letter BOUNCE  appear, then hop up and down
    POP     grow from their centre
    GROW    grow upwards from their base
    SLIDE   slide in from the left

Consecutive drawing commands with the same start and effect form a group that
moves as one (a spinning icon turns as a whole). A clip is FRAMES frames at
FPS; time runs from slot 0 to U_END, so the last starts finish with time to
spare and the finished picture holds at the end.

frame_ops() turns the program into the plain program of one frame, which the
ordinary rasteriser draws; the browser engine (cloud/public/engine/motion.js)
does exactly the same arithmetic.
"""
from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

from .. import palette
from . import lang
from .font import ADV, LINE_H, chars_per_line, wrap_text
from .render import catmull_rom, ellipse_points, render

FRAMES = 24
FPS = 8
U_END = 20.0          # time at the last frame, in slots
DUR = 3.0             # slots an entrance (DRAW, POP, GROW, SLIDE) takes
STATE = ("W", "INK", "ERASE", "SOLID", "DASH", "CLEAN", "HAND", "COLOR")


def frame_time(f: int, frames: int = FRAMES) -> float:
    return f * U_END / (frames - 1)


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def text_box(op, prompt: str) -> tuple[float, float, float, float]:
    _, x, y, s, w, items = op
    text = lang.resolve_text(items, prompt)
    s = max(1.0, float(s))
    cpl = chars_per_line(s, w if w > 0 else lang.GRID)
    rows = wrap_text(text, cpl) or [""]
    width = max(len(r) for r in rows) * ADV * s
    return x, y, x + width, y + len(rows) * LINE_H * s


def bbox(op, prompt: str) -> tuple[float, float, float, float]:
    name = op[0]
    if name in ("RECT", "BOX"):
        x0, y0, x1, y1 = op[1:]
        return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)
    if name in ("CIRC", "DISC"):
        cx, cy, r = op[1:]
        return cx - r, cy - r, cx + r, cy + r
    if name == "ELLI":
        cx, cy, rx, ry = op[1:]
        return cx - rx, cy - ry, cx + rx, cy + ry
    if name == "TEXT":
        return text_box(op, prompt)
    xs, ys = [p[0] for p in op[1]], [p[1] for p in op[1]]
    return min(xs), min(ys), max(xs), max(ys)


def _union(boxes):
    b = np.array(boxes, dtype=float)
    return b[:, 0].min(), b[:, 1].min(), b[:, 2].max(), b[:, 3].max()


class Affine:
    """p -> pivot + R(theta) (S (p - pivot)) + (dx, dy)"""

    def __init__(self, pivot=(0.0, 0.0), sx=1.0, sy=1.0, theta=0.0, dx=0.0, dy=0.0):
        self.px, self.py = pivot
        self.sx, self.sy, self.theta, self.dx, self.dy = sx, sy, theta, dx, dy
        self.c, self.s = math.cos(theta), math.sin(theta)

    def __call__(self, x, y):
        ux, uy = (x - self.px) * self.sx, (y - self.py) * self.sy
        return (self.px + self.c * ux - self.s * uy + self.dx, self.py + self.s * ux + self.c * uy + self.dy)

    def pts(self, pts):
        return [self(x, y) for x, y in pts]


def _ring(cx, cy, rx, ry, n=24):
    a = np.arange(n) * 2 * math.pi / n
    return [(cx + rx * math.cos(t), cy + ry * math.sin(t)) for t in a]


def transform(op, A: Affine):
    """The op moved by A; shapes that cannot express the move become polygons."""
    name = op[0]
    turned = abs(A.theta) > 1e-9
    if name in ("LINE", "CURVE", "POLY", "BLOB", "FILL", "FBLOB"):
        return (name, A.pts(op[1]))
    if name in ("CIRC", "DISC"):
        cx, cy, r = op[1:]
        x, y = A(cx, cy)
        if abs(A.sx - A.sy) < 1e-9:
            return (name, x, y, r * abs(A.sx))
        if name == "CIRC":
            return ("ELLI", x, y, r * abs(A.sx), r * abs(A.sy))
        return ("FILL", A.pts(_ring(cx, cy, r, r)))
    if name == "ELLI":
        cx, cy, rx, ry = op[1:]
        if turned:
            return ("POLY", A.pts(_ring(cx, cy, rx, ry)))
        x, y = A(cx, cy)
        return ("ELLI", x, y, rx * abs(A.sx), ry * abs(A.sy))
    if name in ("RECT", "BOX"):
        x0, y0, x1, y1 = op[1:]
        if turned:
            return ("POLY" if name == "RECT" else "FILL", A.pts([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]))
        (a, b), (c, d) = A(x0, y0), A(x1, y1)
        return (name, a, b, c, d)
    if name == "TEXT":                              # lettering scales and moves, it does not turn
        _, x, y, s, w, items = op
        k = math.sqrt(abs(A.sx * A.sy))
        nx, ny = A(x, y) if not turned else (x + A.dx, y + A.dy)
        return ("TEXT", nx, ny, s * k, w * k if w > 0 else w, items)
    return op


def _cut(pts, frac):
    """The first frac of a polyline, by length."""
    p = np.asarray(pts, dtype=float)
    if len(p) < 2 or frac >= 1:
        return [tuple(v) for v in p]
    seg = np.hypot(*np.diff(p, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    want = frac * s[-1]
    k = int(np.searchsorted(s, want, side="right"))
    out = [tuple(v) for v in p[:k]]
    if k < len(p) and seg[k - 1] > 0:
        t = (want - s[k - 1]) / seg[k - 1]
        out.append(tuple(p[k - 1] + t * (p[k] - p[k - 1])))
    return out if len(out) >= 2 else [tuple(p[0]), tuple(p[0])]


def draw_on(op, p: float, prompt: str):
    """The op drawn up to fraction p (pen strokes along their length, text letter by letter)."""
    name = op[0]
    if p >= 1:
        return op
    if name == "TEXT":
        _, x, y, s, w, items = op
        n = math.ceil(p * len(lang.resolve_text(items, prompt)))
        kept = []
        for it in items:
            if n <= 0:
                break
            if isinstance(it, str):
                kept.append(it[:n])
                n -= len(it)
            else:
                i, j = it
                m = j - i + 1
                kept.append((i, i + min(m, n) - 1))
                n -= m
        return ("TEXT", x, y, s, w, kept) if kept else None
    if name == "LINE":
        line = op[1]
    elif name == "CURVE":
        line = catmull_rom(op[1])
    elif name == "POLY":
        line = list(op[1]) + [op[1][0]]
    elif name == "BLOB":
        line = catmull_rom(op[1], closed=True)
    elif name == "RECT":
        x0, y0, x1, y1 = op[1:]
        line = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    elif name in ("CIRC", "ELLI"):
        cx, cy = op[1], op[2]
        rx = op[3]
        ry = op[4] if name == "ELLI" else rx
        line = ellipse_points(cx, cy, rx, ry, -math.pi / 2, 1.0)
    else:                                            # filled shapes grow instead
        return None
    if p <= 0:
        return None
    return ("LINE", _cut(line, p))


# --------------------------------------------------------------------------
# one frame
# --------------------------------------------------------------------------

def groups(ops: list[tuple]) -> list[dict]:
    """Split a program into groups: {'start', 'effect', 'items': [(index, op)]}."""
    out, cur = [], None
    at, eff = 0, "STILL"
    for i, op in enumerate(ops):
        if op[0] == "AT":
            at, cur = int(op[1]), None
        elif op[0] == "ANIM":
            eff, cur = op[1], None
        elif op[0] in STATE:
            continue
        else:
            if cur is None:
                cur = {"start": at, "effect": eff, "items": []}
                out.append(cur)
            cur["items"].append((i, op))
    return out


def frame_ops(ops: list[tuple], prompt: str, u: float) -> list[tuple]:
    """The plain (INKOS 1.1) program that shows the clip at time u."""
    shown: dict[int, tuple | None] = {}
    for g in groups(ops):
        t = u - g["start"]
        eff = g["effect"]
        items = g["items"]
        if t < 0 or (eff == "BLINK" and int(math.floor(t / 2)) % 2 == 1):
            for i, _ in items:
                shown[i] = None
            continue
        p = min(1.0, t / DUR)
        e = 1 - (1 - p) ** 2
        x0, y0, x1, y1 = _union([bbox(op, prompt) for _, op in items])
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        A = None
        if eff == "POP":
            A = Affine((cx, cy), e, e)
        elif eff == "GROW":
            A = Affine((cx, y1), 1.0, e)
        elif eff == "SLIDE":
            A = Affine(dx=-(1 - e) * (x1 + 2))
        elif eff == "SPIN":
            A = Affine((cx, cy), theta=2 * math.pi * t / 8)
        elif eff == "BOUNCE":
            A = Affine(dy=-6 * abs(math.sin(math.pi * t / 4)))
        for i, op in items:
            if eff == "DRAW":
                new = draw_on(op, p, prompt)
                if new is None and op[0] in ("FILL", "FBLOB", "BOX", "DISC") and e > 0.02:
                    new = transform(op, Affine((cx, cy), e, e))
            elif A is not None:
                if eff in ("POP", "GROW") and e <= 0.02:
                    new = None
                else:
                    new = transform(op, A)
            else:
                new = op
            shown[i] = new
    out = []
    for i, op in enumerate(ops):
        if op[0] in ("AT", "ANIM"):
            continue
        if i in shown:
            if shown[i] is not None:
                out.append(shown[i])
        else:
            out.append(op)
    return out


def render_frames(ops: list[tuple], prompt: str = "", size: int = 256, seed: int = 0,
                  frames: int = FRAMES) -> list[Image.Image]:
    """Every frame of the clip, as six-colour palette images."""
    return [render(frame_ops(ops, prompt, frame_time(f, frames)), prompt, size, seed, color=True) for f in range(frames)]


def is_animated(ops: list[tuple]) -> bool:
    return any(op[0] in ("AT", "ANIM") for op in ops)


# --------------------------------------------------------------------------
# GIF
# --------------------------------------------------------------------------

def gif_bytes(frames: list, fps: int = FPS) -> bytes:
    """Frames (palette images or [H,W] palette-index arrays) -> a looping GIF in the six E-Ink colours."""
    pal = [v for c in palette.RGB for v in c] + [255, 255, 255] * 2       # GIF palettes have 2^n entries
    ims = []
    for f in frames:
        a = np.asarray(f, dtype=np.uint8)
        im = Image.fromarray(a, mode="P")
        im.putpalette(pal)
        ims.append(im)
    buf = io.BytesIO()
    delay = int(100 / fps + 0.5) * 10           # GIF delays are whole hundredths of a second (as in the browser's encoder)
    ims[0].save(buf, format="GIF", save_all=True, append_images=ims[1:], duration=delay, loop=0,
                optimize=False, disposal=1)
    return buf.getvalue()
