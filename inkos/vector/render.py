"""Rasterise an InkScript program to a pure black/white image.

The program lives on a 128 x 128 grid, so the same program renders at 256,
512 or 1024 pixels (or anything else) with identical content. Drawing happens
on a supersampled greyscale canvas which is then hard-thresholded, so the
result contains exactly two values and no anti-aliasing grey.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw

from . import lang
from .font import ADV, LINE_H, chars_per_line, glyph, wrap_text

STROKE = {1: 0.55, 2: 0.9, 3: 1.4, 4: 2.1}   # stroke weight -> grid units
MIN_STROKE_PX = 1.5                          # in output pixels
WOBBLE = 0.32                                # hand-drawn displacement, grid units


def _supersample(size: int) -> int:
    return 4 if size <= 256 else 3 if size <= 512 else 2


# --------------------------------------------------------------------------
# geometry helpers (all in grid units)
# --------------------------------------------------------------------------

def catmull_rom(pts, closed: bool = False) -> np.ndarray:
    """Smooth curve passing through every point."""
    p = np.asarray(pts, dtype=float)
    if len(p) < 3:
        return p
    if closed:
        ext = np.vstack([p[-1], p, p[0], p[1]])
        segs = len(p)
    else:
        ext = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
        segs = len(p) - 1
    out = []
    for i in range(segs):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        n = int(min(12, max(2, np.hypot(*(p2 - p1)) / 1.2 + 2)))
        t = np.linspace(0.0, 1.0, n, endpoint=False)[:, None]
        out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                          + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    out.append((p[0] if closed else p[-1])[None])
    return np.vstack(out)


def resample(p: np.ndarray, step: float) -> np.ndarray:
    p = np.asarray(p, dtype=float)
    if len(p) < 2:
        return p
    seg = np.hypot(*np.diff(p, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    if s[-1] < 1e-9:
        return p[:1]
    n = max(2, int(math.ceil(s[-1] / step)) + 1)
    t = np.linspace(0.0, s[-1], n)
    return np.stack([np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])], axis=1)


def wobble(p: np.ndarray, rng: np.random.Generator, amp: float = WOBBLE) -> np.ndarray:
    """Displace a path with slow noise so it looks drawn by hand."""
    p = resample(p, 1.2)
    if len(p) < 2:
        return p
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    out = p.copy()
    for ax in (0, 1):
        f1, f2 = rng.uniform(0.12, 0.3), rng.uniform(0.45, 0.85)
        a, b = rng.uniform(0, 2 * math.pi, 2)
        out[:, ax] += amp * (np.sin(f1 * s + a) + 0.4 * np.sin(f2 * s + b))
    return out


def dash_path(p: np.ndarray, on: float = 2.4, off: float = 1.8) -> list[np.ndarray]:
    p = resample(p, 0.4)
    if len(p) < 2:
        return []
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    out = []
    period = on + off
    k = 0
    while k * period < s[-1]:
        sel = (s >= k * period) & (s <= k * period + on)
        if sel.sum() >= 2:
            out.append(p[sel])
        k += 1
    return out


def ellipse_points(cx, cy, rx, ry, start: float = 0.0, turns: float = 1.0) -> np.ndarray:
    n = int(min(96, max(16, 2.2 * math.pi * max(rx, ry, 1) / 1.0)))
    a = start + np.linspace(0.0, 2 * math.pi * turns, n + 1)
    return np.stack([cx + rx * np.cos(a), cy + ry * np.sin(a)], axis=1)


# --------------------------------------------------------------------------
# canvas
# --------------------------------------------------------------------------

class _Canvas:
    def __init__(self, size: int, seed: int):
        self.size = size
        self.ss = _supersample(size)
        self.S = size * self.ss
        self.k = self.S / lang.GRID               # canvas px per grid unit
        self.img = Image.new("L", (self.S, self.S), 255)
        self.d = ImageDraw.Draw(self.img)
        self.rng = np.random.default_rng(seed)
        self.weight = 2
        self.color = 0
        self.dash = False
        self.hand = False

    def px(self, p: np.ndarray) -> list[tuple[float, float]]:
        q = (np.asarray(p, dtype=float) + 0.5) * self.k
        return [(float(x), float(y)) for x, y in q]

    def width_px(self, units: float) -> int:
        return max(1, int(round(max(MIN_STROKE_PX * self.ss, units * self.k))))

    def stroke(self, p: np.ndarray, units: float | None = None, closed: bool = False):
        """Draw one path with the current colour, round joins and round caps."""
        if len(p) == 0:
            return
        w = self.width_px(STROKE[self.weight] if units is None else units)
        pts = self.px(p)
        r = w / 2.0
        if len(pts) == 1 or (len(pts) == 2 and pts[0] == pts[1]):
            x, y = pts[0]
            self.d.ellipse((x - r, y - r, x + r, y + r), fill=self.color)
            return
        if closed:
            pts = pts + pts[1:2]
        self.d.line(pts, fill=self.color, width=w, joint="curve")
        if not closed and w >= 3:
            for x, y in (pts[0], pts[-1]):
                self.d.ellipse((x - r, y - r, x + r, y + r), fill=self.color)

    def path(self, p, closed: bool = False, units: float | None = None):
        """Stroke a path honouring HAND and DASH state."""
        p = np.asarray(p, dtype=float)
        if closed and len(p) and not np.allclose(p[0], p[-1]):
            p = np.vstack([p, p[:1]])
        if self.hand:
            p = wobble(p, self.rng)
        if self.dash:
            for seg in dash_path(p):
                self.stroke(seg, units)
        else:
            self.stroke(p, units, closed=closed and not self.hand)

    def fill(self, p):
        p = np.asarray(p, dtype=float)
        if self.hand:
            p = wobble(np.vstack([p, p[:1]]), self.rng, WOBBLE * 0.7)
        if len(p) >= 3:
            self.d.polygon(self.px(p), fill=self.color)

    def finish(self) -> Image.Image:
        small = self.img.resize((self.size, self.size), Image.BOX) if self.ss > 1 else self.img
        return small.point(lambda v: 255 if v >= 128 else 0).convert("1", dither=Image.Dither.NONE)


# --------------------------------------------------------------------------
# text
# --------------------------------------------------------------------------

def _draw_text(c: _Canvas, x: float, y: float, size: float, wrap: float, text: str):
    size = max(1.0, float(size))
    cpl = chars_per_line(size, wrap if wrap > 0 else lang.GRID)
    units = min(2.0, max(0.42, 0.085 * size))
    slant = c.rng.uniform(0.08, 0.2) if c.hand else 0.0
    drift = c.rng.uniform(-0.012, 0.012) if c.hand else 0.0
    for row, line in enumerate(wrap_text(text, cpl)):
        top = y + row * LINE_H * size
        if top > lang.GRID + size:
            break
        base = top + size
        for k, ch in enumerate(line):
            if ch == " ":
                continue
            ox = x + k * ADV * size
            oy = base + drift * k * size
            sc, rot, dx, dy = 1.0, 0.0, 0.0, 0.0
            if c.hand:
                sc = c.rng.uniform(0.93, 1.07)
                rot = c.rng.uniform(-0.05, 0.05)
                dx = c.rng.uniform(-0.03, 0.03) * size
                dy = c.rng.uniform(-0.045, 0.045) * size
            cr, sr = math.cos(rot), math.sin(rot)
            for st in glyph(ch):
                gx = st[:, 0] * sc + slant * st[:, 1]
                gy = st[:, 1] * sc
                if c.hand and len(st) > 1:
                    gx = gx + c.rng.normal(0, 0.012, len(st))
                    gy = gy + c.rng.normal(0, 0.012, len(st))
                rx = gx * cr - gy * sr
                ry = gx * sr + gy * cr
                p = np.stack([ox + dx + rx * size, oy + dy - ry * size], axis=1)
                c.stroke(p, units)


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------

def render(ops: list[tuple], prompt: str = "", size: int = 256, seed: int = 0) -> Image.Image:
    """Program -> PIL mode '1' image (white paper, black ink)."""
    c = _Canvas(size, seed)
    for op in ops:
        name = op[0]
        if name == "W":
            c.weight = int(min(4, max(1, op[1])))
        elif name == "INK":
            c.color = 0
        elif name == "ERASE":
            c.color = 255
        elif name == "SOLID":
            c.dash = False
        elif name == "DASH":
            c.dash = True
        elif name == "CLEAN":
            c.hand = False
        elif name == "HAND":
            c.hand = True
        elif name == "LINE":
            c.path(op[1])
        elif name == "CURVE":
            c.path(catmull_rom(op[1]))
        elif name == "POLY":
            c.path(op[1], closed=True)
        elif name == "BLOB":
            c.path(catmull_rom(op[1], closed=True), closed=True)
        elif name == "FILL":
            c.fill(op[1])
        elif name == "FBLOB":
            c.fill(catmull_rom(op[1], closed=True)[:-1])
        elif name in ("CIRC", "DISC", "ELLI"):
            if name == "ELLI":
                cx, cy, rx, ry = op[1:]
            else:
                cx, cy, rx = op[1:]
                ry = rx
            if name == "DISC":
                (x0, y0), (x1, y1) = c.px([(cx - rx, cy - ry), (cx + rx, cy + ry)])
                r_min = MIN_STROKE_PX * c.ss / 2
                if x1 - x0 < 2 * r_min:
                    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                    x0, y0, x1, y1 = mx - r_min, my - r_min, mx + r_min, my + r_min
                c.d.ellipse((x0, y0, x1, y1), fill=c.color)
            elif c.hand:
                start = c.rng.uniform(0, 2 * math.pi)
                c.path(ellipse_points(cx, cy, rx, ry, start, 1.04))
            else:
                c.path(ellipse_points(cx, cy, rx, ry), closed=True)
        elif name in ("RECT", "BOX"):
            x0, y0, x1, y1 = op[1:]
            x0, x1 = min(x0, x1), max(x0, x1)
            y0, y1 = min(y0, y1), max(y0, y1)
            corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            if name == "BOX":
                c.fill(corners)
            elif c.hand:
                for i in range(4):
                    a, b = np.array(corners[i], float), np.array(corners[(i + 1) % 4], float)
                    v = b - a
                    n = np.hypot(*v)
                    if n > 0:
                        v = v / n
                    c.path(np.stack([a - v * c.rng.uniform(0, 0.8), b + v * c.rng.uniform(0, 0.8)]))
            else:
                c.path(corners, closed=True)
        elif name == "TEXT":
            _, x, y, s, w, items = op
            _draw_text(c, x, y, s, w, lang.resolve_text(items, prompt))
    return c.finish()


def render_tokens(tokens, prompt: str = "", size: int = 256, seed: int = 0) -> tuple[Image.Image, list[tuple], bool]:
    ops, ok = lang.decode(tokens, len(prompt))
    return render(ops, prompt, size, seed), ops, ok
