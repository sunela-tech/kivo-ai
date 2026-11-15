"""The six-colour E-Ink palette used by INKOS 1.1 and INKOS 1.1 Pro.

These are the six pigments of current colour E-Ink panels (Spectra 6):
black, white, red, yellow, blue and green. Colour images are stored as
palette indices and written as indexed PNGs whose palette holds exactly
these six entries, so a file can never contain a blend, a tint or an
anti-aliased edge.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

NAMES = ("black", "white", "red", "yellow", "blue", "green")
RGB = ((0, 0, 0), (255, 255, 255), (255, 0, 0), (255, 255, 0), (0, 0, 255), (0, 255, 0))
BLACK, WHITE, RED, YELLOW, BLUE, GREEN = range(6)
N = len(NAMES)
INDEX = {n: i for i, n in enumerate(NAMES)}
HEX = tuple("#%02X%02X%02X" % c for c in RGB)
INKS = (BLACK, RED, YELLOW, BLUE, GREEN)        # everything that is not paper
DARK = (BLACK, RED, BLUE, GREEN)                # white lettering reads better on these
ID = "eink6"

_FLAT = [v for c in RGB for v in c]
_RGB = np.array(RGB, dtype=np.int32)


def idx_to_image(idx: np.ndarray) -> Image.Image:
    """Palette indices (H, W) -> PIL mode 'P' image with the six-colour palette."""
    img = Image.fromarray(np.asarray(idx, dtype=np.uint8), mode="P")
    img.putpalette(_FLAT)
    return img


def image_to_idx(img: Image.Image) -> np.ndarray:
    """Any image -> palette indices, each pixel snapped to the nearest of the six colours."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.int32)
    d = ((rgb[:, :, None, :] - _RGB[None, None]) ** 2).sum(-1)
    return d.argmin(-1).astype(np.uint8)


def is_pure(img: Image.Image) -> bool:
    """True if every pixel is exactly one of the six palette colours."""
    rgb = np.asarray(img.convert("RGB")).reshape(-1, 3)
    codes = np.unique(rgb[:, 0].astype(np.int32) << 16 | rgb[:, 1].astype(np.int32) << 8 | rgb[:, 2])
    allowed = {r << 16 | g << 8 | b for r, g, b in RGB}
    return all(int(c) in allowed for c in codes)


def reduce(idx: np.ndarray, factor: int) -> np.ndarray:
    """Shrink an index image by an integer factor without blending.

    A block becomes paper only if more than half of it is paper; otherwise it
    takes its most common ink (black first on ties). For two colours this is
    the same rule the black-and-white models use.
    """
    h, w = idx.shape[0] // factor, idx.shape[1] // factor
    blocks = idx[: h * factor, : w * factor].reshape(h, factor, w, factor)
    counts = np.stack([(blocks == k).sum(axis=(1, 3)) for k in range(N)], axis=-1).astype(np.float32)
    white = counts[..., WHITE] > factor * factor / 2
    counts[..., WHITE] = -1
    counts[..., BLACK] += 0.25
    out = counts.argmax(-1).astype(np.uint8)
    out[white] = WHITE
    return out


def usage(idx: np.ndarray) -> dict:
    """Share of the picture covered by each colour."""
    c = np.bincount(np.asarray(idx).ravel(), minlength=N)[:N] / max(1, np.asarray(idx).size)
    return {n: round(float(v), 4) for n, v in zip(NAMES, c)}
