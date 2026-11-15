// INKOS Desktop: one HTML file that runs INKOS 1 and INKOS 1.1 offline.
// Everything it needs (engine, font, weights) is inside the file; the gallery
// is kept in this browser's IndexedDB. Nothing is sent anywhere.

import { createEngine } from './engine-core.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const DATA = JSON.parse($('inkos-data').textContent);
const APP = DATA.app;

const S = { model: null, size: null, view: 'generate', busy: false, last: null, lastReq: null, loaded: new Set(),
  projects: ['default'], galleryItems: [], detail: null, urls: [] };

const HINTS = {
  inkos1: 'INKOS 1 follows the patterns it was trained on: note, todo, journal, log, table, sign, bar / line / pie chart, flowchart, mind map, timeline, icon and sketch. Text after the colon is copied onto the page exactly; separate items with ";" or new lines.',
  inkos1_1: 'INKOS 1.1 understands the same patterns. Start with a colour instruction: "blue ...", "black and red ..." (text, then marks) or "colorful ...".',
};

function banner(msg) {
  const b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg + '  (tap to dismiss)';
  b.hidden = false;
}
$('banner').addEventListener('click', () => banner(''));
function setHTML(node, html) { if (node.__html !== html) { node.innerHTML = html; node.__html = html; } }
function epochsLine(t, target) {
  if (!t) return 'untrained';
  let s = `${num(t.epochs_completed || 0)} of ${num(target)} epochs`;
  if (t.epoch_progress > 0) s += ` + ${(100 * t.epoch_progress).toFixed(1)}% of the next`;
  return s;
}
const modelById = (id) => APP.models.find((m) => m.id === id);
const cloudModels = () => APP.models.filter((m) => m.cloud);
const currentModel = () => modelById(S.model);

// ---------------------------------------------------------------------------
// storage: IndexedDB, or memory if this browser blocks it for local files

