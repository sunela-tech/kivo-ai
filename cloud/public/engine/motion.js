// INKOS MOTION 1: an animated InkScript program -> the plain program of each
// frame. The same arithmetic as inkos/vector/motion.py (checked by
// test/engine.test.mjs against Python's frame programs).

import { GRID, resolveText } from './lang.js';
import { catmullRom, charsPerLine, ellipsePoints, fontMetrics, wrapText } from './render.js';

export const FRAMES = 24, FPS = 8, U_END = 20, DUR = 3;
const STATE = new Set(['W', 'INK', 'ERASE', 'SOLID', 'DASH', 'CLEAN', 'HAND', 'COLOR']);
const FILLED = new Set(['FILL', 'FBLOB', 'BOX', 'DISC']);

export const frameTime = (f, frames = FRAMES) => (f * U_END) / (frames - 1);

function textBox(op, prompt) {
  const [, x, y, s0, w, items] = op;
  const text = resolveText(items, prompt);
  const s = Math.max(1, s0);
  const cpl = charsPerLine(s, w > 0 ? w : GRID);
  let rows = wrapText(text, cpl);
  if (!rows.length) rows = [''];
  const { adv, lineH } = fontMetrics();
  return [x, y, x + Math.max(...rows.map((r) => r.length)) * adv * s, y + rows.length * lineH * s];
}

export function bbox(op, prompt) {
  const name = op[0];
  if (name === 'RECT' || name === 'BOX') {
    const [, x0, y0, x1, y1] = op;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
  if (name === 'CIRC' || name === 'DISC') { const [, cx, cy, r] = op; return [cx - r, cy - r, cx + r, cy + r]; }
  if (name === 'ELLI') { const [, cx, cy, rx, ry] = op; return [cx - rx, cy - ry, cx + rx, cy + ry]; }
  if (name === 'TEXT') return textBox(op, prompt);
  const xs = op[1].map((p) => p[0]), ys = op[1].map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

class Affine {
  constructor(pivot = [0, 0], sx = 1, sy = 1, theta = 0, dx = 0, dy = 0) {
    [this.px, this.py] = pivot;
    Object.assign(this, { sx, sy, theta, dx, dy, c: Math.cos(theta), s: Math.sin(theta) });
  }
  apply(x, y) {
    const ux = (x - this.px) * this.sx, uy = (y - this.py) * this.sy;
    return [this.px + this.c * ux - this.s * uy + this.dx, this.py + this.s * ux + this.c * uy + this.dy];
  }
  pts(pts) { return pts.map(([x, y]) => this.apply(x, y)); }
}

function ring(cx, cy, rx, ry, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = (i * 2 * Math.PI) / n; out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  return out;
}

export function transform(op, A) {
  const name = op[0], turned = Math.abs(A.theta) > 1e-9;
  if (['LINE', 'CURVE', 'POLY', 'BLOB', 'FILL', 'FBLOB'].includes(name)) return [name, A.pts(op[1])];
  if (name === 'CIRC' || name === 'DISC') {
    const [, cx, cy, r] = op, [x, y] = A.apply(cx, cy);
    if (Math.abs(A.sx - A.sy) < 1e-9) return [name, x, y, r * Math.abs(A.sx)];
    if (name === 'CIRC') return ['ELLI', x, y, r * Math.abs(A.sx), r * Math.abs(A.sy)];
    return ['FILL', A.pts(ring(cx, cy, r, r))];
  }
  if (name === 'ELLI') {
    const [, cx, cy, rx, ry] = op;
    if (turned) return ['POLY', A.pts(ring(cx, cy, rx, ry))];
    const [x, y] = A.apply(cx, cy);
    return ['ELLI', x, y, rx * Math.abs(A.sx), ry * Math.abs(A.sy)];
  }
  if (name === 'RECT' || name === 'BOX') {
    const [, x0, y0, x1, y1] = op;
    if (turned) return [name === 'RECT' ? 'POLY' : 'FILL', A.pts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])];
    const [a, b] = A.apply(x0, y0), [c, d] = A.apply(x1, y1);
    return [name, a, b, c, d];
  }
  if (name === 'TEXT') {
    const [, x, y, s, w, items] = op;
    const k = Math.sqrt(Math.abs(A.sx * A.sy));
    const [nx, ny] = turned ? [x + A.dx, y + A.dy] : A.apply(x, y);
    return ['TEXT', nx, ny, s * k, w > 0 ? w * k : w, items];
  }
  return op;
}

