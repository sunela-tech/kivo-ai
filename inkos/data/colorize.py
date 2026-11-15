"""Turn black-and-white drawing programs into colour ones for INKOS 1.1.

A colour sample is a normal sample plus a colour instruction at the very
start of the prompt. Four schemes, picked at random:

  (none)              "note Groceries: milk; eggs"      black, as before
  one colour          "blue note Groceries: ..."        everything in blue
  two colours         "black and red todo: ..."         text in the first, marks in the second
  colourful           "colorful bar chart: 3, 7, 5"     shapes filled red, yellow, blue, green in turn

In the colourful scheme outlines stay black, and lettering that sits on a
dark fill is written in white.
"""
from __future__ import annotations

import numpy as np

from .. import palette
from ..vector.font import ADV
from .doc import Doc
from .words import pick

INK_WORDS = ("red", "blue", "green", "red", "blue", "green", "yellow", "black")
CYCLE = (palette.RED, palette.YELLOW, palette.BLUE, palette.GREEN)
OUTLINES = {"RECT": "BOX", "CIRC": "DISC", "POLY": "FILL", "BLOB": "FBLOB", "ELLI": "FBLOB"}
FILLS = ("BOX", "DISC", "FILL", "FBLOB")
CANVAS = 128.0 * 128.0


def _bbox(op) -> tuple[float, float, float, float]:
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
    xs, ys = [p[0] for p in op[1]], [p[1] for p in op[1]]
    return min(xs), min(ys), max(xs), max(ys)


def _area(op) -> float:
    x0, y0, x1, y1 = _bbox(op)
    return max(0.0, x1 - x0) * max(0.0, y1 - y0) / CANVAS


def _fill_for(op) -> tuple:
    """The filled counterpart of an outline op."""
    name = op[0]
    if name == "ELLI":
        cx, cy, rx, ry = op[1:]
        a = np.linspace(0, 2 * np.pi, 8, endpoint=False)
        return ("FBLOB", [(cx + rx * np.cos(t), cy + ry * np.sin(t)) for t in a])
    return (OUTLINES[name], *op[1:])


def _shift(ops: list[tuple], k: int) -> list[tuple]:
    out = []
    for op in ops:
        if op[0] == "TEXT":
            items = [it if isinstance(it, str) else (it[0] + k, it[1] + k) for it in op[5]]
            op = (*op[:5], items)
        out.append(op)
    return out


def _is_mark(op) -> bool:
    return op[0] not in ("W", "INK", "ERASE", "SOLID", "DASH", "CLEAN", "HAND", "COLOR", "TEXT")


def _one(ops, c):
    return [("COLOR", c)] + ops


def _two(ops, c_text, c_marks):
    out, cur = [], None
    for op in ops:
        want = c_text if op[0] == "TEXT" else c_marks if _is_mark(op) else None
        if want is not None and want != cur:
            out.append(("COLOR", want))
            cur = want
        out.append(op)
    return out


def _colourful(d: Doc, ops):
    """-> new ops, or None when the drawing has nothing worth filling."""
    out, cur, k = [], palette.BLACK, 0
    filled: list[tuple[tuple, int]] = []         # (bbox, colour) of what has been filled so far

    def pen(c):
        nonlocal cur
        if c != cur:
            out.append(("COLOR", c))
            cur = c

    for op in ops:
        name = op[0]
        if name in OUTLINES and 0.004 <= _area(op) <= 0.45:
            c = CYCLE[k % len(CYCLE)]
            k += 1
            pen(c)
            out.append(_fill_for(op))
            filled.append((_bbox(op), c))
            pen(palette.BLACK)
            out.append(op)
        elif name in FILLS and _area(op) >= 0.005:
            c = CYCLE[k % len(CYCLE)]
            k += 1
            pen(c)
            out.append(op)
            filled.append((_bbox(op), c))
        elif name == "TEXT":
            _, x, y, s, _w, items = op
            n = sum(len(d.text_of(i)) for i in items)
            cx, cy = x + min(n, 40) * ADV * s / 2, y + s / 2
            on = [c for (x0, y0, x1, y1), c in filled if x0 <= cx <= x1 and y0 <= cy <= y1]
            pen(palette.WHITE if on and on[-1] in palette.DARK else palette.BLACK)
            out.append(op)
        else:
            if _is_mark(op):
                pen(palette.BLACK)
            out.append(op)
    return out if k else None


def colorize(d: Doc, rng: np.random.Generator, max_prompt: int) -> Doc:
    """Give a black-and-white Doc a colour scheme. Changes the Doc in place and returns it."""
    has_text = any(op[0] == "TEXT" for op in d.ops)
    has_marks = any(_is_mark(op) for op in d.ops)
    r = rng.random()
    prefix, ops = "", None
    if r < 0.18:
        return d
    if r < 0.55:
        ops = _colourful(d, d.ops)
        prefix = pick(rng, ("colorful ", "colorful ", "colourful ", "multicolor "))
    elif r < 0.72 and has_text and has_marks:
        c1 = pick(rng, ("black", "black", "blue", "red", "green"))
        c2 = pick(rng, [c for c in ("red", "blue", "green", "yellow", "black") if c != c1])
        ops, prefix = _two(d.ops, palette.INDEX[c1], palette.INDEX[c2]), f"{c1} and {c2} "
    if ops is None:
        c = pick(rng, INK_WORDS)
        ops, prefix = _one(d.ops, palette.INDEX[c]), f"{c} "
    if len(prefix) + len(d.prompt) > max_prompt:
        return d
    d.ops = _shift(ops, len(prefix))
    d.prompt = prefix + d.prompt
    return d
