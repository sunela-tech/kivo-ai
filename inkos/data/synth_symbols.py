"""Procedural symbols and simple illustrations for INKOS 1.

About fifty parametric drawings (shapes, weather, objects, faces) with style
words, sizes, counts and two-object compositions:

  star            filled heart        bold sketchy house       small circle
  three stars     a star inside a circle     moon above a tree
  clock at 3:40   arrow pointing left
"""
from __future__ import annotations

import math

import numpy as np

from .doc import Doc
from .words import pick


class Frame:
    """Maps a symbol's unit square [-1, 1]^2 onto the canvas."""

    def __init__(self, cx: float, cy: float, r: float):
        self.cx, self.cy, self.r = cx, cy, r

    def p(self, u, v):
        return (self.cx + u * self.r, self.cy + v * self.r)

    def ps(self, pts):
        return [self.p(u, v) for u, v in pts]

    def k(self, s):
        return s * self.r


def _ngon(n, r=0.95, rot=-90.0):
    return [(r * math.cos(math.radians(rot + 360 * i / n)), r * math.sin(math.radians(rot + 360 * i / n)))
            for i in range(n)]


def _arc(cx, cy, r, a0, a1, n=5):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / (n - 1))),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / (n - 1)))) for i in range(n)]


def _shape(d: Doc, F: Frame, pts, fill, smooth=False):
    d.add(("FBLOB" if fill else "BLOB") if smooth else ("FILL" if fill else "POLY"), F.ps(pts))


def _rect(d, F, u0, v0, u1, v1, fill=False):
    d.add("BOX" if fill else "RECT", *F.p(u0, v0), *F.p(u1, v1))


def _circ(d, F, u, v, r, fill=False):
    d.add("DISC" if fill else "CIRC", *F.p(u, v), F.k(r))


def _line(d, F, *pts):
    d.add("LINE", F.ps(pts))


def _curve(d, F, *pts):
    d.add("CURVE", F.ps(pts))


# -- geometric ---------------------------------------------------------------
def s_circle(d, F, fill, rng): _circ(d, F, 0, 0, 0.95, fill)
def s_square(d, F, fill, rng): _rect(d, F, -0.85, -0.85, 0.85, 0.85, fill)
def s_rectangle(d, F, fill, rng): _rect(d, F, -0.95, -0.55, 0.95, 0.55, fill)
def s_triangle(d, F, fill, rng): _shape(d, F, [(0, -0.92), (0.95, 0.78), (-0.95, 0.78)], fill)
def s_diamond(d, F, fill, rng): _shape(d, F, [(0, -1), (0.75, 0), (0, 1), (-0.75, 0)], fill)
def s_pentagon(d, F, fill, rng): _shape(d, F, _ngon(5), fill)
def s_hexagon(d, F, fill, rng): _shape(d, F, _ngon(6, rot=0), fill)
def s_oval(d, F, fill, rng):
    if fill:
        d.add("FBLOB", [F.p(0.95 * math.cos(a), 0.6 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 10, endpoint=False)])
    else:
        d.add("ELLI", *F.p(0, 0), F.k(0.95), F.k(0.6))


def s_star(d, F, fill, rng):
    pts = []
    for i in range(10):
        r = 1.0 if i % 2 == 0 else 0.42
        a = math.radians(-90 + 36 * i)
        pts.append((r * math.cos(a), r * math.sin(a) + 0.05))
    _shape(d, F, pts, fill)


def s_heart(d, F, fill, rng):
    half = [(0, -0.4), (0.45, -0.88), (0.95, -0.45), (0.62, 0.3), (0, 0.95)]
    if fill:
        d.add("FBLOB", F.ps(half + [(-u, v) for u, v in half[-2:0:-1]]))
    else:
        _curve(d, F, *half)
        _curve(d, F, *[(-u, v) for u, v in half])


def s_cross(d, F, fill, rng):
    _line(d, F, (-0.8, -0.8), (0.8, 0.8))
    _line(d, F, (0.8, -0.8), (-0.8, 0.8))


def s_plus(d, F, fill, rng):
    _line(d, F, (0, -0.9), (0, 0.9))
    _line(d, F, (-0.9, 0), (0.9, 0))


def s_minus(d, F, fill, rng): _line(d, F, (-0.9, 0), (0.9, 0))
def s_check(d, F, fill, rng): _line(d, F, (-0.9, 0.05), (-0.3, 0.7), (0.9, -0.7))


