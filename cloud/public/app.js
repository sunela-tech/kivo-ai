// INKOS Cloud: page logic. Clerk handles sign-in and billing; the Worker
// enforces the plan; the models run in a Web Worker on this device.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));

const S = {
  app: null, clerk: null, me: null, model: null, size: null, view: 'welcome', busy: false,
  last: null, lastReq: null, loaded: new Set(), galleryItems: [], detail: null, urls: [], pricingMounted: false,
};

// Black and white only, no shadows, no motion: suitable for E-Ink.
const APPEARANCE = {
  layout: { animations: false },
  variables: {
    colorPrimary: '#000000', colorBackground: '#ffffff', colorText: '#000000', colorTextSecondary: '#000000',
    colorInputBackground: '#ffffff', colorInputText: '#000000', colorInput: '#ffffff', colorInputForeground: '#000000',
    colorForeground: '#000000', colorMutedForeground: '#000000', colorNeutral: '#000000', colorDanger: '#000000',
    colorSuccess: '#000000', colorWarning: '#000000', colorShimmer: '#ffffff', borderRadius: '0px',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', fontSize: '16px',
  },
  elements: {
    card: { boxShadow: 'none', border: '2px solid #000000' },
    cardBox: { boxShadow: 'none', border: '2px solid #000000' },
    formButtonPrimary: { boxShadow: 'none', backgroundColor: '#000000', backgroundImage: 'none', color: '#ffffff' },
    socialButtonsBlockButton: { boxShadow: 'none', border: '2px solid #000000', color: '#000000' },
    socialButtonsBlockButtonText: { color: '#000000' },
    formFieldInput: { boxShadow: 'none', border: '2px solid #000000' },
    dividerLine: { backgroundColor: '#000000' },
    footer: { background: '#ffffff', backgroundImage: 'none' },
    footerAction: { background: '#ffffff' },
    pricingTableCard: { boxShadow: 'none', border: '2px solid #000000' },
    userButtonPopoverCard: { boxShadow: 'none', border: '2px solid #000000' },
  },
};

const HINTS = {
  inkos1: 'INKOS 1 follows the patterns it was trained on: note, todo, journal, log, table, sign, bar / line / pie chart, flowchart, mind map, timeline, icon and sketch. Text after the colon is copied onto the page exactly; separate items with ";" or new lines.',
  inkos1_1: 'INKOS 1.1 understands the same patterns. Start with a colour instruction: "blue ...", "black and red ..." (text, then marks) or "colorful ...".',
  inkos1_pro: 'INKOS 1 Pro paints black-and-white manga pixel by pixel. Describe a portrait ("manga portrait, girl, long black hair, smiling"), a page of panels or a background. The first run downloads about 115 MB; a graphics processor (WebGPU) makes it much faster.',
  inkos1_1_pro: 'INKOS 1.1 Pro paints in the six E-Ink colours. Describe a portrait, panels or a background; colour words such as "red hair" or "blue uniform" steer the palette. The first run downloads about 115 MB.',
};

// ---------------------------------------------------------------------------
// plumbing

function banner(msg, upgrade = false) {
  const b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.innerHTML = esc(msg) + (upgrade ? ' <a href="#plans" data-goto="plans">See plans</a>.' : '') + ' (tap to dismiss)';
  b.hidden = false;
}
$('banner').addEventListener('click', (e) => {
  if (e.target.dataset.goto) { e.preventDefault(); show(e.target.dataset.goto); }
  banner('');
});

function setHTML(node, html) { if (node.__html !== html) { node.innerHTML = html; node.__html = html; } }

async function token(skipCache = false) {
  const t = S.clerk.session && (await S.clerk.session.getToken(skipCache ? { skipCache: true } : undefined));
  if (!t) throw new Error('Your session ended. Sign in again.');
  return t;
}

class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data || {}; } }

