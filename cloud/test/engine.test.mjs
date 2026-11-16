// The browser engine must reproduce the Python implementation.
//   python cloud/build.py && python cloud/test/make_fixtures.py
//   node --test cloud/test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import * as lang from '../public/engine/lang.js';
import { generate, loadModel } from '../public/engine/model.js';
import { encodePNG } from '../public/engine/png.js';
import { render, setFont, wrapText } from '../public/engine/render.js';
import * as motion from '../public/engine/motion.js';
import { FRAMES, frameOps, frameTime } from '../public/engine/motion.js';
import { encodeGIF } from '../public/engine/gif.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const FIX = JSON.parse(readFileSync(here('./fixtures.json'), 'utf8'));
const APP = JSON.parse(readFileSync(here('../public/data/app.json'), 'utf8'));
setFont(JSON.parse(readFileSync(here('../public/data/font.json'), 'utf8')));

const models = {};
function model(id) {
  if (!models[id]) {
    const index = JSON.parse(readFileSync(here(`../public/weights/${id}.json`), 'utf8'));
    const bin = readFileSync(here(`../public/weights/${id}.bin`));
    models[id] = loadModel(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  }
  return models[id];
}
const pixels = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

function compare(a, b) {
  // ink overlap (any non-white) and colour agreement on inked pixels
  let inter = 0, union = 0, same = 0;
  for (let i = 0; i < a.length; i++) {
    const ia = a[i] !== 1, ib = b[i] !== 1;
    if (ia || ib) { union++; if (a[i] === b[i]) same++; }
    if (ia && ib) inter++;
  }
  return { iou: union ? inter / union : 1, colour: union ? same / union : 1 };
}

test('constants match the Python drawing language', () => {
  const L = APP.lang;
  assert.deepEqual(lang.NAMES, L.NAMES);
  for (const k of ['GRID', 'PAD', 'BOS', 'EOS', 'COORD0', 'CHAR0', 'VOCAB', 'COLOR0', 'VOCAB_COLOR', 'MAX_PATH_POINTS', 'MAX_TEXT_ITEMS']) {
    assert.equal(lang[k], L[k], k);
  }
  assert.deepEqual(lang.PATH_MIN, L.PATH_MIN);
  assert.deepEqual(lang.FIXED_ARGS, L.FIXED_ARGS);
});

test('prompt normalisation and word wrap match Python', () => {
  for (const [input, want] of FIX.normalize) assert.equal(lang.normalizePrompt(input, 256), want, JSON.stringify(input));
  for (const [text, n, want] of FIX.wrap) assert.deepEqual(wrapText(text, n), want, text);
});

for (const id of ['inkos1', 'inkos1_1', 'inkos_motion1']) {
  test(`${id}: greedy decoding gives exactly the PyTorch tokens`, { skip: !FIX.models[id] && `${id} is not installed` }, () => {
    const m = model(id);
    const fx = FIX.models[id];
    assert.equal(m.cfg.vocab, id === 'inkos_motion1' ? lang.VOCAB_MOTION : fx.color ? lang.VOCAB_COLOR : lang.VOCAB);
    for (const c of fx.cases) {
      const res = generate(m, c.prompt, { temperature: 0, maxTokens: 200 });
      assert.deepEqual(res.tokens, c.tokens, c.prompt);
      assert.equal(res.complete, c.complete);
      const back = lang.decode([...res.tokens, lang.EOS], c.prompt.length, m.cfg.vocab);
      assert.ok(back.ok);
      const clean = res.ops.filter((o) => !(o.length === 1 && o[0] === 'HAND') && o[0] !== 'AT' && o[0] !== 'ANIM');   // see make_fixtures.py
      const js = render(clean, c.prompt, 256, 0, fx.color).pixels;
      const { iou, colour } = compare(js, pixels(c.render256));
      assert.ok(iou > 0.85, `${c.prompt}: ink overlap with the Python render ${iou.toFixed(3)}`);
      if (fx.color) assert.ok(colour > 0.85, `${c.prompt}: colour agreement ${colour.toFixed(3)}`);
    }
  });
}

test('rasteriser: the same program draws (nearly) the same pixels as Python', () => {
  for (const f of FIX.render) {
    const ops = f.ops.map((o) => [...o]);
    const out = render(ops, f.prompt, f.size, 0, f.color);
    assert.equal(out.pixels.length, f.size * f.size);
    const ref = pixels(f.pixels);
    const { iou, colour } = compare(out.pixels, ref);
    assert.ok(iou > 0.93, `${f.size}px ${f.color ? 'colour' : 'mono'}: ink overlap ${iou.toFixed(3)}`);
    assert.ok(colour > 0.92, `${f.size}px colour agreement ${colour.toFixed(3)}`);
    const used = new Set(out.pixels);
    for (const v of used) assert.ok(v < 6);
    if (!f.color) assert.deepEqual([...used].sort(), [0, 1]);
  }
});

function readPNG(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let off = 8; const chunks = {}; let idat = [];
  while (off < bytes.length) {
    const len = dv.getUint32(off), type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data); else chunks[type] = data;
    off += 12 + len;
  }
  const ih = new DataView(chunks.IHDR.buffer, chunks.IHDR.byteOffset);
  return { w: ih.getUint32(0), h: ih.getUint32(4), depth: chunks.IHDR[8], type: chunks.IHDR[9], plte: chunks.PLTE,
    raw: inflateSync(Buffer.concat(idat)) };
}

