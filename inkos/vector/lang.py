"""InkScript: the compact drawing language INKOS 1 writes.

INKOS 1 does not paint pixels. It writes a short program of drawing commands
on a 128 x 128 grid, and a deterministic rasteriser (inkos.vector.render)
turns that program into a pure black/white bitmap at any resolution.

Program (python form)            Tokens
  ("W", 1..4)                    W1..W4            stroke weight
  ("INK",) / ("ERASE",)          INK / ERASE       draw in black / in white
  ("SOLID",) / ("DASH",)         SOLID / DASH      line style
  ("CLEAN",) / ("HAND",)         CLEAN / HAND      ruler-straight / hand-wobbled
  ("LINE",  [(x, y), ...])       LINE x y x y .. END     open polyline
  ("CURVE", [(x, y), ...])       CURVE ...  END          smooth open curve
  ("POLY",  [(x, y), ...])       POLY ...   END          closed outline
  ("BLOB",  [(x, y), ...])       BLOB ...   END          smooth closed outline
  ("FILL",  [(x, y), ...])       FILL ...   END          filled polygon
  ("FBLOB", [(x, y), ...])       FBLOB ...  END          filled smooth shape
  ("CIRC", cx, cy, r)            CIRC cx cy r            circle outline
  ("DISC", cx, cy, r)            DISC cx cy r            filled circle
  ("RECT", x0, y0, x1, y1)       RECT ...                rectangle outline
  ("BOX",  x0, y0, x1, y1)       BOX ...                 filled rectangle
  ("ELLI", cx, cy, rx, ry)       ELLI ...                ellipse outline
  ("TEXT", x, y, size, wrap, items)   TEXT x y s w item.. END

A TEXT item is either a literal string (the model spells it character by
character) or a span (i, j): "copy characters i..j of the prompt". Spans are
emitted through the model's pointer head as ids >= VOCAB, so text the user
typed is reproduced exactly instead of being re-spelled.
"""
from __future__ import annotations

import numpy as np

from ..prompts import FIRST_CHAR, LAST_CHAR, N_CHARS

GRID = 128

PAD, BOS, EOS = 0, 1, 2
PATH_MIN = {"LINE": 2, "CURVE": 2, "POLY": 3, "BLOB": 3, "FILL": 3, "FBLOB": 3}
FIXED_ARGS = {"CIRC": 3, "DISC": 3, "RECT": 4, "BOX": 4, "ELLI": 4}
STATE_CMDS = ("W1", "W2", "W3", "W4", "INK", "ERASE", "SOLID", "DASH", "CLEAN", "HAND")

NAMES = ["<pad>", "<bos>", "<eos>", *PATH_MIN, *FIXED_ARGS, *STATE_CMDS, "TEXT", "END"]
TOK = {n: i for i, n in enumerate(NAMES)}
COORD0 = len(NAMES)
CHAR0 = COORD0 + GRID
VOCAB = CHAR0 + N_CHARS

END = TOK["END"]
TEXT = TOK["TEXT"]
MAX_PATH_POINTS = 96
MAX_TEXT_ITEMS = 96
TEXT_ARGS = 4

_ID_TO_NAME = {i: n for n, i in TOK.items()}


def q(v: float) -> int:
    """Snap a coordinate to the grid."""
    return int(min(GRID - 1, max(0, round(float(v)))))


def char_token(c: str) -> int:
    o = ord(c)
    if not FIRST_CHAR <= o <= LAST_CHAR:
        o = ord("?")
    return CHAR0 + o - FIRST_CHAR


def token_char(t: int) -> str:
    return chr(t - CHAR0 + FIRST_CHAR)


def prompt_tokens(prompt: str) -> list[int]:
    return [char_token(c) for c in prompt]


def token_name(t: int) -> str:
    if t in _ID_TO_NAME:
        return _ID_TO_NAME[t]
    if COORD0 <= t < CHAR0:
        return str(t - COORD0)
    if CHAR0 <= t < VOCAB:
        return repr(token_char(t))
    return f"@{t - VOCAB}"


# --------------------------------------------------------------------------
# encode
# --------------------------------------------------------------------------

def encode(ops: list[tuple]) -> list[int]:
    """Program -> token ids (no BOS/EOS). Pointer tokens are VOCAB + index."""
    out: list[int] = []
    for op in ops:
        name = op[0]
        if name == "W":
            out.append(TOK[f"W{int(op[1])}"])
        elif name in STATE_CMDS:
            out.append(TOK[name])
        elif name in PATH_MIN:
            pts = op[1][:MAX_PATH_POINTS]
            if len(pts) < PATH_MIN[name]:
                raise ValueError(f"{name} needs at least {PATH_MIN[name]} points")
            out.append(TOK[name])
            for x, y in pts:
                out.append(COORD0 + q(x))
                out.append(COORD0 + q(y))
            out.append(END)
        elif name in FIXED_ARGS:
            args = op[1:]
            if len(args) != FIXED_ARGS[name]:
                raise ValueError(f"{name} takes {FIXED_ARGS[name]} arguments")
            out.append(TOK[name])
            out.extend(COORD0 + q(v) for v in args)
        elif name == "TEXT":
            _, x, y, s, w, items = op
            out.append(TEXT)
            out.extend(COORD0 + q(v) for v in (x, y, s, w))
            for it in items:
                if isinstance(it, str):
                    out.extend(char_token(c) for c in it)
                else:
                    i, j = it
                    if j < i:
                        raise ValueError("span end before start")
                    out.append(VOCAB + int(i))
                    out.append(VOCAB + int(j))
            out.append(END)
        else:
            raise ValueError(f"unknown op {name!r}")
    return out


