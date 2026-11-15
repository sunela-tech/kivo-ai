// Rasterise an InkScript program to a 1-bit or six-colour picture.
// A port of inkos/vector/render.py with its own scan-line rasteriser, so the
// result never contains anti-aliasing: every pixel is paper or one ink.
//
// Pixels are palette indices: 0 black, 1 white, 2 red, 3 yellow, 4 blue, 5 green.
// A black-and-white picture only ever uses 0 and 1.

import { GRID, resolveText } from './lang.js';
import { Rng } from './rand.js';

export const BLACK = 0, WHITE = 1;
export const PALETTE = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [255, 255, 0], [0, 0, 255], [0, 255, 0]];
export const COLOR_NAMES = ['black', 'white', 'red', 'yellow', 'blue', 'green'];
const DARK = new Set([0, 2, 4, 5]);
export const isDark = (c) => DARK.has(c);

const STROKE = { 1: 0.55, 2: 0.9, 3: 1.4, 4: 2.1 };
const MIN_STROKE_PX = 1.5;
const WOBBLE = 0.32;

const supersample = (size) => (size <= 256 ? 4 : size <= 512 ? 3 : 2);

// ---------------------------------------------------------------------------
// font

export function setFont(f) { FONT = f; }
let FONT = null;

export function charsPerLine(size, wrap) {
  return Math.max(1, Math.floor(wrap / (FONT.adv * Math.max(size, 1e-6)) + 1e-6));
}

export function wrapText(text, cpl) {
  const lines = [];
  let cur = '';
  for (let word of text.split(' ')) {
    while (word.length > cpl) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, cpl));
      word = word.slice(cpl);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= cpl) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}

function glyph(ch) {
  const g = FONT.glyphs[ch];
  return g && g.length ? g : FONT.glyphs['?'];
}

// ---------------------------------------------------------------------------
// geometry, in grid units; points are [x, y]

export function catmullRom(pts, closed = false) {
  const p = pts.map((q) => [+q[0], +q[1]]);
  if (p.length < 3) return p;
  let ext, segs;
  if (closed) { ext = [p[p.length - 1], ...p, p[0], p[1]]; segs = p.length; }
  else {
    const a = [2 * p[0][0] - p[1][0], 2 * p[0][1] - p[1][1]];
    const z = [2 * p[p.length - 1][0] - p[p.length - 2][0], 2 * p[p.length - 1][1] - p[p.length - 2][1]];
    ext = [a, ...p, z]; segs = p.length - 1;
  }
  const out = [];
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [ext[i], ext[i + 1], ext[i + 2], ext[i + 3]];
    const n = Math.trunc(Math.min(12, Math.max(2, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 1.2 + 2)));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const f = (j) => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t +
        (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t * t * t);
      out.push([f(0), f(1)]);
    }
  }
  out.push(closed ? [...p[0]] : [...p[p.length - 1]]);
  return out;
}

function cumlen(p) {
  const s = [0];
  for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  return s;
}

export function resample(p, step) {
  if (p.length < 2) return p.map((q) => [...q]);
  const s = cumlen(p), L = s[s.length - 1];
  if (L < 1e-9) return [[...p[0]]];
  const n = Math.max(2, Math.ceil(L / step) + 1), out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = (L * i) / (n - 1);
    while (j < s.length - 2 && s[j + 1] < t) j++;
    const seg = s[j + 1] - s[j], f = seg > 0 ? (t - s[j]) / seg : 0;
    out.push([p[j][0] + (p[j + 1][0] - p[j][0]) * f, p[j][1] + (p[j + 1][1] - p[j][1]) * f]);
  }
  return out;
}

