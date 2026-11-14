"""Synthetic diagrams for INKOS 1.

  flowchart: Start -> Check -> Done        a step ending in '?' is a decision
  steps: Plan -> Build -> Ship             left-to-right pipeline
  mind map: Project; Design; Build; Test   first entry is the centre
  tree: Root; A; B; C
  timeline: 2020 Start; 2022 Launch
  venn diagram: Cats; Dogs
  cycle: Plan; Do; Check; Act
  stack: UI; API; DB
  2x2 matrix: A; B; C; D
"""
from __future__ import annotations

import math

import numpy as np

from . import words
from .doc import ADV, GAP, Doc, fit_size
from .words import pick


def _labels(d: Doc, rng, n: int, max_len: int, sep: str = "; ", pool=None):
    out = []
    for i in range(n):
        if i:
            d.say(sep)
        txt = pick(rng, pool) if pool and rng.random() < 0.6 else words.label(rng, max_len)
        out.append(d.span(txt[:max_len]))
    return out


def gen_flow(rng) -> Doc | None:
    d = Doc("flow")
    d.say(d.style(rng, hand_p=0.4) + pick(rng, ("flowchart", "flowchart", "flow chart", "flow", "process")) + ": ")
    n = int(rng.integers(2, 6))
    nodes = _labels(d, rng, n, 12, " -> ", words.FLOW_STEPS)
    gap = 9.0
    h = min(20.0, (114 - (n - 1) * gap) / n)
    longest = max(d.length(s) for s in nodes)
    s = min(fit_size(longest, 84, (8, 7, 6, 5, 4)), max(4, int(h * 0.5)))
    w = max(36.0, (longest * ADV) * s + 10)
    y = (128 - (n * h + (n - 1) * gap)) / 2
    for i, sp in enumerate(nodes):
        cy = y + h / 2
        if d.text_of(sp).endswith("?"):
            d.add("POLY", [(64, y - 1), (64 + w / 2 + 5, cy), (64, y + h + 1), (64 - w / 2 - 5, cy)])
        elif i in (0, n - 1):
            d.add("ELLI", 64, cy, w / 2, h / 2)
        else:
            d.add("RECT", 64 - w / 2, y, 64 + w / 2, y + h)
        d.text_center(64, cy, s, sp)
        if i < n - 1:
            d.arrow(64, y + h + 1, 64, y + h + gap - 1)
        y += h + gap
    return d


def gen_steps(rng) -> Doc | None:
    d = Doc("steps")
    d.say(d.style(rng, hand_p=0.4) + pick(rng, ("steps", "pipeline", "horizontal flowchart", "sequence")) + ": ")
    n = int(rng.integers(2, 5))
    nodes = _labels(d, rng, n, 7, " -> ", [w for w in words.FLOW_STEPS if len(w) <= 7])
    gap = 9.0
    w = (116 - (n - 1) * gap) / n
    s = fit_size(max(d.length(x) for x in nodes), w - 3, (7, 6, 5, 4, 3))
    x = 6.0
    for i, sp in enumerate(nodes):
        d.add("RECT", x, 52, x + w, 76)
        d.text_center(x + w / 2, 64, s, sp)
        if i < n - 1:
            d.arrow(x + w + 1, 64, x + w + gap - 1, 64, head=2.6)
        x += w + gap
    return d


def gen_mindmap(rng) -> Doc | None:
    d = Doc("mindmap")
    d.say(d.style(rng, hand_p=0.6) + pick(rng, ("mind map", "mind map", "mindmap", "idea map", "spider diagram")) + ": ")
    center = d.span(words.title(rng).split(" ")[0][:9])
    n = int(rng.integers(3, 8))
    d.say("; ")
    nodes = _labels(d, rng, n, 8)
    cs = fit_size(d.length(center), 36, (7, 6, 5))
    rx = max(13.0, (d.length(center) * ADV) * cs / 2 + 4)
    ry = 9.0
    d.add("ELLI", 64, 64, rx, ry)
    d.text_center(64, 64, cs, center)
    for i, sp in enumerate(nodes):
        a = math.radians(-90 + 360 * i / n)
        s = 5 if d.length(sp) <= 6 else 4
        half = (d.length(sp) * ADV - GAP) * s / 2
        nx = min(126 - half, max(2 + half, 64 + 46 * math.cos(a)))
        ny = 64 + 46 * math.sin(a)
        ex, ey = 64 + (rx + 1) * math.cos(a), 64 + (ry + 1) * math.sin(a)
        tx, ty = 64 + 35 * math.cos(a), 64 + 35 * math.sin(a)
        d.line((ex, ey), (tx, ty))
        d.text_center(nx, ny, s, sp)
    return d


def gen_tree(rng) -> Doc | None:
    d = Doc("tree")
    d.say(d.style(rng, hand_p=0.35) + pick(rng, ("tree", "tree diagram", "org chart", "hierarchy")) + ": ")
    root = d.span(words.label(rng, 10))
    n = int(rng.integers(2, 5))
    d.say("; ")
    kids = _labels(d, rng, n, 8)
    rs = fit_size(d.length(root), 60, (7, 6, 5))
    rw = max(30.0, d.length(root) * ADV * rs + 8)
    d.add("RECT", 64 - rw / 2, 14, 64 + rw / 2, 32)
    d.text_center(64, 23, rs, root)
    slot = 116.0 / n
    s = fit_size(max(d.length(k) for k in kids), slot - 8, (6, 5, 4, 3))
    xs = [6 + slot * (i + 0.5) for i in range(n)]
    d.line((64, 32), (64, 58))
    d.line((xs[0], 58), (xs[-1], 58))
    for x, sp in zip(xs, kids):
        d.line((x, 58), (x, 82))
        d.add("RECT", x - slot / 2 + 3, 82, x + slot / 2 - 3, 100)
        d.text_center(x, 91, s, sp)
    return d