def _arrow(angle):
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    rot = lambda pts: [(u * c - v * s, u * s + v * c) for u, v in pts]

    def draw(d, F, fill, rng):
        if fill:
            _shape(d, F, rot([(-0.9, -0.24), (0.2, -0.24), (0.2, -0.68), (0.95, 0), (0.2, 0.68), (0.2, 0.24), (-0.9, 0.24)]), True)
        else:
            _line(d, F, *rot([(-0.9, 0), (0.9, 0)]))
            _line(d, F, *rot([(0.3, -0.6), (0.9, 0), (0.3, 0.6)]))
    return draw


def s_spiral(d, F, fill, rng):
    _curve(d, F, *[(0.07 * t * math.cos(1.1 * t), 0.07 * t * math.sin(1.1 * t)) for t in range(1, 14)])


def s_wave(d, F, fill, rng):
    _curve(d, F, *[(-0.95 + 0.38 * i, 0.35 * (1 if i % 2 else -1)) for i in range(6)])


def s_zigzag(d, F, fill, rng):
    _line(d, F, *[(-0.95 + 0.38 * i, 0.4 * (1 if i % 2 else -1)) for i in range(6)])


def s_grid(d, F, fill, rng):
    _rect(d, F, -0.9, -0.9, 0.9, 0.9)
    for t in (-0.3, 0.3):
        _line(d, F, (t, -0.9), (t, 0.9))
        _line(d, F, (-0.9, t), (0.9, t))


# -- nature / weather --------------------------------------------------------
def s_sun(d, F, fill, rng):
    _circ(d, F, 0, 0, 0.42, fill)
    for i in range(8):
        a = math.radians(45 * i)
        _line(d, F, (0.6 * math.cos(a), 0.6 * math.sin(a)), (0.95 * math.cos(a), 0.95 * math.sin(a)))


def s_moon(d, F, fill, rng):
    outer = _arc(0, 0, 0.9, 50, 310, 8)
    inner = _arc(0.42, 0, 0.72, 255, 105, 5)
    _shape(d, F, outer + inner, fill, smooth=True)


def s_cloud(d, F, fill, rng):
    _shape(d, F, [(-0.9, 0.3), (-0.72, -0.12), (-0.38, -0.2), (-0.15, -0.6), (0.3, -0.62), (0.52, -0.28),
                  (0.88, -0.15), (0.95, 0.25), (0.6, 0.48), (-0.55, 0.48)], fill, smooth=True)


def s_rain(d, F, fill, rng):
    s_cloud(d, Frame(F.cx, F.cy - F.r * 0.3, F.r * 0.85), fill, rng)
    for u in (-0.5, 0, 0.5):
        _line(d, F, (u, 0.35), (u - 0.15, 0.85))


def s_bolt(d, F, fill, rng):
    _shape(d, F, [(0.15, -0.95), (-0.5, 0.1), (-0.05, 0.1), (-0.25, 0.95), (0.5, -0.15), (0.05, -0.15)], fill)


def s_drop(d, F, fill, rng):
    if fill:
        _shape(d, F, [(0, -0.95), (0.5, -0.05), (0.58, 0.45), (0.3, 0.85), (-0.3, 0.85), (-0.58, 0.45), (-0.5, -0.05)], True, smooth=True)
    else:
        _curve(d, F, (0, -0.95), (0.45, -0.1), (0.58, 0.45), (0.3, 0.85), (0, 0.95), (-0.3, 0.85), (-0.58, 0.45), (-0.45, -0.1), (0, -0.95))


def s_tree(d, F, fill, rng):
    _rect(d, F, -0.12, 0.35, 0.12, 0.95, fill)
    _circ(d, F, 0, -0.25, 0.62, fill)


def s_pine(d, F, fill, rng):
    _rect(d, F, -0.1, 0.6, 0.1, 0.95, fill)
    for top, w, bot in ((-0.95, 0.42, -0.35), (-0.6, 0.6, 0.12), (-0.2, 0.8, 0.6)):
        _shape(d, F, [(0, top), (w, bot), (-w, bot)], fill)


def s_flower(d, F, fill, rng):
    _line(d, F, (0, 0.0), (0, 0.95))
    _curve(d, F, (0, 0.6), (0.3, 0.35), (0.55, 0.45))
    for i in range(6):
        a = math.radians(60 * i)
        _circ(d, F, 0.36 * math.cos(a), -0.4 + 0.36 * math.sin(a), 0.19)
    _circ(d, F, 0, -0.4, 0.17, True)


