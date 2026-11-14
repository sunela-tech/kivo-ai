"""The drawing language, the rasteriser and the 1-bit guarantees."""
import io

import numpy as np
import pytest
from PIL import Image

from inkos import bitmap
from inkos.prompts import normalize_prompt
from inkos.vector import lang
from inkos.vector.font import _G, wrap_text
from inkos.vector.render import render

PROMPT = "note: Buy milk; Call Anna"
OPS = [("HAND",), ("W", 3), ("RECT", 4, 4, 120, 120), ("TEXT", 10, 10, 8, 100, [(6, 13)]),
       ("TEXT", 10, 30, 6, 100, ["- ", (16, 24)]), ("CLEAN",), ("DASH",), ("LINE", [(10, 60), (60, 70), (110, 60)]),
       ("SOLID",), ("CURVE", [(10, 80), (40, 95), (80, 75), (118, 90)]), ("POLY", [(20, 100), (40, 100), (30, 118)]),
       ("FILL", [(60, 100), (80, 100), (70, 118)]), ("BLOB", [(90, 100), (110, 100), (100, 118)]),
       ("FBLOB", [(90, 40), (110, 40), (100, 55)]), ("CIRC", 64, 64, 10), ("DISC", 64, 64, 3), ("ERASE",),
       ("BOX", 62, 62, 66, 66), ("INK",), ("ELLI", 30, 50, 12, 6)]


def test_roundtrip():
    toks = lang.encode(OPS)
    assert max(toks) < lang.VOCAB + len(PROMPT)
    ops, ok = lang.decode(toks + [lang.EOS], len(PROMPT))
    assert ok and lang.encode(ops) == toks


def test_decode_stops_at_illegal_token_and_keeps_finished_ops():
    toks = lang.encode([("CIRC", 10, 10, 5), ("LINE", [(1, 1), (9, 9)])])
    ops, ok = lang.decode(toks[:-2] + [lang.TOK["CIRC"]], 0)       # a command inside an open path
    assert not ok and ops == [("CIRC", 10, 10, 5)]
    assert lang.decode(toks, 0)[1] is False                         # no <eos>


def test_grammar_masks():
    g = lang.Grammar(prompt_len=5)
    top = g.allowed()
    assert top[lang.EOS] and top[lang.TOK["LINE"]] and not top[lang.END] and not top[lang.COORD0]
    assert not top[lang.VOCAB:].any()                               # pointers only inside TEXT
    for t in [lang.TOK["TEXT"]] + [lang.COORD0 + 5] * 4:
        assert g.feed(t)
    items = g.allowed()
    assert items[lang.VOCAB:].all() and items[lang.END] and items[lang.CHAR0]
    assert g.feed(lang.VOCAB + 3)
    end = g.allowed()
    assert not end[lang.VOCAB: lang.VOCAB + 3].any() and end[lang.VOCAB + 3:].all()   # span end >= start
    assert not g.feed(lang.VOCAB + 1) and g.feed(lang.VOCAB + 4)
    assert g.feed(lang.END) and g.feed(lang.EOS) and g.done
    assert g.ops == [("TEXT", 5, 5, 5, 5, [(3, 4)])]


def test_grammar_requires_minimum_points():
    g = lang.Grammar()
    g.feed(lang.TOK["POLY"])
    for _ in range(4):                                              # two points
        assert not g.allowed()[lang.END]
        g.feed(lang.COORD0 + 7)
    assert not g.allowed()[lang.END]
    g.feed(lang.COORD0 + 1)
    assert not g.allowed()[lang.END]                                # x without y
    g.feed(lang.COORD0 + 1)
    assert g.allowed()[lang.END]


@pytest.mark.parametrize("size", [256, 512, 1024])
def test_render_is_pure_black_and_white(size):
    img = render(OPS, PROMPT, size, seed=3)
    assert img.mode == "1" and img.size == (size, size)
    assert bitmap.is_pure_bw(img)
    png = bitmap.png_bytes(img)
    back = Image.open(io.BytesIO(png))
    assert back.mode == "1" and set(np.unique(np.asarray(back.convert("L")))) <= {0, 255}
    assert 0.01 < bitmap.ink_ratio(img) < 0.5


def test_render_is_deterministic_per_seed():
    a, b, c = (np.asarray(render(OPS, PROMPT, 256, seed=s)) for s in (1, 1, 2))
    assert (a == b).all() and (a != c).any()                        # HAND wobble depends on the seed only


def test_text_span_is_copied_from_the_prompt():
    assert lang.resolve_text([(6, 13)], PROMPT) == "Buy milk"
    assert lang.resolve_text(["- ", (16, 24)], PROMPT) == "- Call Anna"


def test_font_covers_printable_ascii():
    assert all(chr(c) in _G for c in range(32, 127))
    assert all(len(s) % 2 == 0 for spec in _G.values() for s in spec.split())


def test_wrap_text():
    assert wrap_text("one two three", 7) == ["one two", "three"]
    assert wrap_text("abcdefghij", 4) == ["abcd", "efgh", "ij"]
    assert wrap_text("", 5) == [""]


def test_normalize_prompt():
    assert normalize_prompt("Groceries\n milk \n\neggs", 100) == "Groceries; milk; eggs"
    assert normalize_prompt("note Café:\nmilk", 100) == "note Cafe: milk"
    assert normalize_prompt("a → b", 100) == "a -> b"
    assert normalize_prompt("x" * 50, 10) == "x" * 10
    assert normalize_prompt("", 10) == " "


def test_bit_packing_and_binarize():
    rng = np.random.default_rng(0)
    ink = rng.random((3, 64, 64)) < 0.3
    assert (bitmap.unpack(bitmap.pack(ink), 64) == ink).all()
    grey = Image.fromarray((rng.random((90, 60)) * 255).astype(np.uint8))
    bits = bitmap.binarize(grey, 128)
    assert bits.shape == (128, 128) and bits.dtype == bool
    assert not bits[:, :10].any()                                    # padded with paper, not ink
    assert bitmap.is_pure_bw(bitmap.ink_to_image(bits))
