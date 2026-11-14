"""Backgrounds, effects, props, speech bubbles and page layouts for the
procedural manga set, and the top-level sample() that returns one training
image with its caption.

Every scene works at any canvas size (it reads ink.w / ink.h), which is what
lets the same code fill a square picture or a narrow comic panel.
"""
from __future__ import annotations

import math

import numpy as np

from ..vector.font import ADV, glyph
from .manga_chars import (character_tags, draw_character, draw_chibi, ell, pick, sample_character,
                          short_description)
from .manga_draw import Ink, frame

KINDS = ["portrait", "chibi", "scene", "page", "object", "composition", "import"]
BUBBLE_WORDS = ("...", "!?", "OK!", "NO!", "HEY", "WOW", "YES", "HUH?", "WAIT", "GO!", "HA HA", "WHAT?", "HM...",
                "OH!", "RUN!", "HELLO", "LOOK!", "NICE", "THANKS", "SORRY", "WHY?", "NOW!")
SFX_WORDS = ("BAM", "DON", "ZAA", "GOGO", "WHAM", "ZOOM", "CRASH", "BOOM", "SWISH", "THUD")


# --------------------------------------------------------------------------
# small parts
# --------------------------------------------------------------------------

def text(ink: Ink, x, y, size, s: str, width: float = 1.6, color: int = 0, rot: float = 0.0):
    """Stroke-font lettering; (x, y) is the top-left corner."""
    c, sn = math.cos(rot), math.sin(rot)
    for k, ch in enumerate(s):
        for st in glyph(ch):
            gx = k * ADV * size + st[:, 0] * size
            gy = size - st[:, 1] * size
            ink.line(np.stack([x + gx * c - gy * sn, y + gx * sn + gy * c], axis=1), width, color)


def cloud(ink: Ink, rng, cx, cy, w, tone: float = 0.0):
    h = w * rng.uniform(0.28, 0.4)
    pts = [(cx - w / 2, cy + h * 0.4), (cx - w * 0.36, cy - h * 0.1), (cx - w * 0.2, cy - h * 0.5),
           (cx + w * 0.05, cy - h * 0.62), (cx + w * 0.27, cy - h * 0.3), (cx + w * 0.47, cy), (cx + w / 2, cy + h * 0.4)]
    ink.shape(pts, 255, tone, 1.8, smooth=True)


def star4(ink: Ink, cx, cy, r, color=0):
    pts = []
    for i in range(8):
        rr = r if i % 2 == 0 else r * 0.22
        a = math.radians(45 * i - 90)
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    ink.fill(pts, color)


def pine(ink: Ink, x, base, h, black=False):
    ink.shape([(x - h * 0.04, base), (x + h * 0.04, base), (x + h * 0.04, base - h * 0.2), (x - h * 0.04, base - h * 0.2)], 0, 0, 0)
    for k, (top, wd, bot) in enumerate(((1.0, 0.16, 0.62), (0.75, 0.24, 0.36), (0.5, 0.32, 0.12))):
        ink.shape([(x, base - h * top), (x + h * wd, base - h * bot), (x - h * wd, base - h * bot)],
                  0 if black else 255, 0 if black else 0.3, 1.6)


def round_tree(ink: Ink, rng, x, base, h):
    ink.shape([(x - h * 0.05, base), (x + h * 0.05, base), (x + h * 0.035, base - h * 0.5), (x - h * 0.035, base - h * 0.5)], 255, 0, 1.6)
    crown = [(x + h * 0.36 * math.cos(a) * rng.uniform(0.85, 1.1), base - h * 0.68 + h * 0.3 * math.sin(a) * rng.uniform(0.85, 1.1))
             for a in np.linspace(0, 2 * math.pi, 9, endpoint=False)]
    ink.shape(crown, 255, pick(rng, (0.0, 0.3, 0.45)), 1.8, smooth=True)


def bubble(ink: Ink, rng, cx, cy, rx, ry, tail_to=None, kind: str | None = None, word: str | None = None):
    kind = kind or pick(rng, ("round", "round", "shout", "thought"))
    word = word or pick(rng, BUBBLE_WORDS)
    if kind == "shout":
        pts = []
        for i in range(28):
            r = 1.0 if i % 2 == 0 else rng.uniform(1.2, 1.45)
            a = 2 * math.pi * i / 28
            pts.append((cx + rx * r * math.cos(a), cy + ry * r * math.sin(a)))
        ink.shape(pts, 255, 0, 2.0)
    elif kind == "thought":
        for a in np.linspace(0, 2 * math.pi, 11, endpoint=False):
            ink.ellipse(cx + rx * 0.82 * math.cos(a), cy + ry * 0.82 * math.sin(a), rx * 0.34, ry * 0.36, 255, 0, 2.0)
        ink.ellipse(cx, cy, rx * 0.9, ry * 0.9, 255, 0, 0)
        if tail_to is not None:
            for k, r in ((0.35, 0.12), (0.62, 0.07)):
                ink.ellipse(cx + (tail_to[0] - cx) * (1 + k) * 0.6, cy + (tail_to[1] - cy) * (1 + k) * 0.6,
                            rx * r, rx * r, 255, 0, 1.6)
    else:
        if tail_to is not None:
            a = math.atan2(tail_to[1] - cy, tail_to[0] - cx)
            p1 = (cx + rx * 0.8 * math.cos(a - 0.3), cy + ry * 0.8 * math.sin(a - 0.3))
            p2 = (cx + rx * 0.8 * math.cos(a + 0.3), cy + ry * 0.8 * math.sin(a + 0.3))
            ink.shape([p1, tail_to, p2], 255, 0, 2.0)
        ink.ellipse(cx, cy, rx, ry, 255, 0, 2.0)
        if tail_to is not None:
            ink.fill([p1, ((p1[0] + p2[0]) / 2 + (cx - tail_to[0]) * 0.1, (p1[1] + p2[1]) / 2 + (cy - tail_to[1]) * 0.1), p2], 255)
    size = min(ry * 0.7, rx * 1.5 / max(1, len(word) * ADV))
    text(ink, cx - len(word) * ADV * size / 2, cy - size / 2, size, word, max(1.3, size * 0.11))


