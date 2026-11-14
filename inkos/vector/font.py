"""A single-stroke font drawn for this project.

Every glyph is a handful of pen strokes on a 6 x 13 design grid
(y: 0 descender, 3 baseline, 9 x-height, 12 cap height). A stroke with three or
more points is a control polygon that gets corner-cut into a smooth curve, so
separate strokes meet at sharp corners and single strokes bend. Rendering with
jitter (see render.py) gives the handwritten look.

Strokes are written as packed "xy" pairs, base-14 digits (a=10 .. d=13).
"""
from __future__ import annotations

import numpy as np

ADV = 0.72      # horizontal advance, in units of text size (= cap height)
LINE_H = 1.6    # line spacing, in units of text size
_XSCALE = 0.85 / 9.0
_BASE, _CAP = 3.0, 9.0

_G = {
    "A": "033c 3c63 1656",
    "B": "030c 0c3c5b593808 083867643303",
    "C": "6a4c2c0a05234365",
    "D": "030c 0c3c6a653303",
    "E": "6c0c 0c03 0363 0848",
    "F": "6c0c 0c03 0848",
    "G": "6a4c2c0a05234365 6567 6737",
    "H": "030c 636c 0868",
    "I": "333c 1353 1c5c",
    "J": "5c57432305",
    "K": "030c 6c07 2863",
    "L": "0c03 0363",
    "M": "030c 0c37 376c 6c63",
    "N": "030c 0c63 636c",
    "O": "3c1b090614335466695b3c",
    "P": "030c 0c3c6b683707",
    "Q": "3c1b090614335466695b3c 4562",
    "R": "030c 0c3c6b683707 3763",
    "S": "6a4c2c0a0928476665432305",
    "T": "0c6c 3c33",
    "U": "0c052343656c",
    "V": "0c33 336c",
    "W": "0c13 1338 3853 536c",
    "X": "0c63 6c03",
    "Y": "0c38 6c38 3833",
    "Z": "0c6c 6c03 0363",
    "a": "57391806143355 5953",
    "b": "0c03 07294856442305",
    "c": "58391806143354",
    "d": "5c53 57391806143355",
    "e": "0656 5658391806143354",
    "f": "5b4c2c1a13 0848",
    "g": "57391806143355 5952301001",
    "h": "0c03 0729495753",
    "i": "3933 3b3c",
    "j": "39322001 3b3c",
    "k": "0c03 5906 2753",
    "l": "2c243343",
    "m": "0903 0719293833 3749596863",
    "n": "0903 0729495753",
    "o": "2918061423334456483929",
    "p": "0900 07294856442305",
    "q": "5950 57391806143355",
    "r": "0903 07294958",
    "s": "58391908164654432304",
    "t": "2c243354 0949",
    "u": "0905133355 5953",
    "v": "0933 3369",
    "w": "0913 1337 3753 5369",
    "x": "0953 5903",
    "y": "0933 6910",
    "z": "0959 5903 0353",
    "0": "3c1a1533555a3c",
    "1": "1a3c 3c33 1353",
    "2": "0a2c4c6a6803 0363",
    "3": "0b2c4c6a694828 28486765432304",
    "4": "5c06 0666 5c53",
    "5": "6c1c 1c08 0829496765432304",
    "6": "5c3b19060523436566482806",
    "7": "0c6c 6c23",
    "8": "3c1b1938595b3c 38070433646738",
    "9": "694727090a2c4c6a67553313",
    ".": "3334",
    ",": "3422",
    ":": "3334 3839",
    ";": "3839 3422",
    "!": "3c36 3334",
    "?": "0a2c4c6a683735 3334",
    "-": "1757",
    "_": "0262",
    "+": "1757 3a34",
    "=": "1959 1555",
    "/": "036c",
    "\\": "0c63",
    "(": "4d2a2542",
    ")": "2d4a4522",
    "[": "4d2d 2d22 2242",
    "]": "2d4d 4d42 4222",
    "{": "4d2a2542",
    "}": "2d4a4522",
    "<": "5b17 1753",
    ">": "1b57 5713",
    "*": "3b35 1a56 5a16",
    "#": "2c13 5c43 0a6a 0565",
    "%": "036c 1c0b1a2b1c 5544536455",
    "&": "63191b3c4a05133366",
    "@": "553638585566694b2b09052353",
    "'": "3c3a",
    '"': "2c2a 4c4a",
    "`": "2c4a",
    "^": "193c 3c59",
    "~": "07284667",
    "|": "3d32",
    "$": "6a4c2c0a0928476665432305 3d32",
    " ": "",
}


def _chaikin(p: np.ndarray, iters: int = 2) -> np.ndarray:
    closed = len(p) > 3 and np.allclose(p[0], p[-1])
    for _ in range(iters):
        if closed:
            a = p[:-1]
            b = np.roll(a, -1, axis=0)
            new = np.empty((2 * len(a), 2))
            new[0::2] = 0.75 * a + 0.25 * b
            new[1::2] = 0.25 * a + 0.75 * b
            p = np.vstack([new, new[:1]])
        else:
            a, b = p[:-1], p[1:]
            new = np.empty((2 * len(a), 2))
            new[0::2] = 0.75 * a + 0.25 * b
            new[1::2] = 0.25 * a + 0.75 * b
            p = np.vstack([p[:1], new, p[-1:]])
    return p


def _build() -> dict[str, list[np.ndarray]]:
    out = {}
    for ch, spec in _G.items():
        strokes = []
        for s in spec.split():
            pts = np.array([[int(s[i], 14), int(s[i + 1], 14)] for i in range(0, len(s), 2)], dtype=float)
            if len(pts) >= 3:
                pts = _chaikin(pts)
            pts[:, 0] *= _XSCALE
            pts[:, 1] = (pts[:, 1] - _BASE) / _CAP   # y up, baseline = 0, cap height = 1
            strokes.append(pts)
        out[ch] = strokes
    return out


GLYPHS = _build()


def glyph(ch: str) -> list[np.ndarray]:
    """Strokes of a character in em units (cap height 1, y up from baseline)."""
    return GLYPHS.get(ch) or GLYPHS["?"]


def chars_per_line(size: float, wrap: float) -> int:
    return max(1, int(wrap / (ADV * max(size, 1e-6)) + 1e-6))


def wrap_text(text: str, cpl: int) -> list[str]:
    """Greedy word wrap to at most cpl characters per line; long words are split."""
    lines: list[str] = []
    cur = ""
    for word in text.split(" "):
        while len(word) > cpl:
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(word[:cpl])
            word = word[cpl:]
        if not cur:
            cur = word
        elif len(cur) + 1 + len(word) <= cpl:
            cur += " " + word
        else:
            lines.append(cur)
            cur = word
    if cur or not lines:
        lines.append(cur)
    return lines


def text_width(n_chars: int, size: float) -> float:
    return n_chars * ADV * size
