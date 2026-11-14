"""Prompt normalisation shared by training data, inference and evaluation.

Both models read prompts one character at a time over printable ASCII, so
there is no pretrained tokenizer or vocabulary file to install.
"""
from __future__ import annotations

import re
import unicodedata

FIRST_CHAR = 32   # space
LAST_CHAR = 126   # ~
N_CHARS = LAST_CHAR - FIRST_CHAR + 1


def normalize_prompt(text: str, max_len: int) -> str:
    """Fold a user prompt into the character set the models were trained on."""
    text = unicodedata.normalize("NFKD", text or "")
    text = text.replace("‘", "'").replace("’", "'")
    text = text.replace("“", '"').replace("”", '"')
    text = text.replace("–", "-").replace("—", "-").replace("→", "->")
    # A multi-line note becomes a ';' separated list, the form used in training.
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", text) if ln.strip()]
    out = ""
    for ln in lines:
        if not out:
            out = ln
        elif out[-1] in ";:,":
            out += " " + ln
        else:
            out += "; " + ln
    out = "".join(c if FIRST_CHAR <= ord(c) <= LAST_CHAR else "" if unicodedata.combining(c) else "?"
                  for c in out)
    out = re.sub(r"\s+", " ", out).strip()
    return out[:max_len].rstrip() or " "


def char_ids(text: str) -> list[int]:
    """0-based ids over printable ASCII (space = 0)."""
    return [min(N_CHARS - 1, max(0, ord(c) - FIRST_CHAR)) for c in text]