def sfx(ink: Ink, rng, x, y, size):
    word = pick(rng, SFX_WORDS)
    rot = rng.uniform(-0.35, 0.1)
    text(ink, x, y, size, word, size * 0.2, 255, rot)
    text(ink, x, y, size, word, size * 0.13, 0, rot)
    return word


# --------------------------------------------------------------------------
# background effects (drawn behind a character)
# --------------------------------------------------------------------------

def fx_speed_lines(ink: Ink, rng, cx=None, cy=None):
    W, H = ink.w, ink.h
    cx, cy = cx if cx is not None else W / 2, cy if cy is not None else H * 0.42
    R = math.hypot(W, H)
    for _ in range(int(rng.integers(60, 120))):
        a = rng.uniform(0, 2 * math.pi)
        r_in = min(W, H) * rng.uniform(0.34, 0.5)
        wd = rng.uniform(0.004, 0.02)
        ink.fill([(cx + R * math.cos(a - wd), cy + R * math.sin(a - wd)), (cx + R * math.cos(a + wd), cy + R * math.sin(a + wd)),
                  (cx + r_in * math.cos(a), cy + r_in * math.sin(a))], 0)


def fx_motion_lines(ink: Ink, rng):
    W, H = ink.w, ink.h
    for _ in range(int(rng.integers(30, 70))):
        y = rng.uniform(0, H)
        x0 = rng.uniform(-0.2, 0.7) * W
        ln = rng.uniform(0.25, 0.9) * W
        ink.stroke([(x0, y), (x0 + ln, y)], rng.uniform(1.0, 4.0), 0, 0.05)


def fx_tone(ink: Ink, rng):
    W, H = ink.w, ink.h
    a, b = sorted(rng.uniform(0.05, 0.7, 2))
    if rng.random() < 0.5:
        a, b = b, a
    ink.tone_gradient(0, 0, W, H, a, b, vertical=rng.random() < 0.7)


def fx_sparkles(ink: Ink, rng):
    W, H = ink.w, ink.h
    if rng.random() < 0.4:
        ink.tone_gradient(0, 0, W, H, 0.35, 0.1)
    for _ in range(int(rng.integers(7, 16))):
        x, y, r = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(0.02, 0.07) * min(W, H)
        if rng.random() < 0.65:
            star4(ink, x, y, r, 0)
        else:
            ink.ellipse(x, y, r * 0.5, r * 0.5, 255, 0, 1.6)


def fx_flowers(ink: Ink, rng):
    W, H = ink.w, ink.h
    for _ in range(int(rng.integers(5, 11))):
        x, y, r = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(0.035, 0.075) * min(W, H)
        for k in range(5):
            a = 2 * math.pi * k / 5 + 0.3
            ink.ellipse(x + r * math.cos(a), y + r * math.sin(a), r * 0.62, r * 0.62, 255, 0, 1.5)
        ink.ellipse(x, y, r * 0.34, r * 0.34, 0, 0, 0)


def fx_burst(ink: Ink, rng):
    W, H = ink.w, ink.h
    ink.fill([(0, 0), (W, 0), (W, H), (0, H)], 0 if rng.random() < 0.5 else 255, 0.0 if rng.random() < 0.5 else 0.5)
    if ink.img.getpixel((0, 0)) == 255 and ink.tone.getpixel((0, 0)) == 0:
        ink.tone_only([(0, 0), (W, 0), (W, H), (0, H)], 0.5)
    pts = []
    for i in range(36):
        r = (0.5 if i % 2 == 0 else rng.uniform(0.62, 0.78)) * max(W, H)
        a = 2 * math.pi * i / 36
        pts.append((W / 2 + r * math.cos(a), H * 0.45 + r * math.sin(a)))
    ink.shape(pts, 255, 0, 2.4)


EFFECTS = {"speed lines": fx_speed_lines, "motion lines": fx_motion_lines, "screentone background": fx_tone,
           "sparkles": fx_sparkles, "flowers": fx_flowers, "impact burst": fx_burst}


# --------------------------------------------------------------------------
# environments
# --------------------------------------------------------------------------

def _windows(ink: Ink, rng, x0, y0, x1, y1, lit_color=255, frame_w=1.2):
    cols = max(1, int((x1 - x0) / rng.uniform(13, 22)))
    rows = max(1, int((y1 - y0) / rng.uniform(16, 26)))
    cw, rh = (x1 - x0) / cols, (y1 - y0) / rows
    for r in range(rows):
        for c in range(cols):
            if rng.random() < 0.12:
                continue
            ax, ay = x0 + c * cw + cw * 0.22, y0 + r * rh + rh * 0.22
            ink.shape([(ax, ay), (ax + cw * 0.56, ay), (ax + cw * 0.56, ay + rh * 0.56), (ax, ay + rh * 0.56)],
                      lit_color, 0, frame_w)


