// INKOS 1 / INKOS 1.1 inference in plain JavaScript.
// A port of inkos/models/inkos1.py: prefix-LM transformer with key/value
// cache, pointer head over the prompt, grammar-constrained top-p sampling.
// Matches PyTorch to float rounding (cloud/test/engine.test.mjs).

import { BOS, COORD0, EOS, END, Grammar, VOCAB, promptTokens } from './lang.js';
import { Rng } from './rand.js';

// ---------------------------------------------------------------------------
// weights

function halfToFloat(u16) {
  const out = new Float32Array(u16.length);
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    table[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  for (let i = 0; i < u16.length; i++) out[i] = table[u16[i]];
  return out;
}

/** index: the <model>.json written by cloud/build.py; buffer: the matching .bin */
export function loadModel(index, buffer) {
  if (index.dtype !== 'float16') throw new Error('unsupported weight format');
  const all = halfToFloat(new Uint16Array(buffer, 0, index.elements));
  const T = {};
  for (const [name, t] of Object.entries(index.tensors)) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    T[name] = all.subarray(t.offset, t.offset + n);
  }
  const c = index.config;
  const need = ['tok.weight', 'seg.weight', 'pos_prompt.weight', 'pos_prog.weight', 'ptr_emb', 'norm.weight', 'ptr_q.weight', 'ptr_k.weight'];
  for (const k of need) if (!T[k]) throw new Error(`weights are missing ${k}`);
  const blocks = [];
  for (let i = 0; i < c.n_layers; i++) {
    const g = (k) => T[`blocks.${i}.${k}`];
    blocks.push({ n1w: g('n1.weight'), n1b: g('n1.bias'), qkvW: g('qkv.weight'), qkvB: g('qkv.bias'),
      projW: g('proj.weight'), projB: g('proj.bias'), n2w: g('n2.weight'), n2b: g('n2.bias'),
      fc1W: g('fc1.weight'), fc1B: g('fc1.bias'), fc2W: g('fc2.weight'), fc2B: g('fc2.bias') });
  }
  return { cfg: { ...c, vocab: c.vocab || VOCAB }, T, blocks, info: { model: index.model, name: index.name, training: index.training } };
}

// ---------------------------------------------------------------------------
// maths (accumulation in float64)

function linear(out, oOff, x, xOff, W, b, nOut, nIn) {
  for (let o = 0; o < nOut; o++) {
    let s = b ? b[o] : 0;
    const row = o * nIn;
    for (let i = 0; i < nIn; i++) s += W[row + i] * x[xOff + i];
    out[oOff + o] = s;
  }
}

function layerNorm(out, oOff, x, xOff, w, b, n) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[xOff + i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = x[xOff + i] - mean; v += d * d; }
  const inv = 1 / Math.sqrt(v / n + 1e-5);
  for (let i = 0; i < n; i++) out[oOff + i] = (x[xOff + i] - mean) * inv * w[i] + b[i];
}

// erf with |error| < 1.2e-7 (Numerical Recipes erfc, Chebyshev fit)
function erf(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));

// ---------------------------------------------------------------------------
// transformer

class Runner {
  constructor(m, maxLen) {
    this.m = m;
    const c = m.cfg;
    this.D = c.d_model; this.H = c.n_heads; this.hd = c.d_model / c.n_heads; this.F = c.d_ff;
    this.K = m.blocks.map(() => new Float32Array(maxLen * this.D));
    this.Vc = m.blocks.map(() => new Float32Array(maxLen * this.D));
    this.len = 0;
  }

