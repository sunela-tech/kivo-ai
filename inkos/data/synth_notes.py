"""Synthetic written pages for INKOS 1: notes, to-do lists, journals, logs,
schedules, tables and signs.

Each generator returns a Doc (prompt + program) or None when a random draw
does not fit the page. The prompt conventions here are the ones the trained
model understands:

  note Groceries: milk; eggs; bread          heading before ':' is optional
  todo: [x] Pay rent; Call Anna; Buy stamps
  journal 2026-11-14: Woke up early ...
  log: 09:00 boot ok; 09:05 sync started
  table: Item, Qty; Apples, 3; Pears, 5
  sign: Back in 5 minutes
"""
from __future__ import annotations

import numpy as np

from ..vector.font import chars_per_line, wrap_text
from . import words
from .doc import ADV, GAP, LINE_H, Doc, fit_size, line_count
from .words import pick

X0, X1, Y0, Y1 = 7, 121, 7, 121


def _heading(d: Doc, rng, x0, y, width, heading, sizes=(10, 8, 7, 6)) -> float:
    """Draw a heading with an underline; returns the y where content starts."""
    ts = fit_size(d.length(heading), width, sizes)
    d.text(x0, y, ts, heading)
    uy = y + ts * 1.3 + 1
    uw = min(width, (d.length(heading) * ADV) * ts + 3)
    if d.hand and rng.random() < 0.5:
        d.add("CURVE", [(x0, uy), (x0 + uw * 0.33, uy + 0.8), (x0 + uw * 0.66, uy - 0.8), (x0 + uw, uy)])
    else:
        d.line((x0, uy), (x0 + uw, uy))
    return uy + 4


def _fit_rows(texts: list[str], width: int, height: float, sizes=(7, 6, 5, 4), gap=0.35):
    """Pick the largest text size at which all wrapped rows fit the height."""
    for s in sizes:
        rows = [line_count(t, s, width) for t in texts]
        total = sum(r * LINE_H * s for r in rows) + gap * s * (len(texts) - 1)
        if total <= height and (s == sizes[0] or max(rows) <= 3):
            return s, rows
    return None, None


# --------------------------------------------------------------------------

NOTE_KINDS = ("note", "note", "note", "notes", "memo", "list", "bullet list", "numbered list",
              "shopping list", "sticky note", "reminder", "card")


def gen_note(rng: np.random.Generator) -> Doc | None:
    d = Doc("note")
    kw = pick(rng, NOTE_KINDS)
    d.say(d.style(rng, hand_p=0.6) + kw)
    heading = None
    if rng.random() < 0.6:
        d.say(" ")
        heading = d.span(words.title(rng))
    d.say(": ")
    items = []
    for k in range(int(rng.integers(1, 8))):
        if k:
            d.say("; ")
        items.append(d.span(words.task(rng)))

    x0, x1, y = X0, X1, Y0
    if kw == "sticky note":
        d.line((3, 3), (124, 3), (124, 106), (106, 124), (3, 124), (3, 3))
        d.line((124, 106), (106, 106), (106, 124))
        x0, x1, y = 10, 116, 10
    elif kw in ("card", "memo"):
        d.add("RECT", 3, 3, 124, 124)
        x0, x1, y = 10, 118, 10
    width = x1 - x0
    if heading:
        y = _heading(d, rng, x0, y, width, heading)
        if kw == "memo":
            d.line((x0, y - 2.5), (x1, y - 2.5))
            y += 1.5

    numbered = kw == "numbered list"
    bullets = kw in ("bullet list", "list", "shopping list")
    texts = [d.text_of(i) for i in items]
    for sizes in ((7, 6, 5, 4), (6, 5, 4), (5, 4), (4,)):
        s = sizes[0]
        indent = int(round(ADV * s * 3)) if numbered else (int(round(s * 0.9 + 1)) if bullets else 0)
        avail = int(width - indent)
        s2, rows = _fit_rows(texts, avail, Y1 - y, sizes[:1])
        if s2:
            break
    else:
        return None
    for k, it in enumerate(items):
        by = y + s * 0.55
        if numbered:
            d.text(x0, y, s, f"{k + 1}.")
        elif kw == "bullet list":
            d.add("DISC", x0 + s * 0.3, by, max(0.8, s * 0.17))
        elif bullets:
            d.add("CIRC", x0 + s * 0.3, by, max(1.0, s * 0.22))
        d.text(x0 + indent, y, s, it, wrap=avail)
        y += rows[k] * LINE_H * s + 0.35 * s
    return d


