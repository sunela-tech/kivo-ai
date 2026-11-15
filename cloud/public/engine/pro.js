// INKOS 1 Pro and INKOS 1.1 Pro in the browser, through onnxruntime-web.
//
// The model is three ONNX graphs exported from the PyTorch weights
// (cloud/pro_onnx.py, checked against PyTorch to about 1e-6):
//   text     prompt characters -> features, mask, pooled vector
//   step     one Euler step of the rectified-flow sampler with classifier-free
//            guidance and self-conditioning: (x, x0_prev, t, t_next/t, g) -> (x_next, x0)
//   refiner  the learned 2x refiner, applied once for 512 px and twice for 1024 px
// This file holds the loop around them, the same as Inkos1Pro.sample and
// engine.upscale_tiled in the Python app. The noise comes from this page's
// own seeded generator, so a seed does not give the Python app's picture.

import { Rng } from './rand.js';

// onnxruntime-web, served by the Worker from KV (cloud/upload_weights.py); build.py checks the version
export const ORT_VERSION = '1.31.1';
export const ORT_BASE = `/ort/${ORT_VERSION}/`;
let ort = null;

async function runtime() {
  if (!ort) {
    ort = await import(`${ORT_BASE}ort.webgpu.bundle.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
  }
  return ort;
}

async function hasWebGPU() {
  try { return !!(self.navigator && navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

/** files: {text, step, refiner} as Uint8Array ONNX bytes. -> a loaded Pro model */
export async function loadPro(manifest, files, { forceBackend } = {}) {
  const rt = await runtime();
  const tryCreate = async (ep) => {
    const opts = { executionProviders: [ep], graphOptimizationLevel: 'all' };
    const sessions = {};
    for (const name of ['text', 'step', 'refiner']) sessions[name] = await rt.InferenceSession.create(files[name], opts);
    return sessions;
  };
  let backend = forceBackend || ((await hasWebGPU()) ? 'webgpu' : 'wasm');
  let sessions;
  try {
    sessions = await tryCreate(backend);
  } catch (e) {
    if (backend === 'wasm') throw e;
    backend = 'wasm';                                // no usable GPU: run on the CPU instead
    sessions = await tryCreate(backend);
  }
  return { manifest, cfg: manifest.config, sessions, backend };
}

/** The prompt as character ids: <bos>, then one id per character, padded to the graph's length. */
export function tokenize(prompt, cfg) {
  const ids = new BigInt64Array(cfg.text_length);
  ids[0] = BigInt(cfg.bos_id);
  const chars = Array.from(prompt).slice(0, cfg.text_length - 1);
  chars.forEach((c, i) => {
    const v = c.codePointAt(0) - cfg.first_char + 1;
    ids[i + 1] = BigInt(Math.min(cfg.n_chars, Math.max(1, v)));
  });
  return ids;
}

/** torch.linspace(1, 0, steps + 1) */
export function schedule(steps) {
  const ts = [];
  for (let i = 0; i <= steps; i++) ts.push(1 - i / steps);
  ts[steps] = 0;
  return ts;
}

/** x0 estimate [C,R,R] -> palette indices [R*R] (0 black, 1 white, 2.. colours) */
export function decide(x0, planes, n) {
  const out = new Uint8Array(n);
  if (planes === 1) {
    for (let i = 0; i < n; i++) out[i] = x0[i] > 0 ? 0 : 1;          // ink is black
    return out;
  }
  for (let i = 0; i < n; i++) {
    let best = 0, bv = x0[i];
    for (let c = 1; c < planes; c++) { const v = x0[c * n + i]; if (v > bv) { bv = v; best = c; } }
    out[i] = best;
  }
  return out;
}

/** palette indices [h*w] -> the refiner's input [C,h,w] in -1 / +1 */
export function refinerInput(pic, planes, n) {
  const x = new Float32Array(planes * n).fill(-1);
  if (planes === 1) { for (let i = 0; i < n; i++) x[i] = pic[i] === 0 ? 1 : -1; return x; }
  for (let i = 0; i < n; i++) x[pic[i] * n + i] = 1;
  return x;
}

async function refine(model, pic, H, W) {
  const rt = await runtime();
  const C = model.cfg.planes, n = H * W;
  const out = await model.sessions.refiner.run({ x: new rt.Tensor('float32', refinerInput(pic, C, n), [1, C, H, W]) });
  return decide(out.logits.data, C, 4 * n);
}

/** engine.upscale_tiled: 2x in overlapping tiles so memory stays flat at any size */
export async function upscaleTiled(model, pic, size, tile = 256, overlap = 16) {
  if (size <= tile + 2 * overlap) return refine(model, pic, size, size);
  const S2 = 2 * size, out = new Uint8Array(S2 * S2);
  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      const y0 = Math.max(0, y - overlap), x0 = Math.max(0, x - overlap);
      const y1 = Math.min(size, y + tile + overlap), x1 = Math.min(size, x + tile + overlap);
      const h = y1 - y0, w = x1 - x0, crop = new Uint8Array(h * w);
      for (let r = 0; r < h; r++) crop.set(pic.subarray((y0 + r) * size + x0, (y0 + r) * size + x1), r * w);
      const up = await refine(model, crop, h, w);
      const ty = 2 * (y - y0), tx = 2 * (x - x0);
      const hh = 2 * Math.min(tile, size - y), ww = 2 * Math.min(tile, size - x);
      for (let r = 0; r < hh; r++) out.set(up.subarray((ty + r) * 2 * w + tx, (ty + r) * 2 * w + tx + ww), (2 * y + r) * S2 + 2 * x);
    }
  }
  return out;
}

/**
 * Generate one picture.
 * -> {pixels: Uint8Array palette indices, size, steps, guidance}
 * onStep(i, steps) after every denoising step; onStage(name) before each refiner pass.
 */
export async function generatePro(model, prompt, { size, seed, steps, guidance, noise, onStep, onStage }) {
  const rt = await runtime();
  const cfg = model.cfg, R = cfg.base_resolution, C = cfg.planes, n = R * R;
  const L = cfg.text_length;
  const ids = new BigInt64Array(2 * L);
  ids.set(tokenize(prompt, cfg), 0);
  ids[L] = BigInt(cfg.bos_id);                                   // row 1: the empty prompt, for guidance
  const enc = await model.sessions.text.run({ ids: new rt.Tensor('int64', ids, [2, L]) });

  let x;
  if (noise) x = Float32Array.from(noise);
  else {
    const rng = new Rng(seed >>> 0);
    x = new Float32Array(C * n);
    for (let i = 0; i < x.length; i++) x[i] = rng.normal();
  }
  let sc = new Float32Array(C * n);
  const ts = schedule(steps), shape = [1, C, R, R];
  const scalar = (v) => new rt.Tensor('float32', new Float32Array([v]), [1]);
  for (let i = 0; i < steps; i++) {
    const out = await model.sessions.step.run({
      x: new rt.Tensor('float32', x, shape), self_cond: new rt.Tensor('float32', sc, shape),
      t: scalar(ts[i]), ratio: scalar(ts[i + 1] / ts[i]), guidance: scalar(guidance),
      text: enc.text, mask: enc.mask, pooled: enc.pooled,
    });
    x = out.x_next.data;
    sc = out.x0.data;
    if (onStep) onStep(i + 1, steps);
  }
  let pic = decide(sc, C, n), s = R;
  while (s < size) {
    if (onStage) onStage(s * 2);
    pic = await upscaleTiled(model, pic, s);
    s *= 2;
  }
  return { pixels: pic, size: s, steps, guidance };
}