def s_leaf(d, F, fill, rng):
    _curve(d, F, (-0.8, 0.8), (-0.6, -0.3), (0.8, -0.8))
    _curve(d, F, (-0.8, 0.8), (0.3, 0.6), (0.8, -0.8))
    _line(d, F, (-0.8, 0.8), (0.8, -0.8))


def s_mountain(d, F, fill, rng):
    _line(d, F, (-0.95, 0.75), (-0.3, -0.6), (0.1, 0.1), (0.45, -0.35), (0.95, 0.75))
    _line(d, F, (-0.95, 0.75), (0.95, 0.75))
    _line(d, F, (-0.5, -0.2), (-0.3, -0.05), (-0.12, -0.25))


def s_fish(d, F, fill, rng):
    d.add("ELLI", *F.p(-0.15, 0), F.k(0.62), F.k(0.36))
    _shape(d, F, [(0.45, 0), (0.95, -0.4), (0.95, 0.4)], fill)
    _circ(d, F, -0.48, -0.08, 0.06, True)


def s_cat(d, F, fill, rng):
    _circ(d, F, 0, 0.15, 0.68)
    _line(d, F, (-0.6, -0.17), (-0.6, -0.9), (-0.2, -0.5))
    _line(d, F, (0.6, -0.17), (0.6, -0.9), (0.2, -0.5))
    _circ(d, F, -0.27, 0.02, 0.08, True)
    _circ(d, F, 0.27, 0.02, 0.08, True)
    _shape(d, F, [(-0.08, 0.25), (0.08, 0.25), (0, 0.36)], True)
    for sgn in (-1, 1):
        _line(d, F, (sgn * 0.2, 0.4), (sgn * 0.85, 0.3))
        _line(d, F, (sgn * 0.2, 0.47), (sgn * 0.85, 0.55))


# -- objects -----------------------------------------------------------------
def s_house(d, F, fill, rng):
    _rect(d, F, -0.7, -0.1, 0.7, 0.9)
    if fill:
        _shape(d, F, [(-0.95, -0.08), (0, -0.95), (0.95, -0.08)], True)
    else:
        _line(d, F, (-0.95, -0.05), (0, -0.95), (0.95, -0.05))
    _rect(d, F, -0.15, 0.35, 0.15, 0.9)
    _rect(d, F, 0.3, 0.1, 0.55, 0.35)


def s_flag(d, F, fill, rng):
    _line(d, F, (-0.6, -0.95), (-0.6, 0.95))
    _shape(d, F, [(-0.6, -0.9), (0.8, -0.55), (-0.6, -0.15)], fill)


def s_envelope(d, F, fill, rng):
    _rect(d, F, -0.92, -0.6, 0.92, 0.6)
    _line(d, F, (-0.92, -0.6), (0, 0.1), (0.92, -0.6))


def s_cup(d, F, fill, rng):
    _shape(d, F, [(-0.6, -0.5), (0.5, -0.5), (0.36, 0.8), (-0.46, 0.8)], fill)
    _curve(d, F, (0.48, -0.25), (0.9, -0.2), (0.9, 0.3), (0.42, 0.4))
    for u in (-0.3, 0.05):
        _curve(d, F, (u, -0.62), (u + 0.1, -0.75), (u - 0.05, -0.85), (u + 0.05, -0.97))


def s_book(d, F, fill, rng):
    _rect(d, F, -0.75, -0.9, 0.75, 0.9)
    _line(d, F, (-0.5, -0.9), (-0.5, 0.9))
    _line(d, F, (-0.25, -0.5), (0.5, -0.5))
    _line(d, F, (-0.25, -0.25), (0.3, -0.25))


def s_lock(d, F, fill, rng):
    _rect(d, F, -0.6, -0.05, 0.6, 0.9, fill)
    _curve(d, F, (-0.38, -0.05), (-0.38, -0.6), (0, -0.92), (0.38, -0.6), (0.38, -0.05))
    if not fill:
        _circ(d, F, 0, 0.4, 0.1, True)


def s_key(d, F, fill, rng):
    _circ(d, F, -0.55, 0, 0.35)
    _line(d, F, (-0.2, 0), (0.92, 0))
    _line(d, F, (0.6, 0), (0.6, 0.32))
    _line(d, F, (0.88, 0), (0.88, 0.32))


