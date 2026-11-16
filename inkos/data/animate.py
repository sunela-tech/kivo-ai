"""Turn colour drawing programs into animated ones for INKOS MOTION 1.

A motion sample is an INKOS 1.1 sample plus an animation word at the start of
the prompt, and AT / ANIM commands in the program (see inkos.vector.motion):

  "typing blue note Groceries: milk; eggs"       the text is written letter by letter
  "growing colorful bar chart: Mon 3, Tue 7"     bars rise one after another
  "step by step colorful flowchart: A -> B"      parts appear in order: lines drawn, shapes popping in
  "drawing green sketch of a tree"               every stroke is drawn along its length
  "popping ...", "sliding ..."                   parts pop in / slide in one after another
  "spinning yellow sun", "bouncing red heart", "blinking ..."   the whole picture moves

Without an animation word the picture simply stands still.
"""
from __future__ import annotations

import numpy as np

from ..vector import lang
from ..vector.motion import STATE
from .colorize import _shift
from .doc import Doc
from .words import pick

TEXTISH = {"note", "todo", "journal", "keyed", "table", "sign"}
BARS = {"bar", "progress", "stack", "count"}
WHOLE = {"symbol", "clock", "count", "pair", "icon", "sketch"}
PATHS = {"LINE", "CURVE", "POLY", "BLOB", "RECT", "CIRC", "ELLI"}
FILLS = {"FILL", "FBLOB", "BOX", "DISC"}

STYLES = {   # style -> (prompt words, weight)
    "static": ((), 0.06),
    "seq": (("animated ", "step by step ", "animated ", "step-by-step "), 0.26),
    "type": (("typing ", "typed "), 0.12),
    "grow": (("growing ", "rising "), 0.1),
    "draw": (("drawing ", "self-drawing "), 0.12),
    "pop": (("popping ", "pop-in "), 0.08),
    "slide": (("sliding ", "slide-in "), 0.06),
    "spin": (("spinning ", "rotating "), 0.07),
    "bounce": (("bouncing ", "jumping "), 0.07),
    "blink": (("blinking ", "flashing "), 0.06),
}


def _slots(n: int) -> list[int]:
    """Start slots for n parts in order: 3 slots apart, squeezed to fit before slot 15."""
    if n <= 1:
        return [0] * n
    step = min(3.0, 15.0 / (n - 1))
    return [min(lang.SLOTS - 1, int(round(i * step))) for i in range(n)]


def _possible(kind: str, ops) -> list[str]:
    has_text = any(op[0] == "TEXT" for op in ops)
    has_bars = any(op[0] in ("BOX", "FILL") for op in ops)
    out = ["static", "seq", "pop", "slide"]
    if has_text:
        out.append("type")
    if kind in BARS and has_bars:
        out.append("grow")
    if kind in WHOLE or kind in ("line", "flow", "mindmap", "tree", "cycle"):
        out.append("draw")
    if kind in WHOLE:
        out += ["spin", "bounce", "blink"]
    elif kind == "sign":
        out.append("blink")
    return out


def _plan(style: str, ops) -> list[tuple[int, str] | None]:
    """For every op: (start slot, effect) for drawing commands, None for state commands."""
    draw = [i for i, op in enumerate(ops) if op[0] not in STATE]
    plan: list = [None] * len(ops)
    if style in ("spin", "bounce", "blink"):
        for i in draw:
            plan[i] = (0, style.upper())
        return plan
    if style == "static":
        for i in draw:
            plan[i] = (0, "STILL")
        return plan
    pick_ = {"type": lambda op: op[0] == "TEXT", "grow": lambda op: op[0] in ("BOX", "FILL")}.get(style, lambda op: True)
    moving = [i for i in draw if pick_(ops[i])]
    for i in draw:
        plan[i] = (0, "STILL")
    for i, slot in zip(moving, _slots(len(moving))):
        op = ops[i]
        if style == "seq":
            eff = "DRAW" if op[0] in PATHS or op[0] == "TEXT" else "POP"
        elif style == "type":
            eff = "DRAW"
        elif style == "grow":
            eff = "GROW"
        elif style == "draw":
            eff = "DRAW"
        else:
            eff = style.upper()
        plan[i] = (slot, eff)
    return plan


def apply(ops, plan) -> list[tuple]:
    out, at, eff = [], 0, "STILL"
    for op, p in zip(ops, plan):
        if p is not None:
            slot, e = p
            if slot != at:
                out.append(("AT", slot))
                at = slot
            if e != eff:
                out.append(("ANIM", e))
                eff = e
        out.append(op)
    return out


def animate(d: Doc, kind: str, rng: np.random.Generator, max_prompt: int, max_tokens: int) -> Doc:
    """Give a (colour) Doc an animation. Changes the Doc in place and returns it."""
    options = _possible(kind, d.ops)
    w = np.array([STYLES[s][1] for s in options])
    order = [options[i] for i in rng.choice(len(options), size=len(options), replace=False, p=w / w.sum())]
    for style in order:
        words = STYLES[style][0]
        prefix = pick(rng, words) if words else ""
        if len(prefix) + len(d.prompt) > max_prompt:
            continue
        ops = apply(d.ops, _plan(style, d.ops))
        if len(lang.encode(ops, lang.VOCAB_MOTION)) + 1 > max_tokens:
            continue
        d.ops = _shift(ops, len(prefix))
        d.prompt = prefix + d.prompt
        return d
    return d