async function api(method, url, body, { raw = false, skipCache = false } = {}) {
  const headers = { authorization: `Bearer ${await token(skipCache)}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw && r.ok) return r;
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError((data && data.error) || `Request failed (${r.status})`, r.status, data);
  return data;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function epochsLine(t, target) {
  if (!t) return 'untrained';
  let s = `${num(t.epochs_completed || 0)} of ${num(target)} epochs`;
  if (t.epoch_progress > 0) s += ` + ${(100 * t.epoch_progress).toFixed(1)}% of the next`;
  return s;
}

// ---------------------------------------------------------------------------
// the engine, in a Web Worker

const W = { worker: null, seq: 0, pending: new Map() };
function engine(msg, onProgress) {
  if (!W.worker) {
    W.worker = new Worker('/engine/worker.js', { type: 'module' });
    W.worker.onmessage = (e) => {
      const d = e.data, p = W.pending.get(d.id);
      if (!p) return;
      if (d.type === 'progress') { if (p.onProgress) p.onProgress(d); return; }
      W.pending.delete(d.id);
      if (d.type === 'error') p.reject(new Error(d.error)); else p.resolve(d);
    };
    W.worker.onerror = (e) => { for (const p of W.pending.values()) p.reject(new Error(e.message || 'the drawing engine stopped')); W.pending.clear(); };
  }
  const id = ++W.seq;
  return new Promise((resolve, reject) => {
    W.pending.set(id, { resolve, reject, onProgress });
    W.worker.postMessage({ ...msg, id });
  });
}

// ---------------------------------------------------------------------------
// account and plan

const plan = () => S.me.plan;
const cloudModels = () => S.app.models.filter((m) => m.cloud);
const modelById = (id) => S.app.models.find((m) => m.id === id);
const currentModel = () => modelById(S.model);
const inPlan = (m) => m.cloud && plan().models.includes(m.id);

async function refreshMe(skipCache = false) {
  S.me = await api('GET', '/api/me', undefined, { skipCache });
  renderPicker();
  renderProjects();
  if (S.view === 'plans') renderPlans();
}

function renderQuota() {
  const u = S.me.usage, p = plan();
  $('quota').textContent = `${p.name} plan: ${u.images}${u.limit === null ? '' : ' of ' + u.limit} image${u.limit === 1 ? '' : 's'} today` +
    (u.limit === null ? ' (no daily limit)' : '');
}

// ---------------------------------------------------------------------------
// generate tab

function renderPicker() {
  if (!S.me) return;
  if (!S.model || !inPlan(modelById(S.model))) S.model = (cloudModels().find(inPlan) || cloudModels()[0]).id;
  const html = S.app.models.map((m) => {
    const ok = inPlan(m);
    const state = !m.cloud ? 'Python app only' : ok ? `Trained: ${epochsLine(m.training, m.target_epochs)}` : `Not in the ${plan().name} plan`;
    return `<button type="button" role="radio" aria-checked="${m.id === S.model}" data-model="${esc(m.id)}" data-locked="${!ok}" ${m.cloud ? '' : 'disabled'}>
      <span class="name">${esc(m.name)}</span><span class="what">${esc(m.specialties.slice(0, 3).join(', '))}</span>
      <span class="state">${esc(state)}</span></button>`;
  }).join('');
  setHTML($('model-picker'), html);
  renderModelDependent();
}

function renderModelDependent() {
  const m = currentModel(), p = plan();
  const maxSize = p.max_size || Infinity;
  if (!m.sizes.includes(S.size) || S.size > maxSize) S.size = Math.min(m.default_size, Math.max(...m.sizes.filter((s) => s <= maxSize)));
  setHTML($('size-picker'), m.sizes.map((s) => `<button type="button" role="radio" aria-checked="${s === S.size}" data-size="${s}"
    aria-label="${s} by ${s} pixels" ${s > maxSize ? 'disabled title="Not in your plan"' : ''}>${s} px</button>`).join(''));
  setHTML($('examples'), m.examples.slice(0, 8).map((x) => `<button type="button" data-example="${esc(x)}" title="${esc(x)}">${esc(x)}</button>`).join(''));
  $('prompt-hint').textContent = HINTS[m.id] || '';
  $('temperature').placeholder = (m.sample && m.sample.temperature) ?? 0.7;
  document.querySelectorAll('[data-engine]').forEach((el) => { el.hidden = el.dataset.engine !== m.engine; });
  if (m.engine === 'pro') $('guidance').placeholder = m.sample.guidance;
  const u = S.me.usage, spent = u.limit !== null && u.remaining <= 0;
  $('generate').disabled = S.busy || spent;
  $('generate').textContent = spent ? 'Daily limit reached' : S.busy ? 'Generating ...' : 'Generate';
  renderQuota();
}

$('model-picker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-model]');
  if (!b || b.disabled) return;
  if (b.dataset.locked === 'true') { show('plans'); return; }
  S.model = b.dataset.model;
  S.size = null;
  renderPicker();
});
$('size-picker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (!b || b.disabled) return;
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
  const steps = Number(over.steps || $('steps').value) || m.sample.preview_steps || 16;
  const gIn = over.guidance !== undefined ? over.guidance : $('guidance').value;
  const guidance = gIn !== '' && gIn !== null && Number.isFinite(Number(gIn)) ? Math.min(8, Math.max(1, Number(gIn))) : m.sample.guidance;
  const project = $('project').value || 'default';
  S.lastReq = { model: m.id, prompt, size, temperature, steps, guidance };
  setBusy(true);
  try {
    if (!S.loaded.has(m.id)) {
      const r = await engine({ type: 'load', model: m.id, engine: m.engine, token: await token() }, showProgress);
      if (r.info && r.info.backend) S.backend = r.info.backend;
      S.loaded.add(m.id);
    }
    showProgress({ stage: 'checking your plan', fraction: 0 });
    const ticket = await api('POST', '/api/generations', { model: m.id, size });
    S.me.usage = ticket.usage;
    const r = await engine(m.engine === 'pro' ? { type: 'generate', model: m.id, prompt, size, seed, steps, guidance }
      : { type: 'generate', model: m.id, prompt, size, seed, temperature, topP: m.sample.top_p }, showProgress);
    showProgress({ stage: 'saving to your gallery', fraction: 1 });
    const saved = await api('POST', '/api/gallery', { project, png: b64(r.png), meta: r.meta });
    showResult(r.png, { ...r.meta, project, id: saved.id, bytes: r.png.length });
    showProgress({ stage: 'done', fraction: 1 });
  } catch (e) {
    $('progress').hidden = true;
    banner(e.message, !!(e.data && e.data.upgrade));
    if (e.status === 401) S.clerk.openSignIn && S.clerk.openSignIn();
  } finally {
    setBusy(false);
  }
}

function factsHTML(meta) {
  const w = meta.weights || {};
  const rows = [['Model', meta.model_name], ['Prompt', meta.prompt],
    ['Size', `${meta.size} x ${meta.size} px, ${meta.colors ? '6 colours' : '1 bit'}`], ['Seed', meta.seed]];
  if (meta.tokens !== undefined && meta.tokens !== null) {
    rows.push(['Program', `${meta.tokens} tokens${meta.program ? ', ' + meta.program.ops + ' commands' : ''}${meta.complete ? '' : ' (cut off at the token limit)'}`]);
  }
  if (meta.temperature !== undefined && meta.temperature !== null) rows.push(['Temperature', meta.temperature]);
  if (meta.steps) rows.push(['Denoising', `${meta.steps} steps, guidance ${meta.guidance}`]);
  if (meta.seconds) rows.push(['Time', `${meta.seconds} s on this device${meta.backend ? (meta.backend === 'webgpu' ? ' (graphics processor, WebGPU)' : ' (processor, WebAssembly)') : ''}`]);
  if (meta.colors) {
    rows.push(['Colours', Object.entries(meta.colors).filter(([k, v]) => k !== 'white' && v > 0).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(', ') || 'none']);
  } else if (meta.ink) rows.push(['Ink', `${(100 * (meta.ink.black || 0)).toFixed(1)}% black`]);
  if (meta.bytes) rows.push(['File', `${Math.max(1, Math.round(meta.bytes / 1024))} KB PNG`]);
  if (meta.project) rows.push(['Project', meta.project]);
  const target = w.target_epochs || (modelById(meta.model) || {}).target_epochs;
  rows.push(['Weights', epochsLine(w, target)]);
  if (meta.created_at) rows.push(['Created', meta.created_at.replace('T', ' ').slice(0, 19) + ' UTC']);
  return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

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
  const m = modelById(meta.model);
  const t = m && m.training;
  const note = t && t.epochs_completed < m.target_epochs
    ? `These weights have completed ${epochsLine(t, m.target_epochs)} of training (${num(t.samples_seen)} samples seen). Expect rough results until the model is trained further.` : '';
  $('result-notice').hidden = !note;
  $('result-notice').textContent = note;
  $('download').href = url;
  $('download').setAttribute('download', `inkos-${meta.model}-${meta.seed}.png`);
}

$('gen-form').addEventListener('submit', (e) => { e.preventDefault(); generate(); });
$('regenerate').addEventListener('click', () => { if (S.lastReq) generate({ ...S.lastReq, seed: '' }); });
$('same-seed').addEventListener('click', () => { if (S.last) generate({ ...S.lastReq, seed: S.last.seed }); });

// ---------------------------------------------------------------------------
// projects and gallery

function renderProjects() {
  const opts = S.me.projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  for (const id of ['project', 'gallery-project']) {
    const sel = $(id), keep = sel.value;
    setHTML(sel, opts);
    sel.value = S.me.projects.includes(keep) ? keep : 'default';
  }
}

$('add-project').addEventListener('click', async () => {
  const name = $('new-project').value.trim();
  if (!name) return;
  try {
    const r = await api('POST', '/api/projects', { name });
    S.me.projects = r.projects;
    renderProjects();
    $('project').value = name;
    $('new-project').value = '';
  } catch (e) { banner(e.message, !!(e.data && e.data.upgrade)); }
});

async function loadGallery() {
  const project = $('gallery-project').value || 'default';
  let data;
  try { data = await api('GET', `/api/gallery?project=${encodeURIComponent(project)}`); } catch (e) { banner(e.message); return; }
  for (const it of S.galleryItems) if (it.url) URL.revokeObjectURL(it.url);
  S.galleryItems = data.images;
  $('gallery-count').textContent = `${data.images.length} image${data.images.length === 1 ? '' : 's'} in ${project}`;
  $('gallery-empty').hidden = data.images.length > 0;
  setHTML($('thumbs'), data.images.map((it, i) => `<button type="button" data-i="${i}" title="${esc(it.meta.prompt)}"><img alt="${esc(it.meta.prompt)}" data-thumb="${i}"></button>`).join(''));
  if (S.detail && !data.images.some((x) => x.id === S.detail)) closeDetail();
  for (const [i, it] of data.images.slice(0, 60).entries()) {       // fetched with the session token, a few at a time
    try {
      const r = await api('GET', `/api/gallery/${it.id}`, undefined, { raw: true });
      it.url = URL.createObjectURL(await r.blob());
      const img = document.querySelector(`[data-thumb="${i}"]`);
      if (img) img.src = it.url;
    } catch { /* skip a broken thumbnail */ }
  }
}

function openDetail(i) {
  const it = S.galleryItems[i];
  if (!it) return;
  S.detail = it.id;
  $('detail').hidden = false;
  $('detail-img').src = it.url || '';
  $('detail-img').alt = it.meta.prompt;
  setHTML($('detail-facts'), factsHTML({ ...it.meta, created_at: it.created_at, project: it.project }));
  $('detail-download').href = it.url || '#';
  $('detail-download').setAttribute('download', `inkos-${it.id}.png`);
  $('detail').scrollIntoView({ block: 'nearest' });
}
function closeDetail() { S.detail = null; $('detail').hidden = true; }

$('thumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) openDetail(Number(b.dataset.i)); });
$('gallery-project').addEventListener('change', () => { closeDetail(); loadGallery(); });
$('gallery-refresh').addEventListener('click', loadGallery);
$('detail-close').addEventListener('click', closeDetail);
$('detail-delete').addEventListener('click', async () => {
  if (!S.detail || !window.confirm('Delete this image from your gallery?')) return;
  try { await api('DELETE', `/api/gallery/${S.detail}`); closeDetail(); loadGallery(); } catch (e) { banner(e.message); }
});
$('detail-reuse').addEventListener('click', () => {
  const it = S.galleryItems.find((x) => x.id === S.detail);
  if (!it) return;
  const m = modelById(it.meta.model);
  if (m && inPlan(m)) S.model = m.id;
  S.size = it.meta.size;
  $('prompt').value = it.meta.prompt;
  $('seed').value = it.meta.seed ?? '';
  renderPicker();
  show('generate');
});

// ---------------------------------------------------------------------------
// models and plans

function renderModels() {
  const pal = S.app.palette;
  setHTML($('model-cards'), S.app.models.map((m) => {
    const ok = inPlan(m), t = m.training;
    const avail = !m.cloud ? 'Python app only' : ok ? 'in your plan' : 'not in your plan';
    return `<article class="card">
      <header><div><h2>${esc(m.name)}</h2><p>${esc(m.summary)}</p></div><span class="badge ${ok ? 'on' : ''}">${avail}</span></header>
      ${m.cloud ? `<section><h3>Training completed</h3>
        <div class="big"><b>${num(t.epochs_completed)}</b><span>of ${num(m.target_epochs)} target epochs</span></div>
        <p class="sub">${t.epoch_progress > 0 ? (100 * t.epoch_progress).toFixed(1) + '% of the next epoch, ' : ''}${num(t.samples_seen)} samples seen${t.initialised_from ? `, started from ${esc(t.initialised_from.name)}` : ''}</p></section>
      <section><table>
        <tr><th>Parameters</th><td class="num">${(m.params / 1e6).toFixed(2)} million</td></tr>
        <tr><th>Download</th><td class="num">${(m.weights_bytes / 1e6).toFixed(1)} MB, once per device</td></tr>
        <tr><th>Runs on</th><td class="num">${m.engine === 'pro' ? 'onnxruntime-web: WebGPU, else WebAssembly' : 'JavaScript, any browser'}</td></tr>
        <tr><th>Sizes</th><td class="num">${m.sizes.join(', ')} px</td></tr></table></section>`
        : `<section><p>These weights are not installed on the server yet. The model runs in the INKOS Python app.</p></section>`}
      <section><h3>Built for</h3><div class="tags">${m.specialties.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
        ${m.palette ? `<div class="swatches" aria-label="Output palette">${pal.names.map((n, i) => `<span><i style="background:rgb(${pal.rgb[i].join(',')})"></i>${esc(n)}</span>`).join('')}</div>`
          : '<p class="sub">Output: black and white, 1 bit per pixel.</p>'}</section>
    </article>`;
  }).join(''));
}

function renderPlans() {
  const u = S.me.usage;
  $('plan-usage').textContent = `Used today: ${u.images}${u.limit === null ? ' (no daily limit)' : ' of ' + u.limit + ' images'}`;
  const names = (ids) => ids.map((id) => modelById(id).name).join(', ');
  setHTML($('plan-limits'), `<thead><tr><th>Plan</th><th>Models</th><th>Largest size</th><th>Images per day</th><th>Projects</th></tr></thead><tbody>` +
    S.app.plans.map((p) => `<tr class="${p.id === plan().id ? 'current' : ''}"><th>${esc(p.name)}${p.id === plan().id ? ' (yours)' : ''}</th>
      <td>${esc(names(p.models))}</td><td>${p.max_size} px</td><td>${p.images_per_day === null ? 'unlimited' : num(p.images_per_day)}</td>
      <td>${p.projects === null ? 'unlimited' : num(p.projects)}</td></tr>`).join('') + '</tbody>');
  if (!S.pricingMounted && S.clerk.mountPricingTable) {
    S.clerk.mountPricingTable($('pricing'), { appearance: APPEARANCE });
    S.pricingMounted = true;
  }
}

// ---------------------------------------------------------------------------
// views

function show(view) {
  S.view = view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  if (view === 'gallery') loadGallery();
  if (view === 'models') renderModels();
  if (view === 'plans') { renderPlans(); refreshMe(true).catch(() => {}); }
  if (view === 'generate') refreshMe(true).catch(() => {});
  try { history.replaceState(null, '', `#${view}`); } catch { /* ignore */ }
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) show(b.dataset.view); });

