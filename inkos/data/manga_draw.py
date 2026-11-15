"""Inking toolkit for the procedural manga generator.

An Ink canvas keeps two layers: line art (black / white) and a screentone
density map. finish() turns the density map into a halftone dot or line
pattern and merges it with the line art, giving a pure 1-bit image the way
printed manga is built: ink plus tone, never grey.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw

from .. import palette
from ..vector.render import catmull_rom


def halftone(density: np.ndarray, period: float = 8.0, kind: str = "dots") -> np.ndarray:
    """Density map in 0..1 -> boolean pattern (True = ink) on a 45 degree screen."""
    h, w = density.shape
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = (x + y) * 0.70711, (x - y) * 0.70711
    if kind == "lines":
        return (u % period) < period * density
    du, dv = (u % period) - period / 2, (v % period) - period / 2
    return du * du + dv * dv < (period * 0.72) ** 2 * density


class Ink:
    is_color = False

    def __init__(self, w: int, h: int, ss: int = 2):
        self.w, self.h, self.ss = w, h, ss
        self.img = Image.new("L", (w * ss, h * ss), 255)
        self.d = ImageDraw.Draw(self.img)
        self.tone = Image.new("L", (w * ss, h * ss), 0)
        self.t = ImageDraw.Draw(self.tone)

    def _p(self, pts):
        s = self.ss
        return [(float(x) * s, float(y) * s) for x, y in pts]

    # -- fills ------------------------------------------------------------------
    def fill(self, pts, color: int | None = 255, tone: float = 0.0):
        """Opaque polygon: covers line art and screentone beneath it."""
        if len(pts) < 3:
            return
        p = self._p(pts)
        if color is not None:
            self.d.polygon(p, fill=color)
        self.t.polygon(p, fill=int(max(0.0, min(1.0, tone)) * 255))

    def tone_only(self, pts, tone: float):
        if len(pts) >= 3:
            self.t.polygon(self._p(pts), fill=int(tone * 255))

    def tone_gradient(self, x0, y0, x1, y1, t0: float, t1: float, vertical: bool = True):
        s = self.ss
        x0, y0, x1, y1 = [int(round(v * s)) for v in (x0, y0, x1, y1)]
        x0, x1 = max(0, min(x0, x1)), min(self.w * s, max(x0, x1))
        y0, y1 = max(0, min(y0, y1)), min(self.h * s, max(y0, y1))
        if x1 <= x0 or y1 <= y0:
            return
        n = (y1 - y0) if vertical else (x1 - x0)
        ramp = np.linspace(t0, t1, n) * 255
        g = np.tile(ramp[:, None], (1, x1 - x0)) if vertical else np.tile(ramp[None, :], (y1 - y0, 1))
        self.tone.paste(Image.fromarray(g.astype(np.uint8)), (x0, y0))

    # -- strokes ----------------------------------------------------------------
    def line(self, pts, width: float = 2.0, color: int = 0, closed: bool = False):
        """Uniform-width polyline with round joins and caps."""
        if len(pts) < 2:
            return
        p = self._p(pts)
        if closed:
            p = p + p[:2]
        w = max(1, int(round(width * self.ss)))
        self.d.line(p, fill=color, width=w, joint="curve")
        if not closed and w >= 3:
            r = w / 2
            for x, y in (p[0], p[-1]):
                self.d.ellipse((x - r, y - r, x + r, y + r), fill=color)

    def stroke(self, pts, width: float = 2.5, color: int = 0, taper: float = 0.2):
        """Pen stroke that swells in the middle and thins to `taper` at both ends."""
        p = np.asarray(pts, dtype=float)
        if len(p) < 2:
            return
        seg = np.hypot(*np.diff(p, axis=0).T)
        s = np.concatenate([[0.0], np.cumsum(seg)])
        if s[-1] < 1e-6:
            return
        n = max(8, int(s[-1] / 3))
        t = np.linspace(0, s[-1], n)
        q = np.stack([np.interp(t, s, p[:, 0]), np.interp(t, s, p[:, 1])], axis=1)
        d = np.gradient(q, axis=0)
        nrm = np.stack([-d[:, 1], d[:, 0]], axis=1)
        nrm /= np.maximum(np.hypot(*nrm.T), 1e-9)[:, None]
        prof = taper + (1 - taper) * np.sin(np.linspace(0, math.pi, n)) ** 0.6
        half = (width / 2) * prof[:, None]
        poly = np.vstack([q + nrm * half, (q - nrm * half)[::-1]])
        self.d.polygon(self._p(poly), fill=color)

    def curve(self, pts, width: float = 2.5, color: int = 0, taper: float | None = 0.2, closed: bool = False):
        c = catmull_rom(pts, closed=closed)
        if taper is None or closed:
            self.line(c, width, color, closed=closed)
        else:
            self.stroke(c, width, color, taper)

    # -- closed shapes ------------------------------------------------------------
    def shape(self, pts, color: int | None = 255, tone: float = 0.0, outline: float = 2.0, smooth: bool = False):
        if smooth:
            pts = catmull_rom(pts, closed=True)[:-1]
        self.fill(pts, color, tone)
        if outline > 0:
            self.line(list(pts), outline, 0, closed=True)

    def ellipse(self, cx, cy, rx, ry, color: int | None = 255, tone: float = 0.0, outline: float = 2.0,
                rot: float = 0.0, n: int = 40):
        a = np.linspace(0, 2 * math.pi, n, endpoint=False)
        x, y = rx * np.cos(a), ry * np.sin(a)
        c, s = math.cos(rot), math.sin(rot)
        self.shape(np.stack([cx + x * c - y * s, cy + x * s + y * c], axis=1), color, tone, outline)

    # -- result -----------------------------------------------------------------
    def finish(self, period: float = 8.0, kind: str = "dots") -> np.ndarray:
        """-> bool array (h, w), True = ink."""
        size = (self.w, self.h)
        line = np.asarray(self.img.resize(size, Image.BOX)) < 128
        dens = np.asarray(self.tone.resize(size, Image.BOX), dtype=np.float32) / 255.0
        if dens.max() <= 0.01:
            return line
        return line | halftone(dens, period, kind)


class ColorInk(Ink):
    """The same drawing calls on a six-colour canvas (INKOS 1.1 Pro data).

    Pixels hold palette indices, so colours are flat and never blend. Colour
    arguments are palette indices; the black-and-white convention (0 = black,
    255 = white) is accepted too. Screentone does not exist here: colour
    takes its place, so the tone calls do nothing.
    """
    is_color = True

    def __init__(self, w: int, h: int, ss: int = 2):
        self.w, self.h, self.ss = w, h, ss
        self.img = Image.new("L", (w * ss, h * ss), palette.WHITE)
        self.d = ImageDraw.Draw(self.img)
        self.tone = self.t = None

    @staticmethod
    def _c(color: int) -> int:
        return palette.WHITE if color == 255 else int(color)

    def fill(self, pts, color: int | None = 255, tone: float = 0.0):
        if color is not None and len(pts) >= 3:
            self.d.polygon(self._p(pts), fill=self._c(color))

    def tone_only(self, pts, tone: float):
        pass

    def tone_gradient(self, *args, **kwargs):
        pass

    def line(self, pts, width: float = 2.0, color: int = 0, closed: bool = False):
        super().line(pts, width, self._c(color), closed)

    def stroke(self, pts, width: float = 2.5, color: int = 0, taper: float = 0.2):
        super().stroke(pts, width, self._c(color), taper)

    def finish(self, period: float = 8.0, kind: str = "dots") -> np.ndarray:
        """-> uint8 array (h, w) of palette indices."""
        return palette.reduce(np.asarray(self.img), self.ss)


def frame(a: np.ndarray, width: int = 3) -> np.ndarray:
    """Black border around a panel (bool ink map or palette indices)."""
    a = a.copy()
    v = True if a.dtype == bool else palette.BLACK
    a[:width, :] = a[-width:, :] = v
    a[:, :width] = a[:, -width:] = v
    return a


def downsample2(bits: np.ndarray) -> np.ndarray:
    """2x reduction that keeps thin lines: a pixel is ink if at least 2 of its 4 sources are."""
    h, w = bits.shape[-2] // 2 * 2, bits.shape[-1] // 2 * 2
    b = bits[..., :h, :w].astype(np.uint8)
    return (b[..., 0::2, 0::2] + b[..., 1::2, 0::2] + b[..., 0::2, 1::2] + b[..., 1::2, 1::2]) >= 2