const store = (() => {
  let dbp = null;
  const mem = { images: [], projects: [] };
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open('inkos-desktop', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            const im = db.createObjectStore('images', { keyPath: 'id' });
            im.createIndex('project', 'project');
            db.createObjectStore('projects', { keyPath: 'name' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbp;
  };
  const tx = async (name, mode, fn) => {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const t = db.transaction(name, mode), os = t.objectStore(name);
      let out;
      Promise.resolve(fn(os)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  };
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    async persistent() { return !!(await open()); },
    async addImage(rec) { return tx('images', 'readwrite', (os) => (os ? req(os.put(rec)) : mem.images.push(rec))); },
    async images(project) {
      const all = await tx('images', 'readonly', (os) => (os ? req(os.index('project').getAll(project)) : mem.images.filter((r) => r.project === project)));
      return all.sort((a, b) => (a.created < b.created ? 1 : -1));
    },
    async deleteImage(id) { return tx('images', 'readwrite', (os) => (os ? req(os.delete(id)) : (mem.images = mem.images.filter((r) => r.id !== id)))); },
    async projects() { return tx('projects', 'readonly', (os) => (os ? req(os.getAllKeys()) : mem.projects.slice())); },
    async addProject(name) { return tx('projects', 'readwrite', (os) => (os ? req(os.put({ name, created: new Date().toISOString() })) : mem.projects.push(name))); },
  };
})();

// ---------------------------------------------------------------------------
// the engine: a Web Worker from a Blob URL, or the page itself as a fallback

const E = { post: null, seq: 0, pending: new Map(), mode: '' };
function onEngineMessage(d) {
  const p = E.pending.get(d.id);
  if (!p) return;
  if (d.type === 'progress') { if (p.onProgress) p.onProgress(d); return; }
  E.pending.delete(d.id);
  if (d.type === 'error') p.reject(new Error(d.error)); else p.resolve(d);
}
function startEngine() {
  try {
    const src = $('engine-worker-src').textContent;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => onEngineMessage(e.data);
    w.onerror = (e) => {
      e.preventDefault();
      if (E.mode === 'worker' && !E.pending.size) { inPage(); return; }
      for (const p of E.pending.values()) p.reject(new Error(e.message || 'the drawing engine stopped'));
      E.pending.clear();
    };
    E.post = (msg, transfer) => w.postMessage(msg, transfer || []);
    E.mode = 'worker';
  } catch {
    inPage();
  }
}
function inPage() {
  const eng = createEngine((msg) => setTimeout(() => onEngineMessage(msg), 0));
  E.post = (msg) => eng.handle(msg);
  E.mode = 'page';
}
function engine(msg, onProgress, transfer) {
  const id = ++E.seq;
  return new Promise((resolve, reject) => {
    E.pending.set(id, { resolve, reject, onProgress });
    E.post({ ...msg, id }, transfer);
  });
}

async function weightsBuffer(id) {
  const b64 = $(`weights-${id}`).textContent.trim();
  const r = await fetch(`data:application/octet-stream;base64,${b64}`);     // fast base64 decode
  return r.arrayBuffer();
}

async function ensureModel(m, onProgress) {
  if (S.loaded.has(m.id)) return;
  onProgress({ stage: `unpacking ${m.name}`, fraction: 0.02, detail: `${(m.weights_bytes / 1e6).toFixed(1)} MB` });
  const index = JSON.parse($(`index-${m.id}`).textContent);
  const buffer = await weightsBuffer(m.id);
  await engine({ type: 'load', model: m.id, index, buffer }, onProgress, [buffer]);
  S.loaded.add(m.id);
}

// ---------------------------------------------------------------------------
// generate tab

function renderPicker() {
  if (!S.model) S.model = cloudModels()[0].id;
  setHTML($('model-picker'), APP.models.map((m) => {
    const state = m.cloud ? `Trained: ${epochsLine(m.training, m.target_epochs)}` : 'Needs the INKOS Python app';
    return `<button type="button" role="radio" aria-checked="${m.id === S.model}" data-model="${esc(m.id)}" data-locked="${!m.cloud}" ${m.cloud ? '' : 'disabled'}>
      <span class="name">${esc(m.name)}</span><span class="what">${esc(m.specialties.slice(0, 3).join(', '))}</span>
      <span class="state">${esc(state)}</span></button>`;
  }).join(''));
  renderModelDependent();
}

function renderModelDependent() {
  const m = currentModel();
  if (!m.sizes.includes(S.size)) S.size = m.default_size;
  setHTML($('size-picker'), m.sizes.map((s) => `<button type="button" role="radio" aria-checked="${s === S.size}" data-size="${s}" aria-label="${s} by ${s} pixels">${s} px</button>`).join(''));
  setHTML($('examples'), m.examples.slice(0, 8).map((x) => `<button type="button" data-example="${esc(x)}" title="${esc(x)}">${esc(x)}</button>`).join(''));
  $('prompt-hint').textContent = HINTS[m.id] || '';
  $('temperature').placeholder = m.sample.temperature;
  $('generate').disabled = S.busy;
  $('generate').textContent = S.busy ? 'Generating ...' : 'Generate';
}

$('model-picker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-model]');
  if (!b || b.disabled) return;
  S.model = b.dataset.model;
  S.size = null;
  renderPicker();
});
$('size-picker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  S.size = Number(b.dataset.size);
  renderModelDependent();
});
$('examples').addEventListener('click', (e) => {
  const b = e.target.closest('[data-example]');
  if (b) { $('prompt').value = b.dataset.example; $('prompt').focus(); }
});

function showProgress(p) {
  $('progress').hidden = false;
  const pct = Math.round(100 * Math.min(1, Math.max(0, p.fraction || 0)));
  $('progress-fill').style.width = pct + '%';
  $('progress-bar').setAttribute('aria-valuenow', String(pct));
  $('progress-text').textContent = `${p.stage || 'working'}${p.detail ? ' - ' + p.detail : ''}  ${pct}%`;
}
function setBusy(b) { S.busy = b; renderModelDependent(); }

async function generate(over = {}) {
  const m = over.model ? modelById(over.model) : currentModel();
  if (!m || S.busy) return;
  const prompt = (over.prompt ?? $('prompt').value).trim();
  if (!prompt) { banner('Write a prompt first.'); return; }
  banner('');
  const size = over.size || S.size;
  const seedIn = over.seed !== undefined ? over.seed : $('seed').value;
  const seed = seedIn !== '' && seedIn !== null ? Number(seedIn) >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
  const tIn = over.temperature !== undefined ? over.temperature : $('temperature').value;
  const temperature = tIn !== '' && tIn !== null ? Math.min(2, Math.max(0, Number(tIn))) : m.sample.temperature;
  const project = $('project').value || 'default';
  S.lastReq = { model: m.id, prompt, size, temperature };
  setBusy(true);
  try {
    await ensureModel(m, showProgress);
    const r = await engine({ type: 'generate', model: m.id, prompt, size, seed, temperature, topP: m.sample.top_p }, showProgress);
    const meta = { ...r.meta, project, bytes: r.png.length, created: new Date().toISOString() };
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    await store.addImage({ id, project, created: meta.created, meta, png: new Blob([r.png], { type: 'image/png' }) });
    showResult(r.png, { ...meta, id });
    showProgress({ stage: 'done', fraction: 1 });
  } catch (e) {
    $('progress').hidden = true;
    banner(e.message);
  } finally {
    setBusy(false);
  }
}