/** the first `frac` of a polyline, by length (numpy.searchsorted 'right' semantics, as in Python) */
function cut(pts, frac) {
  const p = pts.map((q) => [+q[0], +q[1]]);
  if (p.length < 2 || frac >= 1) return p;
  const seg = [], s = [0];
  for (let i = 1; i < p.length; i++) { seg.push(Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])); s.push(s[i - 1] + seg[i - 1]); }
  const want = frac * s[s.length - 1];
  let k = 0;
  while (k < s.length && s[k] <= want) k++;
  const out = p.slice(0, k);
  if (k < p.length && seg[k - 1] > 0) {
    const t = (want - s[k - 1]) / seg[k - 1];
    out.push([p[k - 1][0] + t * (p[k][0] - p[k - 1][0]), p[k - 1][1] + t * (p[k][1] - p[k - 1][1])]);
  }
  return out.length >= 2 ? out : [[...p[0]], [...p[0]]];
}

export function drawOn(op, p, prompt) {
  const name = op[0];
  if (p >= 1) return op;
  if (name === 'TEXT') {
    const [, x, y, s, w, items] = op;
    let n = Math.ceil(p * resolveText(items, prompt).length);
    const kept = [];
    for (const it of items) {
      if (n <= 0) break;
      if (typeof it === 'string') { kept.push(it.slice(0, n)); n -= it.length; }
      else { const [i, j] = it, m = j - i + 1; kept.push([i, i + Math.min(m, n) - 1]); n -= m; }
    }
    return kept.length ? ['TEXT', x, y, s, w, kept] : null;
  }
  let line;
  if (name === 'LINE') line = op[1];
  else if (name === 'CURVE') line = catmullRom(op[1]);
  else if (name === 'POLY') line = [...op[1], op[1][0]];
  else if (name === 'BLOB') line = catmullRom(op[1], true);
  else if (name === 'RECT') { const [, x0, y0, x1, y1] = op; line = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]; }
  else if (name === 'CIRC' || name === 'ELLI') {
    const rx = op[3], ry = name === 'ELLI' ? op[4] : rx;
    line = ellipsePoints(op[1], op[2], rx, ry, -Math.PI / 2, 1);
  } else return null;
  if (p <= 0) return null;
  return ['LINE', cut(line, p)];
}

export function groups(ops) {
  const out = [];
  let cur = null, at = 0, eff = 'STILL';
  ops.forEach((op, i) => {
    if (op[0] === 'AT') { at = op[1]; cur = null; }
    else if (op[0] === 'ANIM') { eff = op[1]; cur = null; }
    else if (!STATE.has(op[0])) {
      if (!cur) { cur = { start: at, effect: eff, items: [] }; out.push(cur); }
      cur.items.push([i, op]);
    }
  });
  return out;
}

/** the plain (INKOS 1.1) program that shows the clip at time u */
export function frameOps(ops, prompt, u) {
  const shown = new Map();
  for (const g of groups(ops)) {
    const t = u - g.start, eff = g.effect, items = g.items;
    if (t < 0 || (eff === 'BLINK' && Math.floor(t / 2) % 2 === 1)) { for (const [i] of items) shown.set(i, null); continue; }
    const p = Math.min(1, t / DUR), e = 1 - (1 - p) ** 2;
    const boxes = items.map(([, op]) => bbox(op, prompt));
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let A = null;
    if (eff === 'POP') A = new Affine([cx, cy], e, e);
    else if (eff === 'GROW') A = new Affine([cx, y1], 1, e);
    else if (eff === 'SLIDE') A = new Affine([0, 0], 1, 1, 0, -(1 - e) * (x1 + 2));
    else if (eff === 'SPIN') A = new Affine([cx, cy], 1, 1, (2 * Math.PI * t) / 8);
    else if (eff === 'BOUNCE') A = new Affine([0, 0], 1, 1, 0, 0, -6 * Math.abs(Math.sin((Math.PI * t) / 4)));
    for (const [i, op] of items) {
      let next;
      if (eff === 'DRAW') {
        next = drawOn(op, p, prompt);
        if (next === null && FILLED.has(op[0]) && e > 0.02) next = transform(op, new Affine([cx, cy], e, e));
      } else if (A) next = (eff === 'POP' || eff === 'GROW') && e <= 0.02 ? null : transform(op, A);
      else next = op;
      shown.set(i, next);
    }
  }
  const out = [];
  ops.forEach((op, i) => {
    if (op[0] === 'AT' || op[0] === 'ANIM') return;
    if (shown.has(i)) { if (shown.get(i) !== null) out.push(shown.get(i)); } else out.push(op);
  });
  return out;
}

export const isAnimated = (ops) => ops.some((op) => op[0] === 'AT' || op[0] === 'ANIM');
