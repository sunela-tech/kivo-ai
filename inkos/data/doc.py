"""Doc: builds a prompt and its InkScript program side by side.

Generators append text to the prompt with say() (plain words) or span()
(text the drawing will quote). span() returns the character range, which is
what the model's pointer head learns to emit.
"""
from __future__ import annotations

import math

import numpy as np

from ..vector.font import ADV, LINE_H, chars_per_line, wrap_text
from .words import pick

GAP = ADV - 0.567   # blank space on the right of every glyph cell, in text-size units

# adjective -> state op. The first group selects pen style, the second weight.
HAND_WORDS = ("handwritten", "hand-drawn", "sketchy", "rough")
CLEAN_WORDS = ("clean", "neat", "printed", "tidy")
BOLD_WORDS = ("bold", "thick", "heavy")
THIN_WORDS = ("thin", "fine", "light")


class Doc:
    def __init__(self, kind: str):
        self.kind = kind
        self.prompt = ""
        self.ops: list[tuple] = []
        self.hand = False
        self.weight = 2

    # -- prompt -----------------------------------------------------------
    def say(self, s: str) -> "Doc":
        self.prompt += s
        return self

    def span(self, s: str) -> tuple[int, int]:
        i = len(self.prompt)
        self.prompt += s
        return (i, len(self.prompt) - 1)

    def text_of(self, item) -> str:
        return item if isinstance(item, str) else self.prompt[item[0]: item[1] + 1]

    def length(self, *items) -> int:
        return sum(len(self.text_of(i)) for i in items)

    # -- style ------------------------------------------------------------
    def style(self, rng: np.random.Generator, hand_p: float = 0.5, adj_p: float = 0.45) -> str:
        """Choose pen style and weight; returns the adjectives to put in the prompt.

        A named style is always honoured. With no adjective the style is free,
        so sampling the model with a bare prompt gives varied results.
        """
        words = []
        if rng.random() < adj_p:
            self.hand = rng.random() < hand_p
            words.append(pick(rng, HAND_WORDS if self.hand else CLEAN_WORDS))
        else:
            self.hand = rng.random() < hand_p
        r = rng.random()
        if r < 0.12:
            self.weight = 3
            words.insert(0, pick(rng, BOLD_WORDS))
        elif r < 0.22:
            self.weight = 1
            words.insert(0, pick(rng, THIN_WORDS))
        else:
            self.weight = 2
        self.ops.append(("HAND",) if self.hand else ("CLEAN",))
        self.ops.append(("W", self.weight))
        return " ".join(words) + (" " if words else "")

    def w(self, weight: int):
        weight = int(min(4, max(1, weight)))
        if not self.ops or self.ops[-1] != ("W", weight):
            self.ops.append(("W", weight))

    # -- drawing ----------------------------------------------------------
    def add(self, *op):
        self.ops.append(tuple(op))

    def line(self, *pts):
        self.ops.append(("LINE", [tuple(p) for p in pts]))

    def text(self, x, y, size, *items, wrap=127) -> int:
        """Add a TEXT op; returns how many lines it occupies once wrapped."""
        size = int(round(size))
        self.ops.append(("TEXT", x, y, size, wrap, list(items)))
        s = "".join(self.text_of(i) for i in items)
        return len(wrap_text(s, chars_per_line(size, wrap)))

    def text_center(self, cx, cy, size, *items):
        """One line of text centred on (cx, cy)."""
        size = int(round(size))
        n = self.length(*items)
        x = cx - (n * ADV - GAP) * size / 2
        self.ops.append(("TEXT", x, cy - size / 2, size, 127, list(items)))

    def text_right(self, xr, y, size, *items):
        size = int(round(size))
        n = self.length(*items)
        self.ops.append(("TEXT", xr - (n * ADV - GAP) * size, y, size, 127, list(items)))

    def arrow(self, x0, y0, x1, y1, head: float = 3.0):
        """Line with a filled arrow head at (x1, y1)."""
        a = math.atan2(y1 - y0, x1 - x0)
        bx, by = x1 - head * math.cos(a), y1 - head * math.sin(a)
        self.line((x0, y0), (bx, by))
        px, py = -math.sin(a) * head * 0.55, math.cos(a) * head * 0.55
        self.ops.append(("FILL", [(x1, y1), (bx + px, by + py), (bx - px, by - py)]))


def fit_size(n_chars: int, width: float, choices=(10, 8, 7, 6, 5, 4)) -> int:
    """Largest text size from choices whose line of n_chars fits in width."""
    for s in choices:
        if (n_chars * ADV - GAP) * s <= width:
            return s
    return choices[-1]


def line_count(text: str, size: float, wrap: float) -> int:
    return len(wrap_text(text, chars_per_line(size, wrap)))


__all__ = ["Doc", "fit_size", "line_count", "ADV", "LINE_H", "GAP"]