function factsHTML(meta) {
  const w = meta.weights || {};
  const rows = [['Model', meta.model_name], ['Prompt', meta.prompt],
    ['Size', `${meta.size} x ${meta.size} px, ${meta.colors ? '6 colours' : '1 bit'}`], ['Seed', meta.seed],
    ['Program', `${meta.tokens} tokens${meta.program ? ', ' + meta.program.ops + ' commands' : ''}${meta.complete ? '' : ' (cut off at the token limit)'}`],
    ['Temperature', meta.temperature], ['Time', `${meta.seconds} s`]];
  if (meta.colors) {
    rows.push(['Colours', Object.entries(meta.colors).filter(([k, v]) => k !== 'white' && v > 0).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(', ') || 'none']);
  } else if (meta.ink) rows.push(['Ink', `${(100 * (meta.ink.black || 0)).toFixed(1)}% black`]);
  if (meta.bytes) rows.push(['File', `${Math.max(1, Math.round(meta.bytes / 1024))} KB PNG`]);
  rows.push(['Project', meta.project]);
  const target = (modelById(meta.model) || {}).target_epochs;
  rows.push(['Weights', epochsLine(w, target)]);
  if (meta.created) rows.push(['Created', new Date(meta.created).toLocaleString()]);
  return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function fileName(meta) { return `inkos-${meta.model}-${meta.seed}.png`; }

function showResult(png, meta) {
  for (const u of S.urls.splice(0)) URL.revokeObjectURL(u);
  const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  S.urls.push(url);
  S.last = meta;
  const img = $('result-img');
  img.src = url;
  img.alt = `Generated image for: ${meta.prompt}`;
  img.hidden = false;
  $('frame-empty').hidden = true;
  $('result-info').hidden = false;
  setHTML($('result-facts'), factsHTML(meta));
  const m = modelById(meta.model), t = m.training;
  const note = t && t.epochs_completed < m.target_epochs
    ? `These weights have completed ${epochsLine(t, m.target_epochs)} of training (${num(t.samples_seen)} samples seen). Expect rough results until the model is trained further.` : '';
  $('result-notice').hidden = !note;
  $('result-notice').textContent = note;
  $('download').href = url;
  $('download').setAttribute('download', fileName(meta));
}

$('gen-form').addEventListener('submit', (e) => { e.preventDefault(); generate(); });
$('regenerate').addEventListener('click', () => { if (S.lastReq) generate({ ...S.lastReq, seed: '' }); });
$('same-seed').addEventListener('click', () => { if (S.last) generate({ ...S.lastReq, seed: S.last.seed }); });

// ---------------------------------------------------------------------------
// projects and gallery

async function loadProjects() {
  const extra = (await store.projects()).filter((p) => p !== 'default').sort();
  S.projects = ['default', ...extra];
  const opts = S.projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  for (const id of ['project', 'gallery-project']) {
    const sel = $(id), keep = sel.value;
    setHTML(sel, opts);
    sel.value = S.projects.includes(keep) ? keep : 'default';
  }
}

$('add-project').addEventListener('click', async () => {
  const name = $('new-project').value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(name)) { banner("Project names use letters, digits, space, '-' and '_' (max 40)."); return; }
  await store.addProject(name);
  await loadProjects();
  $('project').value = name;
  $('new-project').value = '';
});