def gen_todo(rng) -> Doc | None:
    d = Doc("todo")
    kw = pick(rng, ("todo", "todo", "to-do list", "checklist", "tasks", "task list"))
    d.say(d.style(rng, hand_p=0.6) + kw)
    heading = None
    if rng.random() < 0.4:
        d.say(" ")
        heading = d.span(words.title(rng))
    d.say(": ")
    items, done = [], []
    for k in range(int(rng.integers(1, 8))):
        if k:
            d.say("; ")
        r = rng.random()
        if r < 0.35:
            d.say("[x] ")
        elif r < 0.5:
            d.say("[ ] ")
        done.append(r < 0.35)
        items.append(d.span(words.task(rng)))
    x0, y = X0, Y0
    width = X1 - x0
    if heading:
        y = _heading(d, rng, x0, y, width, heading)
    texts = [d.text_of(i) for i in items]
    for s in (7, 6, 5, 4):
        indent = int(round(s * 1.35 + 1))
        avail = int(width - indent)
        s2, rows = _fit_rows(texts, avail, Y1 - y, (s,))
        if s2:
            break
    else:
        return None
    b = s * 0.85
    for k, it in enumerate(items):
        ty = y + s * 0.12
        d.add("RECT", x0, ty, x0 + b, ty + b)
        if done[k]:
            d.line((x0 + 0.15 * b, ty + 0.5 * b), (x0 + 0.42 * b, ty + 0.85 * b), (x0 + 1.15 * b, ty - 0.15 * b))
        d.text(x0 + indent, y, s, it, wrap=avail)
        y += rows[k] * LINE_H * s + 0.35 * s
    return d


def gen_journal(rng) -> Doc | None:
    d = Doc("journal")
    lined = rng.random() < 0.25
    kw = ("lined " if lined else "") + pick(rng, ("journal", "journal", "diary", "journal entry", "diary entry",
                                                   "daily log", "page"))
    d.say(d.style(rng, hand_p=0.7) + kw)
    heading = None
    r = rng.random()
    if r < 0.6:
        d.say(" ")
        heading = d.span(words.date(rng))
    elif r < 0.75:
        d.say(" ")
        heading = d.span(words.title(rng))
    d.say(": ")
    body = d.span(words.paragraph(rng, int(rng.integers(40, 200))))
    x0, y = X0, Y0
    width = X1 - x0
    if heading:
        y = _heading(d, rng, x0, y, width, heading, (8, 7, 6))
    text = d.text_of(body)
    for s in (7, 6, 5, 4):
        n = line_count(text, s, width)
        if n * LINE_H * s <= Y1 - y:
            break
    else:
        return None
    d.text(x0, y, s, body, wrap=width)
    if lined:
        d.w(1)
        for i in range(n):
            ry = y + i * LINE_H * s + s * 1.28
            d.line((x0, ry), (X1, ry))
    return d


KEYED = {
    "log": (("log", "log", "event log", "activity log", "system log"), "rules"),
    "schedule": (("schedule", "agenda", "timetable", "day plan"), "rail"),
    "week": (("week plan", "weekly planner", "week"), "grid"),
}


def gen_keyed(rng) -> Doc | None:
    """Two-column lists: a short key (time, day) followed by a message."""
    group = pick(rng, ("log", "log", "schedule", "week"))
    kws, deco = KEYED[group]
    d = Doc(group)
    d.say(d.style(rng, hand_p=0.45) + pick(rng, kws))
    heading = None
    if rng.random() < 0.35:
        d.say(" ")
        heading = d.span(words.title(rng) if rng.random() < 0.6 else words.date(rng))
    d.say(": ")
    n = int(rng.integers(2, 9))
    if group == "week":
        start = int(rng.integers(0, 7))
        n = min(n, 7)
    rows = []
    t = int(rng.integers(5 * 60, 12 * 60))
    for k in range(n):
        if k:
            d.say("; ")
        if group == "week":
            key = words.DAYS[(start + k) % 7]
            val = pick(rng, words.ACTIVITIES) if rng.random() < 0.6 else words.task(rng)
        else:
            t += int(pick(rng, (5, 10, 15, 30, 45, 60, 90)))
            key = f"{(t // 60) % 24:02d}:{t % 60:02d}"
            if group == "log":
                val = pick(rng, words.EVENTS) if rng.random() < 0.8 else words.gibberish(rng, 3, 10)
            else:
                val = pick(rng, words.ACTIVITIES)
                if rng.random() < 0.3:
                    val += " with " + pick(rng, words.NAMES)
        ks = d.span(key)
        d.say(" ")
        rows.append((ks, d.span(val)))
    x0, y = X0, Y0
    width = X1 - x0
    if heading:
        y = _heading(d, rng, x0, y, width, heading, (8, 7, 6))
    klen = max(d.length(k) for k, _ in rows)
    vlen = max(d.length(v) for _, v in rows)
    row_h = min(15.0, (Y1 - y) / n)
    for s in (7, 6, 5, 4):
        keycol = (klen * ADV + 0.9) * s
        if s * 1.45 <= row_h and (vlen * ADV - GAP) * s <= width - keycol - 1:
            break
    else:
        return None
    pad = (row_h - s) / 2
    top = y
    for k, (ks, vs) in enumerate(rows):
        ry = top + k * row_h
        d.text(x0 + (1 if deco == "grid" else 0), ry + pad, s, ks)
        d.text(x0 + keycol + (2 if deco == "rail" else 0), ry + pad, s, vs)
    bottom = top + n * row_h
    if deco == "rules":
        d.w(1)
        for k in range(1, n):
            d.line((x0, top + k * row_h), (X1, top + k * row_h))
    elif deco == "rail":
        rx = x0 + keycol - 0.5 * s + 1
        d.line((rx, top + row_h / 2), (rx, bottom - row_h / 2))
        for k in range(n):
            d.add("DISC", rx, top + (k + 0.5) * row_h, 1.4)
    else:
        d.add("RECT", x0 - 1, top, X1, bottom)
        d.line((x0 + keycol - 0.2 * s, top), (x0 + keycol - 0.2 * s, bottom))
        d.w(1)
        for k in range(1, n):
            d.line((x0 - 1, top + k * row_h), (X1, top + k * row_h))
    return d


