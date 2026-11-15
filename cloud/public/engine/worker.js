// Runs INKOS in a Web Worker so the page stays responsive while it draws.
// Messages in:  {id, type: 'load', model, engine: 'vector' | 'pro', token}
//               {id, type: 'generate', model, prompt, size, seed, temperature, topP}   (INKOS 1, 1.1)
//               {id, type: 'generate', model, prompt, size, seed, steps, guidance}     (the Pro models)
// Messages out: {id, type: 'progress', stage, fraction, detail}
//               {id, type: 'loaded' | 'result' | 'error', ...}

import { describe, normalizePrompt } from './lang.js';
import { generate, loadModel } from './model.js';
import { encodePNG } from './png.js';
import { generatePro, loadPro } from './pro.js';
import { render, setFont, usage } from './render.js';

const PRO_CACHE = 'inkos-pro-weights';

const models = {};
let fontReady = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function fetchWithProgress(url, token, onBytes, cache = 'default') {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache });
  if (!res.ok) {
    let msg = `could not download ${url} (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) throw new Error('download larger than announced');
    out.set(value, got);
    got += value.length;
    onBytes(got, total);
  }
  return out.subarray(0, got);
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function openCache() {
  try { return self.caches ? await caches.open(PRO_CACHE) : null; } catch { return null; }
}

// INKOS 1 Pro / 1.1 Pro: three ONNX graphs, about 115 MB, downloaded once
// and kept in this browser's cache storage (checked against the manifest's hashes).
async function loadProModel(msg) {
  // always the current manifest; each file URL carries its hash, so no older copy can be mixed in
  const manifest = JSON.parse(new TextDecoder().decode(await fetchWithProgress(`/weights/${msg.model}/manifest.json`, msg.token, () => {}, 'no-store')));
  const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
  const cache = await openCache();
  const files = {};
  let done = 0;
  for (const f of manifest.files) {
    const key = `/weights/${msg.model}/${f.name}?sha256=${f.sha256}`;
    let bytes = null;
    const hit = cache && (await cache.match(key));
    if (hit) {
      post({ id: msg.id, type: 'progress', stage: 'loading the model from this device', fraction: done / total, detail: f.name });
      bytes = new Uint8Array(await hit.arrayBuffer());
      if (bytes.length !== f.bytes) bytes = null;
    }
    if (!bytes) {
      bytes = await fetchWithProgress(`/weights/${msg.model}/${f.name}?v=${f.sha256.slice(0, 16)}`, msg.token, (got) => {
        post({ id: msg.id, type: 'progress', stage: 'downloading the model (once)', fraction: (done + got) / total,
          detail: `${((done + got) / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` });
      });
      if ((await sha256(bytes)) !== f.sha256) throw new Error(`${f.name} arrived damaged. Try again.`);
      if (cache) { try { await cache.put(key, new Response(bytes)); } catch { /* storage full: download again next time */ } }
    }
    done += f.bytes;
    files[f.name.replace(/\.onnx$/, '')] = bytes;
  }
  if (cache) {                                         // forget older versions of this model
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (u.pathname.startsWith(`/weights/${msg.model}/`) &&
          !manifest.files.some((f) => u.pathname.endsWith(`/${f.name}`) && u.searchParams.get('sha256') === f.sha256)) await cache.delete(req);
    }
  }
  post({ id: msg.id, type: 'progress', stage: 'starting the model', fraction: 1, detail: '' });
  const pro = await loadPro(manifest, files);
  return { kind: 'pro', pro, info: { name: manifest.name, training: manifest.training, backend: pro.backend, params: manifest.params } };
}

async function load(msg) {
  if (msg.engine === 'pro') {
    if (!models[msg.model]) {
      for (const [id, m] of Object.entries(models)) {   // one Pro model at a time: each holds about 230 MB of float32 weights
        if (m.kind === 'pro') { delete models[id]; for (const s of Object.values(m.pro.sessions)) await s.release(); }
      }
      models[msg.model] = await loadProModel(msg);
    }
    return models[msg.model];
  }
  if (!fontReady) fontReady = fetch('/data/font.json').then((r) => r.json()).then(setFont);
  await fontReady;
  if (models[msg.model]) return models[msg.model];
  post({ id: msg.id, type: 'progress', stage: 'downloading the model', fraction: 0, detail: '' });
  const index = JSON.parse(new TextDecoder().decode(await fetchWithProgress(`/weights/${msg.model}.json`, msg.token, () => {})));
  const bin = await fetchWithProgress(`/weights/${msg.model}.bin`, msg.token, (got, total) => {
    post({ id: msg.id, type: 'progress', stage: 'downloading the model', fraction: got / total,
      detail: `${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` });
  });
  post({ id: msg.id, type: 'progress', stage: 'preparing the model', fraction: 1, detail: '' });
  models[msg.model] = loadModel(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  return models[msg.model];
}

async function runPro(msg, m) {
  const t0 = performance.now();
  const cfg = m.pro.cfg, color = cfg.planes > 1;
  const prompt = normalizePrompt(msg.prompt, cfg.max_prompt);
  const ups = Math.round(Math.log2(msg.size / cfg.base_resolution));
  const share = 1 - 0.08 * ups;
  const res = await generatePro(m.pro, prompt, {
    size: msg.size, seed: msg.seed, steps: msg.steps, guidance: msg.guidance,
    onStep: (i, n) => post({ id: msg.id, type: 'progress', stage: 'denoising', fraction: share * i / n, detail: `step ${i} of ${n}` }),
    onStage: (s) => post({ id: msg.id, type: 'progress', stage: `refining to ${s} px`, fraction: share + 0.08 * (Math.log2(s / cfg.base_resolution) - 1), detail: '' }),
  });
  const png = await encodePNG(res.pixels, res.size, color);
  const meta = {
    model: msg.model, model_name: m.info.name, prompt, size: res.size, seed: msg.seed, steps: res.steps, guidance: res.guidance,
    backend: m.pro.backend, seconds: Math.round(performance.now() - t0) / 1000, colors: color ? usage(res.pixels) : null,
    ink: usage(res.pixels), weights: m.info.training,
  };
  post({ id: msg.id, type: 'result', png, meta }, [png.buffer]);
}

async function run(msg) {
  const m = models[msg.model];
  if (!m) throw new Error('model not loaded');
  if (m.kind === 'pro') return runPro(msg, m);
  const t0 = performance.now();
  const prompt = normalizePrompt(msg.prompt, m.cfg.max_prompt);
  const color = m.cfg.vocab > 249;
  const res = generate(m, prompt, {
    seed: msg.seed, temperature: msg.temperature, topP: msg.topP,
    onToken: (step, max) => {
      if (step % 8 === 0) post({ id: msg.id, type: 'progress', stage: 'writing the drawing program', fraction: Math.min(0.9, step / max), detail: `${step} tokens` });
    },
  });
  post({ id: msg.id, type: 'progress', stage: 'rasterising', fraction: 0.93, detail: `${res.tokens.length} tokens` });
  const pic = render(res.ops, prompt, msg.size, msg.seed, color);
  const png = await encodePNG(pic.pixels, msg.size, color);
  const meta = {
    model: msg.model, model_name: m.info.name, prompt, size: msg.size, seed: msg.seed, temperature: msg.temperature,
    tokens: res.tokens.length, complete: res.complete, program: describe(res.ops),
    seconds: Math.round(performance.now() - t0) / 1000, colors: color ? usage(pic.pixels) : null,
    ink: usage(pic.pixels), weights: m.info.training,
  };
  post({ id: msg.id, type: 'result', png, meta }, [png.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') { const m = await load(msg); post({ id: msg.id, type: 'loaded', info: m.info }); }
    else if (msg.type === 'generate') await run(msg);
  } catch (err) {
    post({ id: msg.id, type: 'error', error: String((err && err.message) || err) });
  }
};