async function loadGallery() {
  const project = $('gallery-project').value || 'default';
  for (const it of S.galleryItems) if (it.url) URL.revokeObjectURL(it.url);
  const items = await store.images(project);
  for (const it of items) it.url = URL.createObjectURL(it.png);
  S.galleryItems = items;
  $('gallery-count').textContent = `${items.length} image${items.length === 1 ? '' : 's'} in ${project}`;
  $('gallery-empty').hidden = items.length > 0;
  setHTML($('thumbs'), items.map((it, i) => `<button type="button" data-i="${i}" title="${esc(it.meta.prompt)}"><img alt="${esc(it.meta.prompt)}" src="${it.url}"></button>`).join(''));
  if (S.detail && !items.some((x) => x.id === S.detail)) closeDetail();
}
function openDetail(i) {
  const it = S.galleryItems[i];
  if (!it) return;
  S.detail = it.id;
  $('detail').hidden = false;
  $('detail-img').src = it.url;
  $('detail-img').alt = it.meta.prompt;
  setHTML($('detail-facts'), factsHTML(it.meta));
  $('detail-download').href = it.url;
  $('detail-download').setAttribute('download', fileName(it.meta));
  $('detail').scrollIntoView({ block: 'nearest' });
}
function closeDetail() { S.detail = null; $('detail').hidden = true; }

$('thumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) openDetail(Number(b.dataset.i)); });
$('gallery-project').addEventListener('change', () => { closeDetail(); loadGallery(); });
$('detail-close').addEventListener('click', closeDetail);
$('detail-delete').addEventListener('click', async () => {
  if (!S.detail || !window.confirm('Delete this image?')) return;
  await store.deleteImage(S.detail);
  closeDetail();
  loadGallery();
});
$('detail-reuse').addEventListener('click', () => {
  const it = S.galleryItems.find((x) => x.id === S.detail);
  if (!it) return;
  S.model = it.meta.model;
  S.size = it.meta.size;
  $('prompt').value = it.meta.prompt;
  $('seed').value = it.meta.seed ?? '';
  renderPicker();
  show('generate');
});

// ---------------------------------------------------------------------------
// models

function renderModels() {
  const pal = APP.palette;
  setHTML($('model-cards'), APP.models.map((m) => {
    const t = m.training;
    return `<article class="card">
      <header><div><h2>${esc(m.name)}</h2><p>${esc(m.summary)}</p></div><span class="badge ${m.cloud ? 'on' : ''}">${m.cloud ? 'included' : 'not included'}</span></header>
      ${m.cloud ? `<section><h3>Training completed</h3>
        <div class="big"><b>${num(t.epochs_completed)}</b><span>of ${num(m.target_epochs)} target epochs</span></div>
        <p class="sub">${t.epoch_progress > 0 ? (100 * t.epoch_progress).toFixed(1) + '% of the next epoch, ' : ''}${num(t.samples_seen)} samples seen${t.initialised_from ? `, started from ${esc(t.initialised_from.name)}` : ''}</p></section>
      <section><table>
        <tr><th>Parameters</th><td class="num">${(m.params / 1e6).toFixed(2)} million</td></tr>
        <tr><th>Weights</th><td class="num">${(m.weights_bytes / 1e6).toFixed(1)} MB, inside this file</td></tr>
        <tr><th>Sizes</th><td class="num">${m.sizes.join(', ')} px</td></tr></table></section>`
        : `<section><p>Not included in this file: it is far too heavy to run in a browser and has not been trained yet. It is part of the INKOS Python project.</p></section>`}
      <section><h3>Built for</h3><div class="tags">${m.specialties.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
        ${m.palette ? `<div class="swatches" aria-label="Output palette">${pal.names.map((n, i) => `<span><i style="background:rgb(${pal.rgb[i].join(',')})"></i>${esc(n)}</span>`).join('')}</div>`
          : '<p class="sub">Output: black and white, 1 bit per pixel.</p>'}</section>
    </article>`;
  }).join(''));
}

// ---------------------------------------------------------------------------
// views and start-up

function show(view) {
  S.view = view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  if (view === 'gallery') loadGallery();
  if (view === 'models') renderModels();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) show(b.dataset.view); });

(async function boot() {
  startEngine();
  await engine({ type: 'init', font: DATA.font });
  renderPicker();
  await loadProjects();
  const persistent = await store.persistent();
  $('foot').textContent = `INKOS Desktop ${DATA.version} | engine: ${E.mode === 'worker' ? 'background worker' : 'in page'} | ` +
    (persistent ? 'gallery saved in this browser' : 'this browser does not allow storage for local files: the gallery lasts until you close the page');
  show('generate');
})().catch((e) => banner(e.message));
