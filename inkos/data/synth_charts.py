"""Synthetic charts for INKOS 1: bar, line, pie, scatter and progress.

The numbers in the prompt decide the geometry, so these samples teach the
model to turn written values into positions.

  bar chart: 3, 7, 5, 9             values 0..10, or 0..100 if any is above 10
  bar chart Sales: Mon 3, Tue 7     heading and labels are optional
  line chart: 1, 4, 2, 8, 5
  pie chart: Rent 50, Food 30, Fun 20      shares in percent
  scatter plot: 1 2, 3 5, 6 4       x y pairs, 0..10
  progress bar: 70%
"""
from __future__ import annotations

import math

import numpy as np

from . import words
from .doc import ADV, GAP, Doc, fit_size
from .words import pick


def _values(rng, n: int) -> tuple[list[int], int]:
    scale = 10 if rng.random() < 0.6 else 100
    while True:
        if scale == 10:
            vals = [int(v) for v in rng.integers(0, 11, n)]
        else:
            vals = [int(v) for v in rng.integers(0, 101, n)]
            if max(vals) <= 10:
                continue
        if max(vals) > 0:
            return vals, scale


def _series(d: Doc, rng, n: int, labelled: bool):
    """Write 'L v, L v' to the prompt. Returns (label spans, value spans, values, scale)."""
    vals, scale = _values(rng, n)
    labels = None
    if labelled:
        pool = [s.split() for s in words.CHART_LABELS if len(s.split()) >= n]
        labels = pick(rng, pool)[:n] if pool and rng.random() < 0.8 else [words.label(rng, 5) for _ in range(n)]
    lsp, vsp = [], []
    for i, v in enumerate(vals):
        if i:
            d.say(", ")
        if labels:
            lsp.append(d.span(labels[i]))
            d.say(" ")
        vsp.append(d.span(str(v)))
    return lsp, vsp, vals, scale


def _axes(d: Doc, ox, oy, top, right, scale, heading):
    if heading:
        s = fit_size(d.length(heading), 110, (7, 6, 5))
        d.text_center(64, 3 + s / 2 + 1, s, heading)
    d.line((ox, top - 3), (ox, oy), (right + 2, oy))
    for frac in (0.0, 0.5, 1.0):
        y = oy - frac * (oy - top)
        if frac:
            d.line((ox - 2, y), (ox, y))
        d.text_right(ox - 3, y - 2, 4, str(int(round(scale * frac))))


def _head(d: Doc, rng, kw: str, hand_p=0.35):
    d.say(d.style(rng, hand_p=hand_p) + kw)
    heading = None
    if rng.random() < 0.3:
        d.say(" ")
        heading = d.span(words.title(rng))
    d.say(": ")
    return heading


def gen_bar(rng) -> Doc | None:
    d = Doc("bar")
    filled = rng.random() < 0.3
    valued = rng.random() < 0.25
    kw = ("labeled " if valued else "") + ("filled " if filled else "") + pick(
        rng, ("bar chart", "bar chart", "bar graph", "column chart", "bars"))
    heading = _head(d, rng, kw)
    n = int(rng.integers(2, 9))
    lsp, vsp, vals, scale = _series(d, rng, n, rng.random() < 0.55)
    ox, right = 17, 120
    oy = 106 if lsp else 113
    top = 22 if heading else 12
    _axes(d, ox, oy, top, right, scale, heading)
    slot = (right - ox) / n
    bw = slot * 0.62
    for i, v in enumerate(vals):
        x = ox + slot * i + (slot - bw) / 2
        h = v / scale * (oy - top)
        if h >= 1:
            d.add("BOX" if filled else "RECT", x, oy - h, x + bw, oy)
        if valued:
            d.text_center(x + bw / 2, oy - h - 4.5, 4, vsp[i])
    if lsp:
        s = fit_size(max(d.length(l) for l in lsp), slot - 0.5, (5, 4, 3))
        for i, l in enumerate(lsp):
            d.text_center(ox + slot * (i + 0.5), oy + 3 + s / 2, s, l)
    return d


def gen_line(rng) -> Doc | None:
    d = Doc("line")
    heading = _head(d, rng, pick(rng, ("line chart", "line chart", "line graph", "trend line", "trend")))
    n = int(rng.integers(3, 11))
    lsp, _, vals, scale = _series(d, rng, n, n <= 7 and rng.random() < 0.4)
    ox, right = 17, 120
    oy = 106 if lsp else 113
    top = 22 if heading else 12
    _axes(d, ox, oy, top, right, scale, heading)
    step = (right - ox - 8) / (n - 1)
    pts = [(ox + 4 + i * step, oy - v / scale * (oy - top)) for i, v in enumerate(vals)]
    d.line(*pts)
    if n <= 8:
        for x, y in pts:
            d.add("DISC", x, y, 1.5)
    if lsp:
        s = fit_size(max(d.length(l) for l in lsp), step - 0.5, (5, 4, 3))
        for (x, _), l in zip(pts, lsp):
            d.text_center(x, oy + 3 + s / 2, s, l)
    return d


