// Runs the browser Pro engine (public/engine/pro.js + onnxruntime-web) in
// Chromium and compares its pictures with PyTorch's.
//
//   python cloud/pro_onnx.py inkos1_pro                    # the ONNX graphs
//   python cloud/test/make_pro_fixtures.py inkos1_pro      # PyTorch's pictures
//   node test/pro.browser.mjs inkos1_pro [wasm|webgpu|compare]
//
// Needs Playwright's Chromium. Same noise in, so the pictures must agree up
// to the few pixels whose value sits on the decision boundary. `compare`
// runs one denoising step and one refiner pass on WebGPU and WebAssembly and
// reports the largest difference (quick enough for a software GPU).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const cloud = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [model = 'inkos1_pro', backend = 'wasm'] = process.argv.slice(2);
const ORT_VERSION = JSON.parse(fs.readFileSync(path.join(cloud, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version;
const ROUTES = [['/engine/', path.join(cloud, 'public/engine')], [`/ort/${ORT_VERSION}/`, path.join(cloud, 'node_modules/onnxruntime-web/dist')],
  ['/weights/', path.join(cloud, 'public/weights')], ['/fixtures/', path.join(here, 'pro-fixtures')]];
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };

const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
const w = new Worker('/test-worker.js', { type: 'module' });
window.run = (args) => new Promise((resolve, reject) => {
  w.onmessage = (e) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
  w.postMessage(args);
});
</script>`;

const WORKER = `import { loadPro, generatePro, tokenize, refinerInput } from '/engine/pro.js';
const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
const ort = () => import('/ort/' + self.ORT_VERSION + '/ort.webgpu.bundle.min.mjs');
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// One denoising step and one refiner pass on WebGPU and on WebAssembly, side by side.
async function compare(model) {
  const rt = await ort();
  const manifest = await (await fetch('/weights/' + model + '/manifest.json')).json();
  const meta = await (await fetch('/fixtures/' + model + '/meta.json')).json();
  const files = {};
  for (const n of ['text', 'step', 'refiner']) files[n] = await get('/weights/' + model + '/' + n + '.onnx');
  const noise = new Float32Array((await get('/fixtures/' + model + '/noise.f32')).buffer);
  const cfg = manifest.config, C = cfg.planes, R = cfg.base_resolution, L = cfg.text_length;
  const ids = new BigInt64Array(2 * L); ids.set(tokenize(meta.prompt, cfg)); ids[L] = BigInt(cfg.bos_id);
  const out = {};
  for (const backend of ['wasm', 'webgpu']) {
    const t0 = performance.now();
    const m = await loadPro(manifest, files, { forceBackend: backend });
    const enc = await m.sessions.text.run({ ids: new rt.Tensor('int64', ids, [2, L]) });
    const one = (v) => new rt.Tensor('float32', new Float32Array([v]), [1]);
    const t1 = performance.now();
    const st = await m.sessions.step.run({ x: new rt.Tensor('float32', noise, [1, C, R, R]), self_cond: new rt.Tensor('float32', new Float32Array(noise.length), [1, C, R, R]),
      t: one(1), ratio: one(0.75), guidance: one(meta.guidance), text: enc.text, mask: enc.mask, pooled: enc.pooled });
    const t2 = performance.now();
    const pic = new Uint8Array(64 * 64); for (let i = 0; i < pic.length; i++) pic[i] = (i * 7 + (i >> 6) * 3) % (C === 1 ? 2 : 6);
    const ref = await m.sessions.refiner.run({ x: new rt.Tensor('float32', refinerInput(pic, C, 64 * 64), [1, C, 64, 64]) });
    out[backend] = { ran: m.backend, pooled: enc.pooled.data.slice(), x0: st.x0.data.slice(), logits: ref.logits.data.slice(),
      loadSeconds: (t1 - t0) / 1000, stepSeconds: (t2 - t1) / 1000 };
  }
  const a = out.wasm, b = out.webgpu;
  return { ran: [a.ran, b.ran], seconds: { wasm_step: a.stepSeconds, webgpu_step: b.stepSeconds },
    max_abs: { pooled: maxDiff(a.pooled, b.pooled), x0: maxDiff(a.x0, b.x0), refiner_logits: maxDiff(a.logits, b.logits) } };
}

self.onmessage = async (e) => {
  try {
    self.ORT_VERSION = e.data.ortVersion;
    if (e.data.compare) { self.postMessage(await compare(e.data.model)); return; }
    const { model, backend, size } = e.data;
    const manifest = await (await fetch('/weights/' + model + '/manifest.json')).json();
    const meta = await (await fetch('/fixtures/' + model + '/meta.json')).json();
    const files = {};
    for (const n of ['text', 'step', 'refiner']) files[n] = await get('/weights/' + model + '/' + n + '.onnx');
    const t0 = performance.now();
    const m = await loadPro(manifest, files, { forceBackend: backend });
    const tl = performance.now();
    const noise = new Float32Array((await get('/fixtures/' + model + '/noise.f32')).buffer);
    const out = {};
    for (const s of size) {
      const t1 = performance.now();
      const r = await generatePro(m, meta.prompt, { size: s, steps: meta.steps, guidance: meta.guidance, noise });
      const want = await get('/fixtures/' + model + '/expected_' + s + '.u8');
      let same = 0;
      for (let i = 0; i < want.length; i++) same += r.pixels[i] === want[i];
      out[s] = { agreement: same / want.length, seconds: (performance.now() - t1) / 1000 };
    }
    self.postMessage({ backend: m.backend, loadSeconds: (tl - t0) / 1000, results: out });
  } catch (err) { self.postMessage({ error: String(err && err.stack || err) }); }
};`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  if (u === '/test-worker.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(WORKER); }
  for (const [prefix, dir] of ROUTES) {
    if (!u.startsWith(prefix)) continue;
    const f = path.join(dir, u.slice(prefix.length));
    if (!f.startsWith(dir) || !fs.existsSync(f)) break;
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  if (backend === 'compare') {
    const r = await page.evaluate((a) => window.run(a), { model, compare: true, ortVersion: ORT_VERSION });
    console.log(JSON.stringify(r, null, 1));
    if (r.ran[1] !== 'webgpu' || Math.max(...Object.values(r.max_abs)) > 1e-3) process.exitCode = 1;
  } else {
    const r = await page.evaluate((a) => window.run(a), { model, backend, size: [256, 512, 1024], ortVersion: ORT_VERSION });
    console.log(JSON.stringify(r, null, 1));
    const worst = Math.min(...Object.values(r.results).map((x) => x.agreement));
    if (r.backend !== backend) { console.error(`asked for ${backend}, ran on ${r.backend}`); process.exitCode = 1; }
    if (worst < 0.999) { console.error(`pictures differ from PyTorch: ${worst}`); process.exitCode = 1; }
  }
} finally {
  await browser.close();
  server.close();
}