async function showApp() {
  $('tabs').hidden = false;
  if (S.clerk.mountUserButton && !$('account').childElementCount) S.clerk.mountUserButton($('account'), { appearance: APPEARANCE });
  await refreshMe(true);
  const want = (location.hash || '').slice(1);
  show(['generate', 'gallery', 'models', 'plans'].includes(want) ? want : 'generate');
}

function showWelcome() {
  $('tabs').hidden = true;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-welcome'; });
  $('welcome-status').textContent = '';
  if (!$('sign-in').childElementCount) S.clerk.mountSignIn($('sign-in'), { appearance: APPEARANCE });
}

function script(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    Object.assign(s.dataset, attrs);
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the sign-in service.'));
    document.head.appendChild(s);
  });
}

// Clerk JS v6 ships its widgets (sign-in, user button, pricing table) as a
// separate bundle, @clerk/ui, which registers window.__internal_ClerkUICtor.
async function loadClerk(cfg) {
  if (window.__INKOS_TEST_CLERK__) return window.__INKOS_TEST_CLERK__;      // automated tests only
  await Promise.all([
    script(`${cfg.frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
    script(`${cfg.frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { clerkPublishableKey: cfg.publishableKey }),
  ]);
  return window.Clerk;
}

(async function boot() {
  try {
    const [app, cfg] = await Promise.all([fetch('/data/app.json').then((r) => r.json()), fetch('/api/config').then((r) => r.json())]);
    S.app = app;
    S.clerk = await loadClerk(cfg);
    await S.clerk.load({ appearance: APPEARANCE, ui: window.__internal_ClerkUICtor ? { ClerkUI: window.__internal_ClerkUICtor } : undefined });
    let signedIn = !!S.clerk.user;
    S.clerk.addListener(({ user }) => {
      if (!!user !== signedIn) { signedIn = !!user; if (user) showApp(); else showWelcome(); }
      else if (user && S.me) refreshMe(true).catch(() => {});     // plan changes arrive as session updates
    });
    if (signedIn) await showApp(); else showWelcome();
  } catch (e) {
    $('welcome-status').textContent = e.message;
    banner(e.message);
  }
})();