  /** Run n new positions (rows of x, [n, D]) through every block; they attend to the cache and to each other. */
  step(x, n) {
    const { D, H, hd, F } = this;
    const h = new Float32Array(n * D), qkv = new Float32Array(n * 3 * D), att = new Float32Array(n * D);
    const tmp = new Float32Array(D), ff = new Float32Array(F);
    const scale = 1 / Math.sqrt(hd);
    for (let L = 0; L < this.m.blocks.length; L++) {
      const B = this.m.blocks[L], Kc = this.K[L], Vc = this.Vc[L];
      for (let r = 0; r < n; r++) {
        layerNorm(h, r * D, x, r * D, B.n1w, B.n1b, D);
        linear(qkv, r * 3 * D, h, r * D, B.qkvW, B.qkvB, 3 * D, D);
        Kc.set(qkv.subarray(r * 3 * D + D, r * 3 * D + 2 * D), (this.len + r) * D);
        Vc.set(qkv.subarray(r * 3 * D + 2 * D, r * 3 * D + 3 * D), (this.len + r) * D);
      }
      const total = this.len + n;
      const sc = new Float64Array(total);
      for (let r = 0; r < n; r++) {
        for (let hh = 0; hh < H; hh++) {
          const qo = r * 3 * D + hh * hd;
          let mx = -Infinity;
          for (let j = 0; j < total; j++) {
            let s = 0;
            const ko = j * D + hh * hd;
            for (let i = 0; i < hd; i++) s += qkv[qo + i] * Kc[ko + i];
            sc[j] = s * scale;
            if (sc[j] > mx) mx = sc[j];
          }
          let sum = 0;
          for (let j = 0; j < total; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
          const ao = r * D + hh * hd;
          for (let i = 0; i < hd; i++) att[ao + i] = 0;
          for (let j = 0; j < total; j++) {
            const w = sc[j] / sum, vo = j * D + hh * hd;
            for (let i = 0; i < hd; i++) att[ao + i] += w * Vc[vo + i];
          }
        }
      }
      for (let r = 0; r < n; r++) {
        linear(tmp, 0, att, r * D, B.projW, B.projB, D, D);
        for (let i = 0; i < D; i++) x[r * D + i] += tmp[i];
        layerNorm(h, r * D, x, r * D, B.n2w, B.n2b, D);
        linear(ff, 0, h, r * D, B.fc1W, B.fc1B, F, D);
        for (let i = 0; i < F; i++) ff[i] = gelu(ff[i]);
        linear(tmp, 0, ff, 0, B.fc2W, B.fc2B, D, F);
        for (let i = 0; i < D; i++) x[r * D + i] += tmp[i];
      }
    }
    this.len += n;
    return x;
  }
}

function addRow(dst, dOff, src, sOff, n) { for (let i = 0; i < n; i++) dst[dOff + i] += src[sOff + i]; }

/**
 * Sample one program for `prompt` (already normalised).
 * opts: {temperature, topP, maxTokens, seed, constrain, onToken(step, max)}
 * -> {tokens, ops, complete}
 */
export function generate(m, prompt, opts = {}) {
  const c = m.cfg, T = m.T, D = c.d_model, V = c.vocab;
  prompt = prompt.slice(0, c.max_prompt);
  const P = prompt.length;
  const maxTokens = Math.min(opts.maxTokens || c.max_program, c.max_program);
  const temperature = opts.temperature ?? 0.7, topP = opts.topP ?? 0.95, constrain = opts.constrain ?? true;
  const rng = new Rng(opts.seed ?? 0);
  const ids = promptTokens(prompt);
  const run = new Runner(m, P + maxTokens + 1);

  // prompt: bidirectional prefix
  const x = new Float32Array(Math.max(1, P) * D);
  for (let p = 0; p < P; p++) {
    x.set(T['tok.weight'].subarray(ids[p] * D, ids[p] * D + D), p * D);
    addRow(x, p * D, T['pos_prompt.weight'], p * D, D);
    addRow(x, p * D, T['seg.weight'], 0, D);
  }
  const keys = new Float32Array(Math.max(1, P) * D);
  if (P) {
    run.step(x, P);
    const hn = new Float32Array(D);
    for (let p = 0; p < P; p++) {
      layerNorm(hn, 0, x, p * D, T['norm.weight'], T['norm.bias'], D);
      linear(keys, p * D, hn, 0, T['ptr_k.weight'], T['ptr_k.bias'], D, D);
    }
  }

  const g = new Grammar(P, V);
  const out = [];
  let tok = BOS;
  const xt = new Float32Array(D), hn = new Float32Array(D), q = new Float32Array(D);
  const logits = new Float64Array(V + P);
  const sqrtD = Math.sqrt(D);
  for (let step = 0; step < maxTokens; step++) {
    // embed the previous token (pointer ids embed the prompt character they point at)
    if (tok >= V) {
      const idx = Math.min(Math.max(tok - V, 0), Math.max(0, P - 1));
      xt.set(T['tok.weight'].subarray(ids[idx] * D, ids[idx] * D + D));
      addRow(xt, 0, T['pos_prompt.weight'], idx * D, D);
      addRow(xt, 0, T['ptr_emb'], 0, D);
    } else xt.set(T['tok.weight'].subarray(tok * D, tok * D + D));
    addRow(xt, 0, T['pos_prog.weight'], step * D, D);
    addRow(xt, 0, T['seg.weight'], D, D);
    run.step(xt, 1);
    layerNorm(hn, 0, xt, 0, T['norm.weight'], T['norm.bias'], D);
    linear(logits, 0, hn, 0, T['tok.weight'], null, V, D);          // tied head
    linear(q, 0, hn, 0, T['ptr_q.weight'], T['ptr_q.bias'], D, D);
    for (let p = 0; p < P; p++) {
      let s = 0;
      for (let i = 0; i < D; i++) s += q[i] * keys[p * D + i];
      logits[V + p] = s / sqrtD;
    }
    let mask = null;
    if (constrain) {
      mask = g.allowed();
      if (step >= maxTokens - 4) {               // out of budget: close the open path / end the program
        if (mask[END] || mask[EOS]) {
          const keep = new Uint8Array(mask.length);
          keep[END] = mask[END]; keep[EOS] = mask[EOS];
          mask = keep;
        }
      }
      for (let i = 0; i < logits.length; i++) if (!mask[i]) logits[i] = -Infinity;
    } else { logits[0] = -Infinity; logits[BOS] = -Infinity; }
    tok = sample(logits, temperature, topP, rng);
    if (!g.feed(tok, mask)) break;
    if (tok === EOS) break;
    out.push(tok);
    if (opts.onToken) opts.onToken(step + 1, maxTokens);
  }
  return { tokens: out, ops: g.ops, complete: g.done };
}

export function sample(logits, temperature, topP, rng) {
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  if (temperature <= 0) return best;
  const n = logits.length, probs = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { probs[i] = Math.exp((logits[i] - logits[best]) / temperature); sum += probs[i]; }
  for (let i = 0; i < n; i++) probs[i] /= sum;
  let order = null;
  if (topP < 1) {
    order = Array.from(probs.keys()).filter((i) => probs[i] > 0).sort((a, b) => probs[b] - probs[a] || a - b);
    let cum = 0;
    const kept = [];
    for (const i of order) { if (cum >= topP) break; kept.push(i); cum += probs[i]; }
    order = kept;
  } else order = Array.from(probs.keys());
  let total = 0;
  for (const i of order) total += probs[i];
  let r = rng.random() * total;
  for (const i of order) { r -= probs[i]; if (r < 0) return i; }
  return order[order.length - 1];
}

export { COORD0 };