def s_bell(d, F, fill, rng):
    _curve(d, F, (-0.8, 0.6), (-0.55, 0.3), (-0.5, -0.3), (0, -0.82), (0.5, -0.3), (0.55, 0.3), (0.8, 0.6))
    _line(d, F, (-0.8, 0.6), (0.8, 0.6))
    _circ(d, F, 0, 0.8, 0.13, True)


def s_bulb(d, F, fill, rng):
    _circ(d, F, 0, -0.28, 0.6)
    _rect(d, F, -0.24, 0.38, 0.24, 0.85)
    _line(d, F, (-0.24, 0.6), (0.24, 0.6))


def s_boat(d, F, fill, rng):
    _shape(d, F, [(-0.9, 0.3), (0.9, 0.3), (0.6, 0.8), (-0.6, 0.8)], False)
    _line(d, F, (0, 0.3), (0, -0.92))
    _shape(d, F, [(0.06, -0.85), (0.68, 0.15), (0.06, 0.15)], fill)


def s_car(d, F, fill, rng):
    _rect(d, F, -0.92, -0.05, 0.92, 0.42)
    _line(d, F, (-0.5, -0.05), (-0.3, -0.5), (0.35, -0.5), (0.55, -0.05))
    for u in (-0.5, 0.5):
        d.add("ERASE")
        _circ(d, F, u, 0.45, 0.22, True)
        d.add("INK")
        _circ(d, F, u, 0.45, 0.22, fill)


def s_umbrella(d, F, fill, rng):
    _curve(d, F, (-0.92, 0), (-0.6, -0.6), (0, -0.85), (0.6, -0.6), (0.92, 0))
    _line(d, F, (-0.92, 0), (0.92, 0))
    _curve(d, F, (0, 0), (0, 0.7), (-0.15, 0.9), (-0.32, 0.72))


def s_note(d, F, fill, rng):
    _line(d, F, (0.25, -0.85), (0.25, 0.5))
    _circ(d, F, 0, 0.55, 0.27, True)
    _curve(d, F, (0.25, -0.85), (0.7, -0.6), (0.6, -0.2))


def s_magnifier(d, F, fill, rng):
    _circ(d, F, -0.2, -0.2, 0.55)
    _line(d, F, (0.2, 0.2), (0.92, 0.92))


def s_bubble(d, F, fill, rng):
    _rect(d, F, -0.92, -0.7, 0.92, 0.32)
    d.add("ERASE")
    _line(d, F, (-0.38, 0.32), (-0.1, 0.32))
    d.add("INK")
    _line(d, F, (-0.4, 0.32), (-0.55, 0.85), (-0.05, 0.32))


def s_battery(d, F, fill, rng):
    _rect(d, F, -0.9, -0.4, 0.74, 0.4)
    _rect(d, F, 0.74, -0.16, 0.9, 0.16, True)
    if fill:
        _rect(d, F, -0.78, -0.28, 0.2, 0.28, True)


def s_wifi(d, F, fill, rng):
    for r in (0.38, 0.72, 1.06):
        _curve(d, F, *_arc(0, 0.6, r, 222, 318, 5))
    _circ(d, F, 0, 0.6, 0.1, True)


def s_eye(d, F, fill, rng):
    _curve(d, F, (-0.95, 0), (-0.4, -0.48), (0.4, -0.48), (0.95, 0))
    _curve(d, F, (-0.95, 0), (-0.4, 0.48), (0.4, 0.48), (0.95, 0))
    _circ(d, F, 0, 0, 0.3)
    _circ(d, F, 0, 0, 0.12, True)


def s_pencil(d, F, fill, rng):
    _shape(d, F, [(-0.62, 0.32), (0.5, -0.8), (0.8, -0.5), (-0.32, 0.62)], fill)
    _line(d, F, (-0.62, 0.32), (-0.92, 0.92), (-0.32, 0.62))
    _line(d, F, (0.3, -0.6), (0.6, -0.3))


def s_rocket(d, F, fill, rng):
    _curve(d, F, (-0.32, 0.45), (-0.34, -0.3), (0, -0.95), (0.34, -0.3), (0.32, 0.45))
    _line(d, F, (-0.32, 0.45), (0.32, 0.45))
    _line(d, F, (-0.33, 0.05), (-0.7, 0.55), (-0.32, 0.45))
    _line(d, F, (0.33, 0.05), (0.7, 0.55), (0.32, 0.45))
    _circ(d, F, 0, -0.25, 0.14, fill)
    _curve(d, F, (-0.15, 0.55), (0, 0.95), (0.15, 0.55))