test('PNG: 1-bit greyscale for black and white, a six-entry palette for colour', async () => {
  const size = 37;
  const px = new Uint8Array(size * size).map((_, i) => (i % 3 === 0 ? 0 : 1));
  const mono = readPNG(await encodePNG(px, size, false));
  assert.deepEqual([mono.w, mono.h, mono.depth, mono.type, mono.plte], [size, size, 1, 0, undefined]);
  const rowBytes = Math.ceil(size / 8);
  for (let y = 0; y < size; y++) {
    assert.equal(mono.raw[y * (rowBytes + 1)], 0);
    for (let x = 0; x < size; x++) {
      const bit = (mono.raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
      assert.equal(bit, px[y * size + x]);
    }
  }
  const cpx = new Uint8Array(size * size).map((_, i) => i % 6);
  const col = readPNG(await encodePNG(cpx, size, true));
  assert.deepEqual([col.depth, col.type, col.plte.length], [4, 3, 18]);
  assert.deepEqual([...col.plte], [0, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 255, 0]);
  const rb = Math.ceil(size / 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const b = col.raw[y * (rb + 1) + 1 + (x >> 1)];
    assert.equal(x & 1 ? b & 15 : b >> 4, cpx[y * size + x]);
  }
});

test('sampling: same seed, same drawing; output always parses', () => {
  const m = model('inkos1_1');
  const a = generate(m, 'colorful flowchart: Start -> Done', { seed: 7, maxTokens: 160 });
  const b = generate(m, 'colorful flowchart: Start -> Done', { seed: 7, maxTokens: 160 });
  assert.deepEqual(a.tokens, b.tokens);
  for (let seed = 0; seed < 3; seed++) {
    const r = generate(m, 'red heart', { seed, temperature: 1.0, topP: 1.0, maxTokens: 60 });
    assert.ok(r.tokens.length <= 60);
    assert.deepEqual(lang.decode([...r.tokens, lang.EOS], 9, m.cfg.vocab).ops, r.ops);
  }
});

// ---------------------------------------------------------------------------
// INKOS MOTION 1: frame programs and GIF

test('motion: every frame program matches Python', () => {
  const M = FIX.motion;
  assert.equal(M.frames, FRAMES);
  for (const k of ['FRAMES', 'FPS', 'U_END', 'DUR']) assert.equal(motion[k], APP.motion[k], k);
  assert.equal(lang.VOCAB_MOTION, APP.motion.VOCAB_MOTION);
  assert.deepEqual(lang.EFFECTS, APP.motion.EFFECTS);
  const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);
  for (let f = 0; f < FRAMES; f++) {
    const js = frameOps(M.ops, M.prompt, frameTime(f)), py = M.frame_ops[f];
    assert.equal(js.length, py.length, `frame ${f}: number of commands`);
    js.forEach((op, i) => {
      const a = flat(op), b = flat(py[i]);
      assert.equal(a.length, b.length, `frame ${f} command ${i}`);
      a.forEach((v, j) => (typeof v === 'number' ? assert.ok(Math.abs(v - b[j]) < 1e-9, `frame ${f} command ${i}: ${v} vs ${b[j]}`)
        : assert.deepEqual(v, b[j])));
    });
  }
});

function readGIF(bytes) {
  // a minimal decoder: global palette, one image per frame, LZW
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  const w = bytes[6] | (bytes[7] << 8), flags = bytes[10];
  const palSize = 2 << (flags & 7);
  const pal = [...bytes.subarray(13, 13 + 3 * palSize)];
  let o = 13 + 3 * palSize, loop = false;
  const frames = [];
  while (bytes[o] !== 0x3b) {
    if (bytes[o] === 0x21) {
      if (bytes[o + 1] === 0xff && String.fromCharCode(...bytes.subarray(o + 3, o + 14)) === 'NETSCAPE2.0') loop = true;
      o += 2;
      while (bytes[o]) o += bytes[o] + 1;
      o++;
      continue;
    }
    assert.equal(bytes[o], 0x2c);
    const min = bytes[o + 10];
    o += 11;
    const data = [];
    while (bytes[o]) { data.push(...bytes.subarray(o + 1, o + 1 + bytes[o])); o += bytes[o] + 1; }
    o++;
    const clear = 1 << min, eoi = clear + 1, out = [];
    let size = min + 1, dict = [], prev = null, bit = 0;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = min + 1; prev = null; };
    reset();
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      let entry = code < dict.length ? dict[code] : [...prev, prev[0]];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length === (1 << size) && size < 12) size++;
    }
    frames.push(Uint8Array.from(out));
  }
  return { w, pal, loop, frames };
}

test('motion: GIF holds every frame exactly, in the six colours, looping', () => {
  const M = FIX.motion, size = 128;
  const frames = [];
  for (let f = 0; f < FRAMES; f += 3) frames.push(render(frameOps(M.ops, M.prompt, frameTime(f)), M.prompt, size, 0, true).pixels);
  const g = readGIF(encodeGIF(frames, size, 8));
  assert.equal(g.w, size);
  assert.ok(g.loop);
  assert.deepEqual(g.pal.slice(0, 18), [0, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 255, 0]);
  assert.equal(g.frames.length, frames.length);
  g.frames.forEach((f, i) => assert.deepEqual(f, frames[i], `frame ${i}`));
  // a large noisy frame forces the code table to fill up and restart
  const noisy = Uint8Array.from({ length: 256 * 256 }, (_, i) => (i * 2654435761 >>> 13) % 6);
  assert.deepEqual(readGIF(encodeGIF([noisy], 256, 8)).frames[0], noisy);
});