function wobble(p, rng, amp = WOBBLE) {
  p = resample(p, 1.2);
  if (p.length < 2) return p;
  const s = cumlen(p);
  for (let ax = 0; ax < 2; ax++) {
    const f1 = rng.uniform(0.12, 0.3), f2 = rng.uniform(0.45, 0.85);
    const a = rng.uniform(0, 2 * Math.PI), b = rng.uniform(0, 2 * Math.PI);
    for (let i = 0; i < p.length; i++) p[i][ax] += amp * (Math.sin(f1 * s[i] + a) + 0.4 * Math.sin(f2 * s[i] + b));
  }
  return p;
}

function dashPath(p, on = 2.4, off = 1.8) {
  p = resample(p, 0.4);
  if (p.length < 2) return [];
  const s = cumlen(p), out = [], period = on + off;
  for (let k = 0; k * period < s[s.length - 1]; k++) {
    const sel = p.filter((_, i) => s[i] >= k * period && s[i] <= k * period + on);
    if (sel.length >= 2) out.push(sel);
  }
  return out;
}

function ellipsePoints(cx, cy, rx, ry, start = 0, turns = 1) {
  const n = Math.trunc(Math.min(96, Math.max(16, (2.2 * Math.PI * Math.max(rx, ry, 1)) / 1.0)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (2 * Math.PI * turns * i) / n;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

const close = (a, b) => Math.abs(a[0] - b[0]) <= 1e-8 + 1e-5 * Math.abs(b[0]) && Math.abs(a[1] - b[1]) <= 1e-8 + 1e-5 * Math.abs(b[1]);

// ---------------------------------------------------------------------------
// raster primitives on a Uint8Array of palette indices, in canvas pixels

class Raster {
  constructor(S, paper) { this.S = S; this.px = new Uint8Array(S * S).fill(paper); }

  /** Even-odd fill sampled at pixel centres. */
  polygon(pts, c) {
    const n = pts.length, S = this.S;
    if (n < 3) return;
    let y0 = Infinity, y1 = -Infinity;
    for (const [, y] of pts) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const ys = Math.max(0, Math.floor(y0 - 0.5)), ye = Math.min(S - 1, Math.ceil(y1 - 0.5));
    const xs = [];
    for (let y = ys; y <= ye; y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi <= cy && cy < yj) || (yj <= cy && cy < yi)) xs.push(xi + ((cy - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(S - 1, Math.floor(xs[k + 1] - 0.5));
        if (b >= a) this.px.fill(c, y * S + a, y * S + b + 1);
      }
    }
  }

  ellipse(cx, cy, rx, ry, c) {
    const S = this.S;
    rx = Math.max(rx, 0.5); ry = Math.max(ry, 0.5);
    const ys = Math.max(0, Math.floor(cy - ry)), ye = Math.min(S - 1, Math.ceil(cy + ry));
    for (let y = ys; y <= ye; y++) {
      const dy = (y + 0.5 - cy) / ry;
      if (dy * dy > 1) continue;
      const half = rx * Math.sqrt(1 - dy * dy);
      const a = Math.max(0, Math.ceil(cx - half - 0.5)), b = Math.min(S - 1, Math.floor(cx + half - 0.5));
      if (b >= a) this.px.fill(c, y * S + a, y * S + b + 1);
    }
  }

  /** Polyline of width w with round joints (PIL's joint="curve"); caps are flat. */
  line(pts, w, c) {
    const r = w / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-9) continue;
      const nx = (-(by - ay) / L) * r, ny = ((bx - ax) / L) * r;
      this.polygon([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], c);
      if (i > 0) this.ellipse(ax, ay, r, r, c);
    }
  }
}

// ---------------------------------------------------------------------------
// canvas with InkScript pen state

class Canvas {
  constructor(size, seed, color) {
    this.size = size; this.isColor = color;
    this.ss = supersample(size); this.S = size * this.ss; this.k = this.S / GRID;
    this.r = new Raster(this.S, WHITE);
    this.rng = new Rng(seed);
    this.weight = 2; this.pen = BLACK; this.color = BLACK; this.dash = false; this.hand = false;
  }

  setColor(k) {
    this.pen = this.isColor ? Math.min(5, Math.max(0, k)) : (k === WHITE ? WHITE : BLACK);
    this.color = this.pen;
  }

  px(p) { return p.map(([x, y]) => [(x + 0.5) * this.k, (y + 0.5) * this.k]); }

  widthPx(units) { return Math.max(1, Math.round(Math.max(MIN_STROKE_PX * this.ss, units * this.k))); }

  stroke(p, units = null, closed = false) {
    if (!p.length) return;
    const w = this.widthPx(units === null ? STROKE[this.weight] : units);
    let pts = this.px(p);
    const r = w / 2;
    if (pts.length === 1 || (pts.length === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1])) {
      this.r.ellipse(pts[0][0], pts[0][1], r, r, this.color);
      return;
    }
    if (closed) pts = pts.concat(pts.slice(1, 2));
    this.r.line(pts, w, this.color);
    if (!closed && w >= 3) {
      for (const [x, y] of [pts[0], pts[pts.length - 1]]) this.r.ellipse(x, y, r, r, this.color);
    }
  }

  path(p, closed = false, units = null) {
    p = p.map((q) => [+q[0], +q[1]]);
    if (closed && p.length && !close(p[0], p[p.length - 1])) p.push([...p[0]]);
    if (this.hand) p = wobble(p, this.rng);
    if (this.dash) for (const seg of dashPath(p)) this.stroke(seg, units);
    else this.stroke(p, units, closed && !this.hand);
  }

  fill(p) {
    p = p.map((q) => [+q[0], +q[1]]);
    if (this.hand) p = wobble(p.concat([[...p[0]]]), this.rng, WOBBLE * 0.7);
    if (p.length >= 3) this.r.polygon(this.px(p), this.color);
  }

  /** -> Uint8Array(size * size) of palette indices */
  finish() {
    const { size, ss, S } = this, src = this.r.px, out = new Uint8Array(size * size), n = ss * ss;
    const counts = new Float32Array(6);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        counts.fill(0);
        for (let dy = 0; dy < ss; dy++) {
          const row = (y * ss + dy) * S + x * ss;
          for (let dx = 0; dx < ss; dx++) counts[src[row + dx]]++;
        }
        let v;
        if (!this.isColor) {
          // PIL box average then threshold at 128: paper wins when it is (about) half or more
          v = Math.floor((255 * counts[WHITE]) / n + 0.5) >= 128 ? WHITE : BLACK;
        } else if (counts[WHITE] > n / 2) v = WHITE;
        else {
          counts[WHITE] = -1; counts[BLACK] += 0.25;
          v = 0;
          for (let c = 1; c < 6; c++) if (counts[c] > counts[v]) v = c;
        }
        out[y * size + x] = v;
      }
    }
    return out;
  }
}