def _clock(h: int, m: int):
    def draw(d, F, fill, rng):
        _circ(d, F, 0, 0, 0.92)
        for i in range(4):
            a = math.radians(90 * i)
            _line(d, F, (0.78 * math.cos(a), 0.78 * math.sin(a)), (0.9 * math.cos(a), 0.9 * math.sin(a)))
        ha = math.radians(-90 + 30 * (h % 12) + m * 0.5)
        ma = math.radians(-90 + 6 * m)
        _line(d, F, (0, 0), (0.45 * math.cos(ha), 0.45 * math.sin(ha)))
        _line(d, F, (0, 0), (0.72 * math.cos(ma), 0.72 * math.sin(ma)))
    return draw


def _face(mood: str):
    def draw(d, F, fill, rng):
        _circ(d, F, 0, 0, 0.92)
        _circ(d, F, -0.32, -0.25, 0.09, True)
        _circ(d, F, 0.32, -0.25, 0.09, True)
        if mood == "happy":
            _curve(d, F, (-0.48, 0.2), (0, 0.55), (0.48, 0.2))
        elif mood == "sad":
            _curve(d, F, (-0.45, 0.52), (0, 0.25), (0.45, 0.52))
        elif mood == "surprised":
            _circ(d, F, 0, 0.4, 0.16)
        else:
            _line(d, F, (-0.4, 0.4), (0.4, 0.4))
    return draw


def s_stick(d, F, fill, rng):
    _circ(d, F, 0, -0.67, 0.25)
    _line(d, F, (0, -0.42), (0, 0.3))
    _line(d, F, (-0.5, -0.1), (0.5, -0.1))
    _line(d, F, (-0.4, 0.95), (0, 0.3), (0.4, 0.95))


# name -> (draw fn, can be filled, extra names)
SYMBOLS: dict[str, tuple] = {
    "circle": (s_circle, True), "square": (s_square, True), "rectangle": (s_rectangle, True),
    "triangle": (s_triangle, True), "diamond": (s_diamond, True), "pentagon": (s_pentagon, True),
    "hexagon": (s_hexagon, True), "oval": (s_oval, True), "star": (s_star, True), "heart": (s_heart, True),
    "cross": (s_cross, False), "plus sign": (s_plus, False), "minus sign": (s_minus, False),
    "check mark": (s_check, False), "arrow pointing right": (_arrow(0), True),
    "arrow pointing down": (_arrow(90), True), "arrow pointing left": (_arrow(180), True),
    "arrow pointing up": (_arrow(270), True), "spiral": (s_spiral, False), "wave": (s_wave, False),
    "zigzag": (s_zigzag, False), "grid": (s_grid, False), "sun": (s_sun, True), "moon": (s_moon, True),
    "cloud": (s_cloud, True), "rain cloud": (s_rain, True), "lightning bolt": (s_bolt, True),
    "water drop": (s_drop, True), "tree": (s_tree, True), "pine tree": (s_pine, True),
    "flower": (s_flower, False), "leaf": (s_leaf, False), "mountain": (s_mountain, False),
    "fish": (s_fish, True), "cat face": (s_cat, False), "house": (s_house, True), "flag": (s_flag, True),
    "envelope": (s_envelope, False), "cup": (s_cup, True), "book": (s_book, False), "lock": (s_lock, True),
    "key": (s_key, False), "bell": (s_bell, False), "light bulb": (s_bulb, False), "boat": (s_boat, True),
    "car": (s_car, True), "umbrella": (s_umbrella, False), "music note": (s_note, False),
    "magnifier": (s_magnifier, False), "speech bubble": (s_bubble, False), "battery": (s_battery, True),
    "wifi": (s_wifi, False), "eye": (s_eye, False), "pencil": (s_pencil, True), "rocket": (s_rocket, True),
    "smiley face": (_face("happy"), False), "sad face": (_face("sad"), False),
    "neutral face": (_face("neutral"), False), "surprised face": (_face("surprised"), False),
    "stick figure": (s_stick, False),
}
NAMES = tuple(SYMBOLS)
COUNT_WORDS = {2: "two", 3: "three", 4: "four", 5: "five"}