def _skyline(ink: Ink, rng, base, max_h, min_w=36, max_w=92, style="mixed"):
    W = ink.w
    x = -rng.uniform(0, 30)
    while x < W:
        bw = rng.uniform(min_w, max_w)
        bh = rng.uniform(0.3, 1.0) * max_h
        st = pick(rng, ("white", "tone", "black")) if style == "mixed" else style
        fill, tone = {"white": (255, 0.0), "tone": (255, 0.35), "black": (0, 0.0)}[st]
        ink.shape([(x, base), (x, base - bh), (x + bw, base - bh), (x + bw, base)], fill, tone, 2.0)
        if bh > 40 and bw > 24:
            _windows(ink, rng, x + 4, base - bh + 6, x + bw - 4, base - 4, 0 if st == "white" else 255, 0 if st == "black" else 1.0)
        if rng.random() < 0.3:
            ink.line([(x + bw * 0.5, base - bh), (x + bw * 0.5, base - bh - rng.uniform(10, 30))], 1.6)
        x += bw + rng.uniform(-4, 10)


def scene_skyline(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    tags = ["city skyline"]
    hz = H * rng.uniform(0.62, 0.8)
    if rng.random() < 0.5:
        ink.tone_gradient(0, 0, W, hz, rng.uniform(0.3, 0.6), 0.0)
        tags.append("evening sky")
    r = min(W, H) * rng.uniform(0.06, 0.11)
    ink.ellipse(W * rng.uniform(0.15, 0.85), H * rng.uniform(0.12, 0.3), r, r, 255, 0, 2.0)
    for _ in range(int(rng.integers(1, 4))):
        cloud(ink, rng, rng.uniform(0, W), H * rng.uniform(0.08, 0.4), W * rng.uniform(0.18, 0.34))
    _skyline(ink, rng, hz, H * 0.32, style="tone")
    _skyline(ink, rng, hz + H * 0.04, H * 0.5)
    ink.fill([(0, hz + H * 0.04), (W, hz + H * 0.04), (W, H), (0, H)], 255)
    ink.line([(0, hz + H * 0.04), (W, hz + H * 0.04)], 2.2)
    for k in range(int(rng.integers(3, 8))):
        y = hz + H * 0.07 + k * H * 0.03
        ink.line([(rng.uniform(0, W * 0.4), y), (rng.uniform(W * 0.5, W), y)], 1.2)
    for _ in range(int(rng.integers(0, 5))):
        x, y, s = rng.uniform(0, W), rng.uniform(0.05, 0.35) * H, rng.uniform(5, 10)
        ink.line([(x - s, y - s * 0.5), (x, y), (x + s, y - s * 0.5)], 1.4)
    return tags


def scene_street(ink: Ink, rng) -> list[str]:
    """One-point perspective street between two rows of buildings."""
    W, H = ink.w, ink.h
    vx, vy = W * rng.uniform(0.38, 0.62), H * rng.uniform(0.36, 0.5)
    lerp = lambda a, b, t: (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    if rng.random() < 0.4:
        ink.tone_gradient(0, 0, W, vy, 0.4, 0.05)
    for _ in range(int(rng.integers(1, 3))):
        cloud(ink, rng, rng.uniform(0.2, 0.8) * W, vy * rng.uniform(0.2, 0.7), W * rng.uniform(0.15, 0.3))
    for side, xe in ((-1, 0.0), (1, float(W))):
        t0 = 0.0
        while t0 < 0.82:
            t1 = min(0.9, t0 + rng.uniform(0.18, 0.4))
            top = rng.uniform(-0.5, 0.18) * H
            a, b = (xe, top), (xe, float(H))
            quad = [lerp(a, (vx, vy), t0), lerp(a, (vx, vy), t1), lerp(b, (vx, vy), t1), lerp(b, (vx, vy), t0)]
            tone = pick(rng, (0.0, 0.0, 0.3, 0.45)) if side == 1 else pick(rng, (0.0, 0.0, 0.25))
            ink.shape(quad, 255, tone, 2.2)
            rows, cols = int(rng.integers(3, 7)), int(rng.integers(2, 5))
            for r in range(rows):
                for c in range(cols):
                    ta = t0 + (t1 - t0) * (c + 0.2) / cols
                    tb = t0 + (t1 - t0) * (c + 0.75) / cols
                    sa, sb = (r + 0.2) / (rows + 0.6), (r + 0.72) / (rows + 0.6)
                    pa, pb = lerp(a, b, sa), lerp(a, b, sb)
                    ink.shape([lerp(pa, (vx, vy), ta), lerp(pa, (vx, vy), tb), lerp(pb, (vx, vy), tb), lerp(pb, (vx, vy), ta)],
                              0 if rng.random() < 0.3 else 255, 0, 1.2)
            t0 = t1
    ink.line([(vx, vy), (W * 0.18, H)], 2.0)
    ink.line([(vx, vy), (W * 0.82, H)], 2.0)
    for k in range(6):
        ta, tb = 1 - 0.62 ** k * 0.95, 1 - 0.62 ** k * 0.75
        m = (W * 0.5, float(H))
        p, q2 = lerp(m, (vx, vy), ta), lerp(m, (vx, vy), tb)
        ink.stroke([p, q2], max(1.0, 6 * (1 - ta)), 0, 0.6)
    return ["city street", "perspective"]


def scene_room(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    x0, y0, x1, y1 = W * 0.22, H * 0.2, W * 0.78, H * 0.68
    tags = ["room interior"]
    if rng.random() < 0.5:
        ink.tone_only([(0, 0), (x0, y0), (x0, y1), (0, H)], 0.3)
    ink.shape([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], 255, 0, 2.2)
    for a, b in (((x0, y0), (0, 0)), ((x1, y0), (W, 0)), ((x0, y1), (0, H)), ((x1, y1), (W, H))):
        ink.line([a, b], 2.2)
    for k in range(1, 7):
        xb = x0 + (x1 - x0) * k / 7
        ink.line([(xb, y1), (W * (-0.6 + 2.2 * k / 7), H)], 1.1)
    wx0, wy0, wx1, wy1 = W * 0.34, H * 0.27, W * 0.58, H * 0.52
    ink.tone_gradient(wx0, wy0, wx1, wy1, 0.3, 0.05)
    cloud(ink, rng, (wx0 + wx1) / 2, wy0 + (wy1 - wy0) * 0.4, (wx1 - wx0) * 0.6)
    ink.fill([(x0, y0), (wx0, y0), (wx0, y1), (x0, y1)], None, 0)
    ink.line([(wx0, wy0), (wx1, wy0), (wx1, wy1), (wx0, wy1)], 2.6, closed=True)
    ink.line([((wx0 + wx1) / 2, wy0), ((wx0 + wx1) / 2, wy1)], 1.8)
    ink.line([(wx0, (wy0 + wy1) / 2), (wx1, (wy0 + wy1) / 2)], 1.8)
    tags.append("window")
    if rng.random() < 0.6:
        for sx, dx in ((wx0, -1), (wx1, 1)):
            ink.shape([(sx, wy0 - 6), (sx + dx * W * 0.06, wy0 - 6), (sx + dx * W * 0.045, wy1 + 14), (sx + dx * W * 0.01, wy1 + 8)],
                      255, 0.25, 1.8, smooth=False)
        tags.append("curtains")
    if rng.random() < 0.7:
        dx0, dx1, dy = W * 0.6, W * 0.95, H * 0.7
        ink.shape([(dx0, dy), (dx1, dy + H * 0.03), (dx1, dy + H * 0.07), (dx0, dy + H * 0.04)], 255, 0, 2.0)
        ink.shape([(dx0 - W * 0.04, dy - H * 0.035), (dx1 - W * 0.02, dy - H * 0.02), (dx1, dy + H * 0.03), (dx0, dy)], 255, 0.2, 2.0)
        ink.line([(dx0 + 4, dy + H * 0.04), (dx0 + 4, H * 0.95)], 2.2)
        ink.line([(dx1 - 4, dy + H * 0.07), (dx1 - 4, H)], 2.2)
        tags.append("desk")
    if rng.random() < 0.6:
        sx0, sx1, sy0, sy1 = W * 0.62, W * 0.75, H * 0.27, H * 0.5
        ink.shape([(sx0, sy0), (sx1, sy0), (sx1, sy1), (sx0, sy1)], 255, 0, 2.0)
        for k in range(1, 3):
            ink.line([(sx0, sy0 + (sy1 - sy0) * k / 3), (sx1, sy0 + (sy1 - sy0) * k / 3)], 1.6)
        for k in range(3):
            x = sx0 + 3
            while x < sx1 - 6:
                bw = rng.uniform(4, 9)
                top = sy0 + (sy1 - sy0) * k / 3 + rng.uniform(4, 9)
                ink.shape([(x, top), (x + bw, top), (x + bw, sy0 + (sy1 - sy0) * (k + 1) / 3), (x, sy0 + (sy1 - sy0) * (k + 1) / 3)],
                          pick(rng, (255, 255, 0)), 0, 1.0)
                x += bw
        tags.append("bookshelf")
    return tags


def scene_landscape(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    tags = ["landscape", "mountains"]
    hz = H * rng.uniform(0.52, 0.66)
    if rng.random() < 0.4:
        ink.tone_gradient(0, 0, W, hz, 0.35, 0.0)
    r = min(W, H) * 0.07
    sx, sy = W * rng.uniform(0.15, 0.85), H * rng.uniform(0.1, 0.25)
    ink.ellipse(sx, sy, r, r, 255, 0, 2.0)
    for _ in range(int(rng.integers(1, 4))):
        cloud(ink, rng, rng.uniform(0, W), H * rng.uniform(0.08, 0.3), W * rng.uniform(0.16, 0.3))
    for layer in range(2):
        x = -W * 0.1
        ridge = [(x, hz)]
        while x < W * 1.1:
            x += W * rng.uniform(0.12, 0.26)
            ridge.append((x - W * 0.08, hz - H * rng.uniform(0.18, 0.4) * (1 - 0.35 * layer)))
            ridge.append((x, hz - H * rng.uniform(0.02, 0.1)))
        ridge.append((W * 1.2, hz))
        ink.shape(ridge, 255, 0.3 if layer == 0 else 0.0, 2.0)
        if layer == 1:
            for i in range(1, len(ridge) - 1, 2):
                px, py = ridge[i]
                for k in range(4):
                    ink.line([(px + 6 + k * 9, py + 14 + k * 12), (px + 2 + k * 7, hz - 2)], 1.0)
    ink.fill([(0, hz), (W, hz), (W, H), (0, H)], 255)
    ink.line([(0, hz), (W, hz)], 2.0)
    if rng.random() < 0.5:
        ink.shape(ell(W * rng.uniform(0.3, 0.7), hz + H * 0.14, W * 0.3, H * 0.07), 255, 0.15, 1.8)
        tags.append("lake")
    else:
        px = W * rng.uniform(0.3, 0.7)
        ink.curve([(px - W * 0.03, hz), (px - W * 0.1, hz + H * 0.15), (px - W * 0.3, H)], 1.8, taper=None)
        ink.curve([(px + W * 0.03, hz), (px + W * 0.05, hz + H * 0.15), (px + W * 0.12, H)], 1.8, taper=None)
        tags.append("path")
    for _ in range(int(rng.integers(3, 9))):
        x, base = rng.uniform(0, W), hz + H * rng.uniform(0.04, 0.32)
        h = H * 0.12 + (base - hz) * 0.9
        if rng.random() < 0.55:
            pine(ink, x, base, h, rng.random() < 0.4)
        else:
            round_tree(ink, rng, x, base, h)
    tags.append("trees")
    for _ in range(int(rng.integers(6, 16))):
        x, y = rng.uniform(0, W), rng.uniform(hz + 8, H)
        ink.line([(x - 3, y), (x - 1, y - 7)], 1.1)
        ink.line([(x + 3, y), (x + 1, y - 8)], 1.1)
    return tags


def scene_sea(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    hz = H * rng.uniform(0.4, 0.55)
    tags = ["sea", "horizon"]
    if rng.random() < 0.5:
        ink.tone_gradient(0, 0, W, hz, 0.4, 0.05)
        tags.append("sunset")
    sx, r = W * rng.uniform(0.25, 0.75), min(W, H) * rng.uniform(0.08, 0.14)
    ink.ellipse(sx, hz - r * rng.uniform(0.0, 1.2), r, r, 255, 0, 2.2)
    for _ in range(int(rng.integers(1, 4))):
        cloud(ink, rng, rng.uniform(0, W), hz * rng.uniform(0.15, 0.6), W * rng.uniform(0.16, 0.3))
    ink.fill([(0, hz), (W, hz), (W, H), (0, H)], 255)
    ink.line([(0, hz), (W, hz)], 2.0)
    for k in range(9):
        y = hz + 6 + (H - hz) * (k / 9) ** 1.4
        half = 4 + k * 5
        ink.line([(sx - half, y), (sx + half, y)], 1.0 + k * 0.25)
    for k in range(int(rng.integers(12, 26))):
        f = rng.uniform(0, 1)
        y, x, s = hz + 8 + (H - hz - 12) * f, rng.uniform(0, W), 8 + 26 * f
        ink.curve([(x - s, y), (x - s * 0.4, y - s * 0.22), (x, y), (x + s * 0.5, y - s * 0.2), (x + s, y)], 1.2 + f, taper=0.2)
    if rng.random() < 0.6:
        bx, by, s = W * rng.uniform(0.15, 0.85), hz + (H - hz) * rng.uniform(0.1, 0.4), H * rng.uniform(0.07, 0.13)
        ink.shape([(bx - s, by), (bx + s, by), (bx + s * 0.65, by + s * 0.4), (bx - s * 0.65, by + s * 0.4)], 255, 0, 2.0)
        ink.line([(bx, by), (bx, by - s * 1.5)], 2.0)
        ink.shape([(bx + 3, by - s * 1.45), (bx + s * 0.85, by - s * 0.15), (bx + 3, by - s * 0.15)], 255, 0.2, 1.8)
        tags.append("sailboat")
    for _ in range(int(rng.integers(0, 5))):
        x, y, s = rng.uniform(0, W), rng.uniform(0.05, 0.8) * hz, rng.uniform(5, 10)
        ink.line([(x - s, y - s * 0.5), (x, y), (x + s, y - s * 0.5)], 1.4)
    return tags


def scene_night(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    tags = ["night sky", "stars"]
    ink.fill([(0, 0), (W, 0), (W, H), (0, H)], 0)
    for _ in range(int(rng.integers(40, 110))):
        x, y = rng.uniform(0, W), rng.uniform(0, H * 0.8)
        if rng.random() < 0.15:
            star4(ink, x, y, rng.uniform(4, 9), 255)
        else:
            r = rng.uniform(0.8, 1.8)
            ink.ellipse(x, y, r, r, 255, 0, 0, n=8)
    mx, my, r = W * rng.uniform(0.2, 0.8), H * rng.uniform(0.12, 0.3), min(W, H) * rng.uniform(0.07, 0.12)
    ink.ellipse(mx, my, r, r, 255, 0, 0)
    if rng.random() < 0.6:
        ink.ellipse(mx + r * 0.45, my - r * 0.15, r * 0.9, r * 0.9, 0, 0, 0)
        tags.append("crescent moon")
    else:
        tags.append("full moon")
    base = H * rng.uniform(0.72, 0.86)
    if rng.random() < 0.5:
        _skyline(ink, rng, H, H - base + H * 0.2, style="black")
        tags.append("city lights")
    else:
        x, ridge = -10.0, [(-10.0, float(H))]
        while x < W + 10:
            ridge.append((x, base - rng.uniform(0, H * 0.14)))
            x += W * rng.uniform(0.08, 0.2)
        ridge.append((W + 10.0, float(H)))
        ink.shape(ridge, 255, 0.55, 2.0, smooth=False)
        for _ in range(int(rng.integers(2, 6))):
            pine(ink, rng.uniform(0, W), H * rng.uniform(0.9, 1.0), H * rng.uniform(0.18, 0.3), True)
        tags.append("hills")
    return tags


def scene_shrine(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    hz = H * 0.7
    if rng.random() < 0.5:
        ink.tone_gradient(0, 0, W, hz, 0.3, 0.0)
    for _ in range(int(rng.integers(1, 3))):
        cloud(ink, rng, rng.uniform(0, W), H * rng.uniform(0.08, 0.25), W * rng.uniform(0.16, 0.3))
    for _ in range(int(rng.integers(3, 7))):
        x = rng.choice([rng.uniform(0, 0.22), rng.uniform(0.78, 1.0)]) * W
        (pine if rng.random() < 0.6 else lambda i, xx, b, h, bl=False: round_tree(i, rng, xx, b, h))(ink, x, hz + rng.uniform(0, 20), H * rng.uniform(0.3, 0.55))
    ink.fill([(0, hz), (W, hz), (W, H), (0, H)], 255)
    ink.line([(0, hz), (W, hz)], 2.0)
    black = rng.random() < 0.5
    col, tone = (0, 0) if black else (255, 0.3)
    cx, gw, top = W * 0.5, W * 0.56, H * 0.26
    for sgn in (-1, 1):
        px = cx + sgn * gw * 0.36
        ink.shape([(px - W * 0.022, top + H * 0.04), (px + W * 0.022, top + H * 0.04), (px + W * 0.03, hz + H * 0.06), (px - W * 0.03, hz + H * 0.06)], col, tone, 2.0)
    ink.shape([(cx - gw * 0.6, top - H * 0.035), (cx - gw * 0.5, top + H * 0.01), (cx + gw * 0.5, top + H * 0.01), (cx + gw * 0.6, top - H * 0.035),
               (cx + gw * 0.56, top + H * 0.05), (cx - gw * 0.56, top + H * 0.05)], col, tone, 2.0)
    ink.shape([(cx - gw * 0.44, top + H * 0.12), (cx + gw * 0.44, top + H * 0.12), (cx + gw * 0.44, top + H * 0.155), (cx - gw * 0.44, top + H * 0.155)], col, tone, 2.0)
    for k in range(6):
        y = hz + H * 0.06 + k * H * 0.04
        half = gw * (0.3 + 0.07 * k)
        ink.line([(cx - half, y), (cx + half, y)], 1.6)
    ink.line([(cx - gw * 0.3, hz + H * 0.06), (cx - gw * 0.65, H)], 1.6)
    ink.line([(cx + gw * 0.3, hz + H * 0.06), (cx + gw * 0.65, H)], 1.6)
    return ["shrine gate", "stone steps", "trees"]


def scene_forest(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    ink.tone_gradient(0, 0, W, H * 0.5, 0.5, 0.1)
    ground = H * 0.78
    for depth in (0, 1, 2):
        n = (7, 5, 3)[depth]
        for _ in range(n):
            x = rng.uniform(0, W)
            tw = W * (0.018, 0.04, 0.085)[depth] * rng.uniform(0.8, 1.3)
            base = ground + H * (0.0, 0.07, 0.2)[depth]
            ink.shape([(x - tw, base), (x - tw * 0.8, 0), (x + tw * 0.8, 0), (x + tw, base)], 255, (0.45, 0.2, 0.0)[depth], 1.4 + depth * 0.5)
            for _k in range(depth * 4):
                yy = rng.uniform(0, base)
                ink.line([(x - tw * 0.4, yy), (x - tw * 0.2, yy + rng.uniform(12, 40))], 1.0)
    for _ in range(int(rng.integers(8, 16))):
        x, y = rng.uniform(0, W), rng.uniform(ground, H)
        ink.shape(ell(x, y, W * rng.uniform(0.04, 0.09), H * rng.uniform(0.02, 0.045), 12), 255, pick(rng, (0.0, 0.3)), 1.5, smooth=True)
    for _ in range(int(rng.integers(3, 6))):
        cloud(ink, rng, rng.uniform(0, W), H * rng.uniform(0.0, 0.14), W * rng.uniform(0.3, 0.5), 0.45)
    return ["forest", "tree trunks", "undergrowth"]


SCENES = {"city skyline": scene_skyline, "city street": scene_street, "room interior": scene_room,
          "landscape": scene_landscape, "sea": scene_sea, "night sky": scene_night,
          "shrine gate": scene_shrine, "forest": scene_forest}


# --------------------------------------------------------------------------
# line-art props
# --------------------------------------------------------------------------

def obj_sakura(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    pts = [(W * 0.05, H * rng.uniform(0.6, 0.9)), (W * 0.3, H * rng.uniform(0.45, 0.7)), (W * 0.6, H * rng.uniform(0.35, 0.6)),
           (W * 0.95, H * rng.uniform(0.15, 0.4))]
    ink.curve(pts, 9, taper=0.25)
    from ..vector.render import catmull_rom
    path = catmull_rom(pts)
    for _ in range(int(rng.integers(5, 10))):
        px, py = path[int(rng.integers(len(path)))]
        ang = rng.uniform(-2.6, -0.5)
        ln = rng.uniform(0.08, 0.2) * W
        ex, ey = px + ln * math.cos(ang), py + ln * math.sin(ang)
        ink.curve([(px, py), ((px + ex) / 2 + 6, (py + ey) / 2), (ex, ey)], 3.5, taper=0.3)
        r = W * rng.uniform(0.028, 0.045)
        for k in range(5):
            a = 2 * math.pi * k / 5 + rng.uniform(0, 1)
            ink.shape(ell(ex + r * math.cos(a), ey + r * math.sin(a), r * 0.7, r * 0.55, 12), 255, 0, 1.6)
        ink.ellipse(ex, ey, r * 0.3, r * 0.3, 0, 0, 0, n=10)
    for _ in range(int(rng.integers(4, 12))):
        x, y, r = rng.uniform(0, W), rng.uniform(0, H), W * 0.014
        ink.shape(ell(x, y, r * 1.5, r, 10), 255, 0, 1.3)
    return ["cherry blossom branch", "petals", "line art"]


def obj_katana(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    a = rng.uniform(-0.75, -0.35)
    c, s = math.cos(a), math.sin(a)
    T = lambda u, v: (W * 0.5 + (u * c - v * s) * W, H * 0.5 + (u * s + v * c) * W)
    blade_top = [T(u, -0.012 - 0.03 * (u + 0.18) ** 2) for u in np.linspace(-0.18, 0.44, 12)]
    blade_bot = [T(u, 0.016 - 0.03 * (u + 0.18) ** 2) for u in np.linspace(0.41, -0.18, 12)]
    ink.shape(blade_top + blade_bot, 255, 0, 2.2)
    ink.line([T(u, 0.004 - 0.03 * (u + 0.18) ** 2) for u in np.linspace(-0.18, 0.4, 10)], 1.0)
    ink.shape([T(-0.19, -0.045), T(-0.175, -0.045), T(-0.175, 0.05), T(-0.19, 0.05)], 0, 0, 2.0)
    ink.shape([T(-0.42, -0.02), T(-0.19, -0.016), T(-0.19, 0.022), T(-0.42, 0.024)], 0, 0, 2.0)
    for k in range(7):
        u = -0.41 + k * 0.031
        ink.shape([T(u, 0.002), T(u + 0.014, -0.012), T(u + 0.028, 0.002), T(u + 0.014, 0.016)], 255, 0, 0)
    return ["katana", "sword", "line art"]


def obj_cat(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    cx, s = W * 0.5, min(W, H) * 0.3
    black = rng.random() < 0.4
    col, tone = (0, 0.0) if black else (255, pick(rng, (0.0, 0.3)))
    by = H * 0.66
    ink.curve([(cx + s * 0.55, by + s * 0.55), (cx + s * 1.15, by + s * 0.5), (cx + s * 1.2, by - s * 0.2), (cx + s * 0.95, by - s * 0.45)], s * 0.16, taper=0.5)
    ink.shape([(cx - s * 0.62, by + s * 0.7), (cx - s * 0.6, by - s * 0.1), (cx, by - s * 0.5), (cx + s * 0.6, by - s * 0.1), (cx + s * 0.66, by + s * 0.7)],
              col, tone, 2.4, smooth=True)
    hy = by - s * 0.85
    for sgn in (-1, 1):
        ink.shape([(cx + sgn * s * 0.18, hy - s * 0.38), (cx + sgn * s * 0.5, hy - s * 0.82), (cx + sgn * s * 0.6, hy - s * 0.18)], col, tone, 2.4)
    ink.ellipse(cx, hy, s * 0.6, s * 0.5, col, tone, 2.4)
    fc = 255 if black else 0
    for sgn in (-1, 1):
        ink.ellipse(cx + sgn * s * 0.24, hy - s * 0.04, s * 0.09, s * 0.12, fc, 0, 0, n=14)
        ink.line([(cx + sgn * s * 0.2, hy + s * 0.16), (cx + sgn * s * 0.82, hy + s * 0.08)], 1.2, fc)
        ink.line([(cx + sgn * s * 0.2, hy + s * 0.22), (cx + sgn * s * 0.8, hy + s * 0.28)], 1.2, fc)
    ink.fill([(cx - s * 0.05, hy + s * 0.1), (cx + s * 0.05, hy + s * 0.1), (cx, hy + s * 0.17)], fc)
    return ["cat", "black cat" if black else "sitting cat", "line art"]


def obj_lantern(ink: Ink, rng) -> list[str]:
    W, H = ink.w, ink.h
    cx, cy, rx, ry = W * 0.5, H * 0.5, W * 0.22, H * 0.27
    ink.line([(cx, 0), (cx, cy - ry - H * 0.05)], 2.0)
    ink.shape([(cx - rx * 0.45, cy - ry - H * 0.05), (cx + rx * 0.45, cy - ry - H * 0.05), (cx + rx * 0.45, cy - ry + 4), (cx - rx * 0.45, cy - ry + 4)], 0, 0, 2.0)
    ink.ellipse(cx, cy, rx, ry, 255, pick(rng, (0.0, 0.2)), 2.4)
    for k in range(1, 8):
        y = cy - ry + 2 * ry * k / 8
        half = rx * math.sqrt(max(0.0, 1 - ((y - cy) / ry) ** 2))
        ink.curve([(cx - half, y), (cx, y + 5), (cx + half, y)], 1.3, taper=None)
    ink.shape([(cx - rx * 0.45, cy + ry - 4), (cx + rx * 0.45, cy + ry - 4), (cx + rx * 0.45, cy + ry + H * 0.04), (cx - rx * 0.45, cy + ry + H * 0.04)], 0, 0, 2.0)
    for dx in (-8, 0, 8):
        ink.line([(cx + dx, cy + ry + H * 0.04), (cx + dx * 1.4, cy + ry + H * 0.14)], 1.3)
    return ["paper lantern", "line art"]


OBJECTS = {"cherry blossom branch": obj_sakura, "katana": obj_katana, "cat": obj_cat, "paper lantern": obj_lantern}


# --------------------------------------------------------------------------
# whole images
# --------------------------------------------------------------------------

def _portrait_into(ink: Ink, rng, a: dict, expr: str | None = None, zoom: float | None = None) -> list[str]:
    W, H = ink.w, ink.h
    tags = []
    fx = pick(rng, (None, None, None, *EFFECTS))
    if fx:
        EFFECTS[fx](ink, rng)
        tags.append(fx)
    m = min(W, H)
    sc = m * (zoom or rng.uniform(0.17, 0.25))
    cx = W / 2 + rng.uniform(-0.06, 0.06) * W
    cy = H * 0.42 + rng.uniform(-0.04, 0.04) * H + (sc - m * 0.2) * 0.3
    draw_character(ink, rng, a, cx, cy, sc, tilt=float(rng.uniform(-0.1, 0.1)), expr=expr)
    return tags


def make_portrait(rng, size: int):
    a = sample_character(rng)
    ink = Ink(size, size)
    close = rng.random() < 0.2
    extra = _portrait_into(ink, rng, a, zoom=rng.uniform(0.3, 0.38) if close else None)
    head = pick(rng, ("manga portrait", "manga portrait", "anime portrait", "manga character")) if not close else "manga close-up"
    return ink.finish(), ", ".join([head] + character_tags(a, not close) + extra), "portrait"


def make_chibi(rng, size: int):
    a = sample_character(rng)
    ink = Ink(size, size)
    extra = []
    fx = pick(rng, (None, None, "sparkles", "flowers", "screentone background"))
    if fx:
        EFFECTS[fx](ink, rng)
        extra.append(fx)
    pose = draw_chibi(ink, rng, a, size * rng.uniform(0.42, 0.58), size * rng.uniform(0.32, 0.38), size * rng.uniform(0.15, 0.19))
    tags = [t for t in character_tags(a, False) if not t.endswith("bangs")]
    return ink.finish(), ", ".join(["chibi character, full body", pose] + tags + extra), "chibi"


def make_scene(rng, size: int):
    name = pick(rng, tuple(SCENES))
    ink = Ink(size, size)
    tags = SCENES[name](ink, rng)
    head = pick(rng, ("manga background", "manga background", "anime scenery", "detailed environment"))
    return ink.finish(), ", ".join([head] + tags), "scene"


def make_object(rng, size: int):
    name = pick(rng, tuple(OBJECTS))
    ink = Ink(size, size)
    if rng.random() < 0.25:
        fx_tone(ink, rng)
    tags = OBJECTS[name](ink, rng)
    return ink.finish(), ", ".join(["manga illustration"] + tags), "object"


def make_composition(rng, size: int):
    """A character in front of an environment, optionally with a speech bubble."""
    a = sample_character(rng)
    name = pick(rng, tuple(SCENES))
    ink = Ink(size, size)
    tags = SCENES[name](ink, rng)
    sc = size * rng.uniform(0.13, 0.19)
    cx = size * pick(rng, (0.3, 0.5, 0.7)) + rng.uniform(-0.04, 0.04) * size
    cy = size * rng.uniform(0.5, 0.6)
    draw_character(ink, rng, a, cx, cy, sc, tilt=float(rng.uniform(-0.08, 0.08)))
    extra = []
    if rng.random() < 0.4:
        bx = size * (0.78 if cx < size * 0.5 else 0.22)
        bubble(ink, rng, bx, size * 0.2, size * 0.16, size * 0.1, tail_to=(cx + (bx - cx) * 0.35, cy - sc * 0.9))
        extra.append("speech bubble")
    return ink.finish(), ", ".join(["manga illustration", short_description(a), a["expr"], a["outfit"]] + tags[:2] + extra), "composition"


LAYOUTS = ([1, 1], [1, 2], [2, 1], [2, 2], [1, 2, 1], [2, 1, 2], [1, 3], [3, 1], [2, 3], [1, 1, 2])


def make_page(rng, size: int):
    """A comic page: rows of framed panels around one recurring character."""
    a = sample_character(rng)
    layout = pick(rng, LAYOUTS)
    page = np.zeros((size, size), dtype=bool)
    margin, gut = int(size * 0.025), int(size * 0.02)
    cuts = np.sort(rng.uniform(0.3, 0.7, len(layout) - 1)) if len(layout) == 2 else np.cumsum(rng.dirichlet([6] * len(layout)))[:-1]
    ys = [margin] + [int(margin + (size - 2 * margin) * c) for c in cuts] + [size - margin]
    subjects, n_panels, has_bubble, has_sfx = [], 0, False, False
    for r, cols in enumerate(layout):
        xs = [margin] + [int(margin + (size - 2 * margin) * c) for c in np.cumsum(rng.dirichlet([5] * cols))[:-1]] + [size - margin]
        for c in range(cols):
            x0, x1 = xs[c] + (gut // 2 if c else 0), xs[c + 1] - (gut // 2 if c < cols - 1 else 0)
            y0, y1 = ys[r] + (gut // 2 if r else 0), ys[r + 1] - (gut // 2 if r < len(layout) - 1 else 0)
            w, h = x1 - x0, y1 - y0
            if w < 24 or h < 24:
                continue
            ink = Ink(w, h)
            n_panels += 1
            kind = pick(rng, ("char", "char", "char", "scene", "effect"))
            if kind == "char":
                zoom = pick(rng, (None, None, rng.uniform(0.3, 0.42)))
                _portrait_into(ink, rng, a, expr=pick(rng, ("smiling", "neutral", "laughing", "surprised", "angry", "sad", "calm")), zoom=zoom)
                if rng.random() < 0.45 and w > 80 and h > 70:
                    bx = w * pick(rng, (0.22, 0.78))
                    bubble(ink, rng, bx, h * 0.2, w * 0.18, h * 0.13, tail_to=(w * 0.5 + (bx - w * 0.5) * 0.3, h * 0.36))
                    has_bubble = True
            elif kind == "scene":
                name = pick(rng, tuple(SCENES))
                SCENES[name](ink, rng)
                if name not in subjects:
                    subjects.append(name)
            else:
                pick(rng, (fx_speed_lines, fx_motion_lines, fx_burst))(ink, rng)
                sfx(ink, rng, w * 0.12, h * 0.3, min(w / 4.5, h * 0.4))
                has_sfx = True
            page[y0:y1, x0:x1] = frame(ink.finish(), 3)
    tags = ["manga page", f"{n_panels} panels", short_description(a)] + subjects[:2]
    if has_bubble:
        tags.append("speech bubbles")
    if has_sfx:
        tags.append("sound effects")
    return page, ", ".join(tags), "page"


MAKERS = {"portrait": (make_portrait, 0.34), "chibi": (make_chibi, 0.08), "scene": (make_scene, 0.24),
          "page": (make_page, 0.2), "object": (make_object, 0.06), "composition": (make_composition, 0.08)}


def sample(rng, size: int = 512) -> tuple[np.ndarray, str, str]:
    """-> (ink bitmap bool [size, size], caption, kind)."""
    names = list(MAKERS)
    w = np.array([MAKERS[n][1] for n in names])
    name = names[int(rng.choice(len(names), p=w / w.sum()))]
    return MAKERS[name][0](rng, size)