def gen_table(rng) -> Doc | None:
    d = Doc("table")
    d.say(d.style(rng, hand_p=0.3) + pick(rng, ("table", "table", "data table", "grid table")))
    heading = None
    if rng.random() < 0.3:
        d.say(" ")
        heading = d.span(words.title(rng))
    d.say(": ")
    ncols, nrows = int(rng.integers(2, 5)), int(rng.integers(2, 7))
    numeric = [rng.random() < 0.5 for _ in range(ncols)]
    numeric[0] = False
    cells = []
    for r in range(nrows):
        if r:
            d.say("; ")
        row = []
        for c in range(ncols):
            if c:
                d.say(", ")
            if r == 0:
                txt = words.label(rng, 8)
            elif numeric[c]:
                txt = str(int(rng.integers(0, 1000))) if rng.random() < 0.7 else f"{rng.uniform(0, 100):.1f}"
            else:
                txt = words.label(rng, 8) if rng.random() < 0.5 else pick(rng, words.ITEMS)[:9]
            row.append(d.span(txt))
        cells.append(row)
    x0, y = X0, Y0
    if heading:
        y = _heading(d, rng, x0, y, X1 - x0, heading, (8, 7, 6))
    col_w = (X1 - x0) / ncols
    row_h = min(16.0, (Y1 - y) / nrows)
    longest = max(d.length(c) for row in cells for c in row)
    for s in (7, 6, 5, 4, 3):
        if s * 1.45 <= row_h and (longest * ADV - GAP) * s <= col_w - 3:
            break
    else:
        return None
    bottom = y + nrows * row_h
    d.add("RECT", x0, y, X1, bottom)
    for c in range(1, ncols):
        d.line((x0 + c * col_w, y), (x0 + c * col_w, bottom))
    for r in range(2, nrows):
        d.line((x0, y + r * row_h), (X1, y + r * row_h))
    d.w(d.weight + 1)
    d.line((x0, y + row_h), (X1, y + row_h))
    d.w(d.weight)
    for r, row in enumerate(cells):
        for c, cell in enumerate(row):
            d.text(x0 + c * col_w + 1.5, y + r * row_h + (row_h - s) / 2, s, cell)
    return d


def gen_sign(rng) -> Doc | None:
    d = Doc("sign")
    kw = pick(rng, ("title", "sign", "label", "banner", "heading", "cover", "poster"))
    d.say(d.style(rng, hand_p=0.4) + kw + ": ")
    r = rng.random()
    if r < 0.4:
        txt = words.title(rng)
    elif r < 0.7:
        txt = " ".join(words.word(rng) for _ in range(int(rng.integers(1, 5))))
    else:
        txt = words.task(rng)
    if rng.random() < 0.3:
        txt = txt.upper()
    sp = d.span(txt)
    inner = 100
    for s in (22, 18, 15, 12, 10, 8, 6):
        cpl = chars_per_line(s, inner)
        lines = wrap_text(txt, cpl)
        if len(lines) * LINE_H * s <= 84 and all(len(ln) <= cpl for ln in lines) and max(len(w) for w in txt.split(" ")) <= cpl:
            break
    else:
        return None
    total = (len(lines) - 1) * LINE_H * s + s
    y = 64 - total / 2
    pos = sp[0]
    widest = 0.0
    for ln in lines:
        start = d.prompt.index(ln, pos) if ln else pos
        end = start + len(ln) - 1
        pos = end + 1
        if ln:
            d.text_center(64, y + s / 2, s, (start, end))
        widest = max(widest, (len(ln) * ADV - GAP) * s)
        y += LINE_H * s
    bottom = 64 + total / 2
    if kw == "sign":
        d.w(3)
        d.add("RECT", 4, 64 - total / 2 - 12, 123, bottom + 12)
        d.w(1)
        d.add("RECT", 7, 64 - total / 2 - 9, 120, bottom + 9)
    elif kw in ("label", "poster"):
        d.add("RECT", 5, 64 - total / 2 - 10, 122, bottom + 10)
    elif kw in ("banner", "cover"):
        for off in (10, 7):
            d.line((6, 64 - total / 2 - off), (121, 64 - total / 2 - off))
            d.line((6, bottom + off), (121, bottom + off))
    else:
        d.line((64 - widest / 2, bottom + 5), (64 + widest / 2, bottom + 5))
    return d


GENERATORS = {
    "note": (gen_note, 3.0),
    "todo": (gen_todo, 2.0),
    "journal": (gen_journal, 2.0),
    "keyed": (gen_keyed, 2.5),
    "table": (gen_table, 1.5),
    "sign": (gen_sign, 1.0),
}