# --------------------------------------------------------------------------
# grammar: incremental parser + "which tokens may come next"
# --------------------------------------------------------------------------

def _mask(ids) -> np.ndarray:
    m = np.zeros(VOCAB, dtype=bool)
    m[list(ids)] = True
    return m


_COORDS = range(COORD0, CHAR0)
_CHARS = range(CHAR0, VOCAB)
_M_TOP = _mask([EOS] + [TOK[n] for n in (*PATH_MIN, *FIXED_ARGS, *STATE_CMDS, "TEXT")])
_M_COORD = _mask(_COORDS)
_M_COORD_END = _mask([*_COORDS, END])
_M_END = _mask([END])
_M_ITEMS = _mask([*_CHARS, END])
_M_NONE = np.zeros(VOCAB, dtype=bool)


class Grammar:
    """Tracks a program as it is written one token at a time.

    allowed() returns a boolean mask over VOCAB + prompt_len ids; feed() consumes
    a token. Used both to parse finished programs and to constrain sampling so
    that every generated program is renderable.
    """

    def __init__(self, prompt_len: int = 0):
        self.P = int(prompt_len)
        self.ops: list[tuple] = []
        self.mode = "top"
        self.cmd = ""
        self.args: list[int] = []
        self.items: list = []
        self.n_items = 0
        self.span_start = 0
        self.done = False

    # -- which tokens are legal now ------------------------------------
    def allowed(self) -> np.ndarray:
        ptr = np.zeros(self.P, dtype=bool)
        m = _M_NONE
        if self.mode == "top":
            m = _M_TOP
        elif self.mode == "path":
            n = len(self.args)
            if n % 2 == 1:
                m = _M_COORD
            elif n // 2 >= MAX_PATH_POINTS:
                m = _M_END
            elif n // 2 >= PATH_MIN[self.cmd]:
                m = _M_COORD_END
            else:
                m = _M_COORD
        elif self.mode in ("fixed", "text_args"):
            m = _M_COORD
        elif self.mode == "items":
            if self.n_items >= MAX_TEXT_ITEMS:
                m = _M_END
            else:
                m = _M_ITEMS
                ptr[:] = True
        elif self.mode == "span_end":
            ptr[self.span_start:] = True
        return np.concatenate([m, ptr])

    # -- consume one token ----------------------------------------------
    def feed(self, t: int) -> bool:
        """Advance by one token. Returns False (and changes nothing) if illegal."""
        t = int(t)
        if self.done or t < 0 or t >= VOCAB + self.P or not self.allowed()[t]:
            return False
        if self.mode == "top":
            if t == EOS:
                self.done = True
                self.mode = "done"
                return True
            name = _ID_TO_NAME[t]
            if name in STATE_CMDS:
                self.ops.append(("W", int(name[1])) if name[0] == "W" else (name,))
            elif name in PATH_MIN:
                self.mode, self.cmd, self.args = "path", name, []
            elif name in FIXED_ARGS:
                self.mode, self.cmd, self.args = "fixed", name, []
            else:  # TEXT
                self.mode, self.cmd, self.args, self.items, self.n_items = "text_args", "TEXT", [], [], 0
        elif self.mode == "path":
            if t == END:
                pts = list(zip(self.args[0::2], self.args[1::2]))
                self.ops.append((self.cmd, pts))
                self.mode = "top"
            else:
                self.args.append(t - COORD0)
        elif self.mode == "fixed":
            self.args.append(t - COORD0)
            if len(self.args) == FIXED_ARGS[self.cmd]:
                self.ops.append((self.cmd, *self.args))
                self.mode = "top"
        elif self.mode == "text_args":
            self.args.append(t - COORD0)
            if len(self.args) == TEXT_ARGS:
                self.mode = "items"
        elif self.mode == "items":
            if t == END:
                self.ops.append(("TEXT", *self.args, self.items))
                self.mode = "top"
            elif t >= VOCAB:
                self.span_start = t - VOCAB
                self.mode = "span_end"
                self.n_items += 1
            else:
                c = token_char(t)
                if self.items and isinstance(self.items[-1], str):
                    self.items[-1] += c
                else:
                    self.items.append(c)
                self.n_items += 1
        elif self.mode == "span_end":
            self.items.append((self.span_start, t - VOCAB))
            self.mode = "items"
        return True

    @property
    def in_progress(self) -> bool:
        return self.mode not in ("top", "done")


def decode(tokens, prompt_len: int = 0) -> tuple[list[tuple], bool]:
    """Token ids -> (program, ok).

    Parsing stops at EOS, PAD or the first illegal token. ok is True only when
    the sequence was a complete, well-formed program terminated by EOS.
    Whatever was complete before a failure is still returned.
    """
    g = Grammar(prompt_len)
    for t in tokens:
        t = int(t)
        if t == PAD or not g.feed(t):
            break
        if g.done:
            break
    return g.ops, g.done


def describe(ops: list[tuple]) -> dict:
    """Small summary of a program, stored with each generated image."""
    counts: dict[str, int] = {}
    for op in ops:
        counts[op[0]] = counts.get(op[0], 0) + 1
    return {"ops": len(ops), "by_type": counts}


def resolve_text(items: list, prompt: str) -> str:
    out = []
    for it in items:
        if isinstance(it, str):
            out.append(it)
        else:
            i, j = it
            out.append(prompt[max(0, i): max(0, j) + 1])
    return "".join(out)
