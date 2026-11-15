// Runs INKOS in a Web Worker so the page stays responsive while it draws.
// Messages in:  {id, type: 'load', model, token}
//               {id, type: 'generate', model, prompt, size, seed, temperature, topP}
// Messages out: {id, type: 'progress', stage, fraction, detail}
//               {id, type: 'loaded' | 'result' | 'error', ...}

import { describe, normalizePrompt } from './lang.js';
import { generate, loadModel } from './model.js';
import { encodePNG } from './png.js';
import { render, setFont, usage } from './render.js';

const models = {};
let fontReady = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function fetchWithProgress(url, token, onBytes) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
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

async function load(msg) {
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

async function run(msg) {
  const m = models[msg.model];
  if (!m) throw new Error('model not loaded');
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
