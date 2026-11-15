"""1-bit image helpers.

Conventions
  arrays / tensors : ink = 1, paper = 0
  PNG files        : ink = #000000, paper = #FFFFFF, written at bit depth 1
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image

SIZES = (256, 512, 1024)


def ink_to_image(ink: np.ndarray) -> Image.Image:
    """bool/0-1 array (H, W), ink = 1  ->  PIL mode '1' image."""
    ink = np.asarray(ink).astype(bool)
    return Image.fromarray(np.where(ink, 0, 255).astype(np.uint8), mode="L").convert("1", dither=Image.Dither.NONE)


def image_to_ink(img: Image.Image) -> np.ndarray:
    """Any PIL image -> bool array, True where there is ink.

    Black-and-white images: darker than mid grey. Colour images: anything
    that is not white (yellow counts as ink even though it is bright).
    """
    if img.mode in ("P", "RGB", "RGBA"):
        return (np.asarray(img.convert("RGB")) != 255).any(axis=-1)
    return np.asarray(img.convert("L")) < 128


def to_pure_bw(img: Image.Image) -> Image.Image:
    """Hard threshold to a mode '1' image. No dithering, no grey."""
    if img.mode == "1":
        return img
    return img.convert("L").point(lambda v: 255 if v >= 128 else 0).convert("1", dither=Image.Dither.NONE)


def png_bytes(img: Image.Image) -> bytes:
    """PNG encoding: bit depth 1 for black-and-white, a six-entry palette for colour."""
    buf = io.BytesIO()
    (img if img.mode == "P" else to_pure_bw(img)).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def save_png(img: Image.Image, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(img))
    return path


def is_pure_bw(img_or_path) -> bool:
    """True if every pixel is exactly #000000 or #FFFFFF."""
    img = Image.open(img_or_path) if isinstance(img_or_path, (str, Path)) else img_or_path
    vals = np.unique(np.asarray(img.convert("RGB")))
    return bool(np.isin(vals, (0, 255)).all())


def is_pure(img_or_path) -> bool:
    """The output guarantee of every model: two values, or the six palette colours."""
    from . import palette
    img = Image.open(img_or_path) if isinstance(img_or_path, (str, Path)) else img_or_path
    return palette.is_pure(img) if img.mode == "P" else is_pure_bw(img)


def pack4(idx: np.ndarray) -> np.ndarray:
    """Palette indices (..., H, W) with even W -> two pixels per byte."""
    a = np.asarray(idx, dtype=np.uint8)
    return (a[..., 0::2] << 4) | a[..., 1::2]


def unpack4(packed: np.ndarray) -> np.ndarray:
    out = np.empty(packed.shape[:-1] + (packed.shape[-1] * 2,), dtype=np.uint8)
    out[..., 0::2] = packed >> 4
    out[..., 1::2] = packed & 15
    return out


def ink_ratio(img: Image.Image) -> float:
    return float(image_to_ink(img).mean())


def pack(ink: np.ndarray) -> np.ndarray:
    """(…, H, W) bool -> (…, H, W/8) uint8."""
    return np.packbits(np.asarray(ink).astype(bool), axis=-1)


def unpack(packed: np.ndarray, width: int) -> np.ndarray:
    return np.unpackbits(packed, axis=-1, count=width).astype(bool)


def binarize(img: Image.Image, size: int, method: str = "otsu", pad: bool = True) -> np.ndarray:
    """Fit any image onto a white size x size square and reduce it to ink/paper.

    method: 'otsu' picks the threshold per image, 'fixed' uses mid grey.
    """
    img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    img = Image.alpha_composite(bg, img).convert("L")
    w, h = img.size
    if pad:
        s = size / max(w, h)
        nw, nh = max(1, round(w * s)), max(1, round(h * s))
        canvas = Image.new("L", (size, size), 255)
        canvas.paste(img.resize((nw, nh), Image.LANCZOS), ((size - nw) // 2, (size - nh) // 2))
        img = canvas
    else:
        s = size / min(w, h)
        img = img.resize((max(size, round(w * s)), max(size, round(h * s))), Image.LANCZOS)
        l, t = (img.width - size) // 2, (img.height - size) // 2
        img = img.crop((l, t, l + size, t + size))
    a = np.asarray(img)
    thr = _otsu(a) if method == "otsu" else 128
    return a < thr


def _otsu(a: np.ndarray) -> int:
    hist = np.bincount(a.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    cum = np.cumsum(hist)
    cum_mean = np.cumsum(hist * np.arange(256))
    best, best_t = -1.0, 128
    for t in range(1, 255):
        w0, w1 = cum[t], total - cum[t]
        if w0 == 0 or w1 == 0:
            continue
        m0, m1 = cum_mean[t] / w0, (cum_mean[-1] - cum_mean[t]) / w1
        v = w0 * w1 * (m0 - m1) ** 2
        if v > best:
            best, best_t = v, t
    return int(best_t) + 1


def contact_sheet(images: list[Image.Image], cols: int, cell: int, gap: int = 6) -> Image.Image:
    """Grid of thumbnails separated by white gutters. Stays pure: black/white,
    or palette colours if any of the images is a colour image."""
    from . import palette
    color = any(im.mode == "P" for im in images)
    rows = (len(images) + cols - 1) // cols
    size = (cols * cell + (cols + 1) * gap, rows * cell + (rows + 1) * gap)
    sheet = Image.new("RGB" if color else "L", size, (255, 255, 255) if color else 255)
    black = (0, 0, 0) if color else 0
    for i, im in enumerate(images):
        if color:
            im = im.convert("RGB")
            if im.size != (cell, cell):
                im = im.resize((cell, cell), Image.NEAREST)        # never blend palette colours
        else:
            im = im.convert("L")
            if im.size != (cell, cell):
                im = im.resize((cell, cell), Image.LANCZOS)
        x = gap + (i % cols) * (cell + gap)
        y = gap + (i // cols) * (cell + gap)
        sheet.paste(im, (x, y))
        # 1px frame so empty cells stay visible
        sheet.paste(black, (x - 1, y - 1, x + cell + 1, y))
        sheet.paste(black, (x - 1, y + cell, x + cell + 1, y + cell + 1))
        sheet.paste(black, (x - 1, y - 1, x, y + cell + 1))
        sheet.paste(black, (x + cell, y - 1, x + cell + 1, y + cell + 1))
    return palette.idx_to_image(palette.image_to_idx(sheet)) if color else to_pure_bw(sheet)