def gen_pie(rng) -> Doc | None:
    d = Doc("pie")
    donut = rng.random() < 0.25
    heading = _head(d, rng, "donut chart" if donut else pick(rng, ("pie chart", "pie chart", "pie")))
    n = int(rng.integers(2, 6))
    cuts = sorted(int(c) * 5 for c in rng.choice(np.arange(1, 20), n - 1, replace=False))
    shares = [b - a for a, b in zip([0] + cuts, cuts + [100])]
    labelled = rng.random() < 0.5
    lsp = []
    for i, v in enumerate(shares):
        if i:
            d.say(", ")
        if labelled:
            lsp.append(d.span(words.label(rng, 6)))
            d.say(" ")
        d.span(str(v))
    cx, cy = 64, 68 if heading else 64
    r = 34 if labelled else (44 if not heading else 40)
    if heading:
        s = fit_size(d.length(heading), 110, (7, 6, 5))
        d.text_center(64, 3 + s / 2 + 1, s, heading)
    d.add("CIRC", cx, cy, r)
    acc = 0
    for i, v in enumerate(shares):
        a = math.radians(-90 + acc * 3.6)
        d.line((cx, cy), (cx + r * math.cos(a), cy + r * math.sin(a)))
        if labelled:
            m = math.radians(-90 + (acc + v / 2) * 3.6)
            s = 5 if d.length(lsp[i]) <= 4 else 4
            half = (d.length(lsp[i]) * ADV - GAP) * s / 2
            lx = min(126 - half, max(1 + half, cx + (r + 8) * math.cos(m)))
            d.text_center(lx, cy + (r + 7) * math.sin(m), s, lsp[i])
        acc += v
    if donut:
        d.add("ERASE")
        d.add("DISC", cx, cy, r * 0.5)
        d.add("INK")
        d.add("CIRC", cx, cy, r * 0.5)
    return d


def gen_scatter(rng) -> Doc | None:
    d = Doc("scatter")
    heading = _head(d, rng, pick(rng, ("scatter plot", "scatter plot", "scatter chart", "dot plot")))
    n = int(rng.integers(3, 13))
    pts = []
    for i in range(n):
        if i:
            d.say(", ")
        x, y = int(rng.integers(0, 11)), int(rng.integers(0, 11))
        d.span(f"{x} {y}")
        pts.append((x, y))
    ox, right, oy = 17, 118, 110
    top = 22 if heading else 12
    _axes(d, ox, oy, top, right, 10, heading)
    for frac in (0.5, 1.0):
        x = ox + frac * (right - ox)
        d.line((x, oy), (x, oy + 2))
        d.text_center(x, oy + 6, 4, str(int(10 * frac)))
    for x, y in pts:
        d.add("DISC", ox + x / 10 * (right - ox), oy - y / 10 * (oy - top), 1.6)
    return d


def gen_progress(rng) -> Doc | None:
    d = Doc("progress")
    kw = pick(rng, ("progress bar", "progress bar", "progress", "loading bar", "battery", "meter"))
    d.say(d.style(rng, hand_p=0.3) + kw)
    label = None
    if rng.random() < 0.4:
        d.say(" ")
        label = d.span(words.label(rng, 10))
    d.say(": ")
    pct = int(rng.integers(0, 21)) * 5
    psp = d.span(f"{pct}%")
    if kw == "battery":
        d.add("RECT", 22, 46, 100, 84)
        d.add("BOX", 100, 57, 105, 73)
        if pct:
            d.add("BOX", 25, 49, 25 + 0.72 * pct, 81)
        d.text_center(61, 32, 10, psp)
    else:
        d.add("RECT", 12, 56, 116, 74)
        if pct:
            d.add("BOX", 14, 58, 14 + pct, 72)
        d.text_center(64, 42, 10, psp)
    if label:
        d.text_center(64, 96, fit_size(d.length(label), 100, (8, 7, 6)), label)
    return d


GENERATORS = {
    "bar": (gen_bar, 3.0),
    "line": (gen_line, 2.0),
    "pie": (gen_pie, 1.5),
    "scatter": (gen_scatter, 1.0),
    "progress": (gen_progress, 1.0),
}