def gen_timeline(rng) -> Doc | None:
    d = Doc("timeline")
    d.say(d.style(rng, hand_p=0.4) + pick(rng, ("timeline", "timeline", "roadmap", "milestones")) + ": ")
    n = int(rng.integers(2, 6))
    year = int(rng.integers(1990, 2026))
    keys, vals = [], []
    for i in range(n):
        if i:
            d.say("; ")
        year += int(rng.integers(1, 4))
        keys.append(d.span(str(year)))
        d.say(" ")
        vals.append(d.span(words.label(rng, 8)))
    step = 100.0 / (n - 1)
    s = fit_size(max(d.length(v) for v in vals), step - 2, (6, 5, 4, 3))
    ks = fit_size(4, step - 2, (5, 4, 3))
    d.arrow(6, 64, 123, 64)
    for i in range(n):
        x = 14 + i * step
        d.add("DISC", x, 64, 2.2)
        d.text_center(x, 54, ks, keys[i])
        d.text_center(x, 75, s, vals[i])
    return d


def gen_venn(rng) -> Doc | None:
    d = Doc("venn")
    d.say(d.style(rng, hand_p=0.5) + pick(rng, ("venn diagram", "venn diagram", "venn")) + ": ")
    n = 2 if rng.random() < 0.6 else 3
    sets = _labels(d, rng, n, 6)
    if n == 2:
        circles, spots = [(46, 64, 31), (82, 64, 31)], [(31, 64), (97, 64)]
    else:
        circles, spots = [(48, 48, 27), (80, 48, 27), (64, 78, 27)], [(36, 38), (92, 38), (64, 92)]
    for c in circles:
        d.add("CIRC", *c)
    for (x, y), sp in zip(spots, sets):
        d.text_center(x, y, 5 if d.length(sp) <= 5 else 4, sp)
    return d


def gen_cycle(rng) -> Doc | None:
    d = Doc("cycle")
    d.say(d.style(rng, hand_p=0.45) + pick(rng, ("cycle", "cycle diagram", "loop", "circular process")) + ": ")
    n = int(rng.integers(3, 6))
    nodes = _labels(d, rng, n, 6)
    R = 40.0
    span = 360.0 / n
    for i, sp in enumerate(nodes):
        a0 = -90 + span * i
        a = math.radians(a0)
        s = 5 if d.length(sp) <= 5 else 4
        d.text_center(64 + R * math.cos(a), 64 + R * math.sin(a), s, sp)
        pad = 26 if n <= 4 else 22
        arc = [math.radians(a0 + pad + (span - 2 * pad) * t) for t in (0.0, 0.5, 1.0)]
        pts = [(64 + R * math.cos(t), 64 + R * math.sin(t)) for t in arc]
        d.add("CURVE", pts)
        t = arc[-1]
        tip = (64 + R * math.cos(t + 0.09), 64 + R * math.sin(t + 0.09))
        nx, ny = math.cos(t), math.sin(t)
        d.add("FILL", [tip, (pts[-1][0] + 2 * nx, pts[-1][1] + 2 * ny), (pts[-1][0] - 2 * nx, pts[-1][1] - 2 * ny)])
    return d


def gen_stack(rng) -> Doc | None:
    d = Doc("stack")
    kw = pick(rng, ("stack", "stack", "layers", "layer diagram", "pyramid"))
    d.say(d.style(rng, hand_p=0.35) + kw + ": ")
    n = int(rng.integers(2, 6))
    rows = _labels(d, rng, n, 10)
    h = min(20.0, 108.0 / n)
    y = (128 - n * h) / 2
    s = min(fit_size(max(d.length(r) for r in rows), 50 if kw == "pyramid" else 80, (8, 7, 6, 5, 4)), int(h * 0.55))
    s = max(3, s)
    for i, sp in enumerate(rows):
        if kw == "pyramid":
            w0, w1 = 30 + 78 * i / n, 30 + 78 * (i + 1) / n
            d.add("POLY", [(64 - w0 / 2, y), (64 + w0 / 2, y), (64 + w1 / 2, y + h), (64 - w1 / 2, y + h)])
        else:
            d.add("RECT", 18, y, 110, y + h)
        d.text_center(64, y + h / 2, s, sp)
        y += h
    return d


def gen_matrix(rng) -> Doc | None:
    d = Doc("matrix")
    d.say(d.style(rng, hand_p=0.35) + pick(rng, ("2x2 matrix", "quadrant chart", "four quadrants")) + ": ")
    cells = _labels(d, rng, 4, 8)
    d.add("RECT", 8, 8, 120, 120)
    d.line((64, 8), (64, 120))
    d.line((8, 64), (120, 64))
    s = fit_size(max(d.length(c) for c in cells), 50, (7, 6, 5, 4))
    for (x, y), sp in zip(((36, 36), (92, 36), (36, 92), (92, 92)), cells):
        d.text_center(x, y, s, sp)
    return d


GENERATORS = {
    "flow": (gen_flow, 3.0),
    "steps": (gen_steps, 1.5),
    "mindmap": (gen_mindmap, 2.0),
    "tree": (gen_tree, 1.5),
    "timeline": (gen_timeline, 1.5),
    "venn": (gen_venn, 1.0),
    "cycle": (gen_cycle, 1.2),
    "stack": (gen_stack, 1.2),
    "matrix": (gen_matrix, 0.8),
}