function drawText(c, x, y, size, wrap, text) {
  size = Math.max(1, size);
  const cpl = charsPerLine(size, wrap > 0 ? wrap : GRID);
  const units = Math.min(2.0, Math.max(0.42, 0.085 * size));
  const slant = c.hand ? c.rng.uniform(0.08, 0.2) : 0;
  const drift = c.hand ? c.rng.uniform(-0.012, 0.012) : 0;
  const lines = wrapText(text, cpl);
  for (let row = 0; row < lines.length; row++) {
    const top = y + row * FONT.line_h * size;
    if (top > GRID + size) break;
    const base = top + size, line = lines[row];
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === ' ') continue;
      const ox = x + k * FONT.adv * size, oy = base + drift * k * size;
      let sc = 1, rot = 0, dx = 0, dy = 0;
      if (c.hand) {
        sc = c.rng.uniform(0.93, 1.07); rot = c.rng.uniform(-0.05, 0.05);
        dx = c.rng.uniform(-0.03, 0.03) * size; dy = c.rng.uniform(-0.045, 0.045) * size;
      }
      const cr = Math.cos(rot), sr = Math.sin(rot);
      for (const st of glyph(ch)) {
        const pts = [];
        for (let i = 0; i < st.length; i += 2) {
          let gx = st[i] * sc + slant * st[i + 1], gy = st[i + 1] * sc;
          if (c.hand && st.length > 2) { gx += c.rng.normal(0, 0.012); gy += c.rng.normal(0, 0.012); }
          const rx = gx * cr - gy * sr, ry = gx * sr + gy * cr;
          pts.push([ox + dx + rx * size, oy + dy - ry * size]);
        }
        c.stroke(pts, units);
      }
    }
  }
}