def _plural(name: str) -> str:
    if name.endswith(("s", "x", "ch", "sh")):
        return name + "es"
    if name.endswith("f"):
        return name[:-1] + "ves"
    if name.endswith("y") and name[-2] not in "aeiou":
        return name[:-1] + "ies"
    return name + "s"


def _draw(d: Doc, rng, name: str, F: Frame, fill: bool):
    fn, can_fill = SYMBOLS[name]
    fn(d, F, fill and can_fill, rng)


def gen_symbol(rng: np.random.Generator) -> Doc | None:
    d = Doc("symbol")
    adj = d.style(rng, hand_p=0.4)
    name = pick(rng, NAMES)
    can_fill = SYMBOLS[name][1]
    fill = can_fill and rng.random() < 0.3
    size_word, r = "", float(rng.uniform(34, 52))
    sr = rng.random()
    if sr < 0.12:
        size_word, r = pick(rng, ("small ", "tiny ", "little ")), float(rng.uniform(14, 22))
    elif sr < 0.24:
        size_word, r = pick(rng, ("large ", "big ")), float(rng.uniform(52, 58))
    desc = size_word + ("filled " if fill else ("outline " if can_fill and rng.random() < 0.15 else "")) + name
    form = rng.random()
    if form < 0.4:
        d.say(adj + desc)
    elif form < 0.6:
        d.say(adj + desc + " icon")
    elif form < 0.72:
        d.say("icon: " + adj + desc)
    elif form < 0.84:
        d.say(adj + desc + " symbol")
    elif form < 0.92:
        d.say("draw a " + adj + desc)
    else:
        d.say("a " + adj + desc)
    _draw(d, rng, name, Frame(64, 64, r), fill)
    return d


def gen_clock(rng) -> Doc | None:
    d = Doc("clock")
    adj = d.style(rng, hand_p=0.4)
    h, m = int(rng.integers(1, 13)), int(rng.integers(0, 12)) * 5
    d.say(adj + pick(rng, ("clock at ", "clock showing ", "clock: ")) + f"{h}:{m:02d}")
    _clock(h, m)(d, Frame(64, 64, float(rng.uniform(40, 54))), False, rng)
    return d


def gen_count(rng) -> Doc | None:
    """'three stars': n copies in a row (or 2 x 2 for four)."""
    d = Doc("count")
    adj = d.style(rng, hand_p=0.4)
    name = pick(rng, NAMES)
    n = int(rng.integers(2, 6))
    fill = SYMBOLS[name][1] and rng.random() < 0.3
    d.say(adj + COUNT_WORDS[n] + " " + ("filled " if fill else "") + _plural(name))
    if n == 4:
        for cx, cy in ((34, 34), (94, 34), (34, 94), (94, 94)):
            _draw(d, rng, name, Frame(cx, cy, 24), fill)
    else:
        slot = 120.0 / n
        for i in range(n):
            _draw(d, rng, name, Frame(4 + slot * (i + 0.5), 64, slot * 0.42), fill)
    return d


def gen_pair(rng) -> Doc | None:
    """Two symbols in a stated arrangement."""
    d = Doc("pair")
    adj = d.style(rng, hand_p=0.4)
    a, b = pick(rng, NAMES), pick(rng, NAMES)
    rel = pick(rng, ("inside", "above", "below", "left of", "right of", "and"))
    if rel == "inside":
        b = pick(rng, ("circle", "square", "hexagon", "diamond", "triangle", "oval", "pentagon"))
        d.say(f"{adj}{a} inside a {b}")
        _draw(d, rng, b, Frame(64, 64, 56), False)
        _draw(d, rng, a, Frame(64, 66 if b == "triangle" else 64, 24 if b in ("triangle", "diamond") else 30), False)
        return d
    d.say(f"{adj}{a} {rel} a {b}" if rel != "and" else f"{adj}{a} and {b}")
    if rel in ("above", "below"):
        fa, fb = Frame(64, 34, 27), Frame(64, 94, 27)
        if rel == "below":
            fa, fb = fb, fa
    else:
        fa, fb = Frame(34, 64, 27), Frame(94, 64, 27)
        if rel == "right of":
            fa, fb = fb, fa
    _draw(d, rng, a, fa, False)
    _draw(d, rng, b, fb, False)
    return d


GENERATORS = {
    "symbol": (gen_symbol, 5.0),
    "clock": (gen_clock, 0.7),
    "count": (gen_count, 1.3),
    "pair": (gen_pair, 1.5),
}