/** Program -> {size, pixels: Uint8Array of palette indices, color} */
export function render(ops, prompt = '', size = 256, seed = 0, color = false) {
  if (!FONT) throw new Error('call setFont() first');
  const c = new Canvas(size, seed, color);
  for (const op of ops) {
    const name = op[0];
    switch (name) {
      case 'W': c.weight = Math.min(4, Math.max(1, op[1])); break;
      case 'COLOR': c.setColor(op[1]); break;
      case 'INK': c.color = c.pen; break;
      case 'ERASE': c.color = WHITE; break;
      case 'SOLID': c.dash = false; break;
      case 'DASH': c.dash = true; break;
      case 'CLEAN': c.hand = false; break;
      case 'HAND': c.hand = true; break;
      case 'LINE': c.path(op[1]); break;
      case 'CURVE': c.path(catmullRom(op[1])); break;
      case 'POLY': c.path(op[1], true); break;
      case 'BLOB': c.path(catmullRom(op[1], true), true); break;
      case 'FILL': c.fill(op[1]); break;
      case 'FBLOB': c.fill(catmullRom(op[1], true).slice(0, -1)); break;
      case 'CIRC': case 'DISC': case 'ELLI': {
        const [cx, cy, rx] = op.slice(1), ry = name === 'ELLI' ? op[4] : rx;
        if (name === 'DISC') {
          let [[x0, y0], [x1, y1]] = c.px([[cx - rx, cy - ry], [cx + rx, cy + ry]]);
          const rmin = (MIN_STROKE_PX * c.ss) / 2;
          if (x1 - x0 < 2 * rmin) {
            const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            x0 = mx - rmin; y0 = my - rmin; x1 = mx + rmin; y1 = my + rmin;
          }
          c.r.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, c.color);
        } else if (c.hand) c.path(ellipsePoints(cx, cy, rx, ry, c.rng.uniform(0, 2 * Math.PI), 1.04));
        else c.path(ellipsePoints(cx, cy, rx, ry), true);
        break;
      }
      case 'RECT': case 'BOX': {
        let [x0, y0, x1, y1] = op.slice(1);
        [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
        [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
        const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        if (name === 'BOX') c.fill(corners);
        else if (c.hand) {
          for (let i = 0; i < 4; i++) {
            const a = corners[i], b = corners[(i + 1) % 4];
            let vx = b[0] - a[0], vy = b[1] - a[1];
            const n = Math.hypot(vx, vy);
            if (n > 0) { vx /= n; vy /= n; }
            const ea = c.rng.uniform(0, 0.8), eb = c.rng.uniform(0, 0.8);
            c.path([[a[0] - vx * ea, a[1] - vy * ea], [b[0] + vx * eb, b[1] + vy * eb]]);
          }
        } else c.path(corners, true);
        break;
      }
      case 'TEXT': {
        const [, x, y, s, w, items] = op;
        drawText(c, x, y, s, w, resolveText(items, prompt));
        break;
      }
      default: break;
    }
  }
  return { size, pixels: c.finish(), color };
}

/** Share of the picture covered by each colour */
export function usage(pixels) {
  const n = new Array(6).fill(0);
  for (const v of pixels) n[v]++;
  return Object.fromEntries(COLOR_NAMES.map((name, i) => [name, Math.round((n[i] / pixels.length) * 1e4) / 1e4]));
}

/** RGBA bytes for showing a picture on a <canvas> */
export function toRGBA(pixels) {
  const out = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b] = PALETTE[pixels[i]];
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}
