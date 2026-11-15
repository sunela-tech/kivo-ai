/* INKOS interface logic. No dependencies, no network access beyond the local server. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
  const fix = (n, d = 3) => (n === null || n === undefined ? '-' : Number(n).toFixed(d));

  const S = {
    status: null, model: null, size: null, view: 'generate', busy: false, last: null, lastRequest: null,
    galleryProject: 'default', galleryItems: [], detail: null, timer: null,
  };

  const HINTS = {
    'inkscript-transformer':
      '{name} follows the patterns it was trained on: note, todo, journal, log, table, sign, bar / line / pie chart, ' +
      'flowchart, mind map, timeline, icon and sketch. Text after the colon is copied onto the page exactly; separate items with ";" or new lines.',
    'bit-diffusion-unet':
      '{name} reads comma-separated tags: kind of picture, subject, hair, expression, outfit, background.',
  };
  const COLOR_HINTS = {
    'inkscript-transformer': ' Start with a colour instruction: "blue ...", "black and red ..." (text, then marks) or "colorful ...".',
    'bit-diffusion-unet': ' Begin with "color" and name colours in the tags: "red hair", "blue eyes", "blue sky".',
  };

  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (method !== 'GET') {
      opt.headers['X-Inkos'] = '1';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body || {});
    }
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
    return data;
  }

  /* Only touch the DOM when something changed: fewer repaints on E-Ink. */
  function setHTML(node, html) {
    if (node.__html !== html) { node.innerHTML = html; node.__html = html; }
  }
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function banner(msg) {
    const b = $('banner');
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg + '  (tap to dismiss)';
    b.hidden = false;
  }
  $('banner').addEventListener('click', () => banner(''));

  function duration(sec) {
    if (sec === null || sec === undefined) return '-';
    const units = [['years', 31536000], ['days', 86400], ['hours', 3600], ['minutes', 60]];
    for (const [name, n] of units) if (sec >= n) return `${(sec / n).toFixed(1)} ${name}`;
    return `${Math.round(sec)} seconds`;
  }
  function bytes(n) {
    if (!n && n !== 0) return '-';
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }
  function epochsLine(t, target) {
    let s = `${num(t.epochs_completed || 0)} of ${num(target)} epochs`;
    if (t.epoch_progress > 0) s += ` + ${(100 * t.epoch_progress).toFixed(1)}% of the next`;
    return s;
  }
  const modelById = (id) => (S.status ? S.status.models.find((m) => m.id === id) : null);
  const currentModel = () => modelById(S.model);
  const currentPlan = () => S.status.plan.plans.find((p) => p.id === S.status.plan.current);

  /* ------------------------------------------------------------------ status */
  async function loadStatus() {
    try {
      S.status = await api('GET', '/api/status');
    } catch (e) {
      setText($('foot-server'), 'Local server not reachable. Start it with:  python -m inkos serve');
      banner(e.message);
      return;
    }
    const st = S.status;
    if (!S.model || !modelById(S.model)) S.model = (st.models.find((m) => m.in_plan && m.weights) || st.models[0]).id;
    const hw = st.hardware;
    const gpu = hw.cuda ? `${hw.cuda.name}, ${hw.cuda.vram_gb} GB` : hw.mps ? 'Apple GPU' : 'CPU only';
    setText($('foot-server'), `INKOS ${st.server.version}  |  inference on ${st.server.device}  |  ${gpu}  |  PyTorch ${hw.torch}`);
    renderPicker();
    if (S.view === 'models') renderModels();
    if (S.view === 'plans') renderPlans();
  }

  /* ---------------------------------------------------------------- generate */
  function renderPicker() {
    const plan = currentPlan();
    const html = S.status.models.map((m) => {
      const w = m.weights;
      let state = w ? `Trained: ${epochsLine(w, m.training.target_epochs)}` : 'No trained weights yet';
      if (!m.in_plan) state = `Not in the ${plan.name} plan`;
      return `<button type="button" role="radio" aria-checked="${m.id === S.model}" data-model="${esc(m.id)}" data-locked="${!m.in_plan}">
        <span class="name">${esc(m.name)}</span><span class="what">${esc(m.specialties.slice(0, 3).join(', '))}</span>
        <span class="state">${esc(state)}</span></button>`;
    }).join('');
    setHTML($('model-picker'), html);
    renderModelDependent();
  }

  function renderModelDependent() {
    const m = currentModel();
    if (!m) return;
    const plan = currentPlan();
    const maxSize = plan.max_size || Infinity;
    if (!m.sizes.includes(S.size) || S.size > maxSize) S.size = Math.min(m.default_size, Math.max(...m.sizes.filter((s) => s <= maxSize), m.sizes[0]));
    setHTML($('size-picker'), m.sizes.map((s) =>
      `<button type="button" role="radio" aria-checked="${s === S.size}" data-size="${s}" aria-label="${s} by ${s} pixels" ${s > maxSize ? 'disabled title="Not in your plan"' : ''}>${s} px</button>`).join(''));
    setHTML($('examples'), m.examples.slice(0, 8).map((p) => `<button type="button" data-example="${esc(p)}" title="${esc(p)}">${esc(p)}</button>`).join(''));
    setText($('prompt-hint'), (HINTS[m.architecture] || '').replace('{name}', m.name) +
      (m.palette ? COLOR_HINTS[m.architecture] || '' : ''));
    $('prompt').maxLength = 2000;
    document.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== m.architecture; });
    const d = m.sample_defaults || {};
    $('temperature').placeholder = d.temperature ?? '';
    $('steps').placeholder = d.steps ?? '';
    $('guidance').placeholder = d.guidance ?? '';
    const u = S.status.plan.usage;
    const spent = u.limit !== null && u.remaining <= 0;
    const ok = !!m.weights && m.in_plan && !spent;
    $('generate').disabled = !ok || S.busy;
    $('generate').textContent = !m.in_plan ? 'Not in your plan' : !m.weights ? 'No trained weights' : spent ? 'Daily limit reached'
      : (S.busy ? 'Generating ...' : 'Generate');
    setText($('quota'), `${plan.name} plan: ${u.images}${u.limit === null ? '' : ' of ' + u.limit} image${u.limit === 1 ? '' : 's'} today` +
      (u.limit === null ? ' (no daily limit)' : '') + (m.in_plan ? '' : `. ${m.name} needs another plan: see the Plans tab.`));
  }

  $('model-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]');
    if (!b) return;
    if (b.dataset.locked === 'true') { show('plans'); return; }
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
    setText($('progress-text'), `${p.stage || 'working'}${p.detail ? ' - ' + p.detail : ''}  ${pct}%`);
  }

  function setBusy(b) {
    S.busy = b;
    renderModelDependent();
  }

  async function generate(overrides = {}) {
    const m = currentModel();
    if (!m || S.busy) return;
    const prompt = (overrides.prompt ?? $('prompt').value).trim();
    if (!prompt) { banner('Write a prompt first.'); return; }
    banner('');
    const body = { model: overrides.model || m.id, prompt, size: overrides.size || S.size, project: $('project').value || 'default' };
    const seed = overrides.seed !== undefined ? overrides.seed : $('seed').value;
    if (seed !== '' && seed !== null) body.seed = Number(seed);
    for (const key of ['temperature', 'steps', 'guidance']) {
      const v = overrides[key] !== undefined ? overrides[key] : $(key).value;
      if (v !== '' && v !== null && v !== undefined && !$(key).closest('label').hidden) body[key] = Number(v);
    }
    setBusy(true);
    showProgress({ stage: 'queued', fraction: 0 });
    try {
      const job = await api('POST', '/api/generate', body);
      S.lastRequest = body;
      poll(job.id);
    } catch (e) {
      setBusy(false);
      $('progress').hidden = true;
      banner(e.message);
    }
  }

  async function poll(id) {
    let job;
    try {
      job = await api('GET', `/api/jobs/${id}`);
    } catch (e) {
      setBusy(false);
      banner(e.message);
      return;
    }
    if (job.status === 'done') {
      showProgress({ stage: 'done', fraction: 1 });
      S.busy = false;
      showResult(job.result);
      loadStatus();                    // refreshes today's image count
      return;
    }
    if (job.status === 'error') {
      setBusy(false);
      $('progress').hidden = true;
      banner(job.error || 'Generation failed.');
      return;
    }
    showProgress(job.status === 'queued' ? { stage: 'waiting for the previous image', fraction: 0 } : job.progress);
    setTimeout(() => poll(id), 600);
  }

  function factsHTML(meta) {
    const w = meta.weights || {};
    const rows = [
      ['Model', meta.model_name],
      ['Prompt', meta.prompt],
      ['Size', `${meta.size} x ${meta.size} px, ${meta.colors ? '6 colours' : '1 bit'}`],
      ['Seed', meta.seed],
    ];
    if (meta.tokens !== undefined) rows.push(['Program', `${meta.tokens} tokens, ${meta.program ? meta.program.ops : '?'} commands${meta.complete ? '' : ' (cut off at the token limit)'}`]);
    if (meta.steps !== undefined) rows.push(['Sampling', `${meta.steps} steps, guidance ${meta.guidance}${meta.refiner_passes ? ', ' + meta.refiner_passes + ' refiner pass' + (meta.refiner_passes > 1 ? 'es' : '') : ''}`]);
    if (meta.temperature !== undefined) rows.push(['Temperature', meta.temperature]);
    rows.push(['Time', `${meta.seconds} s`]);
    if (meta.colors) {
      rows.push(['Colours', Object.entries(meta.colors).filter(([k, v]) => k !== 'white' && v > 0)
        .map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(', ') || 'none']);
    } else {
      rows.push(['Ink', `${(100 * (meta.ink_ratio || 0)).toFixed(1)}% black`]);
    }
    if (meta.bytes) rows.push(['File', `${meta.file} (${bytes(meta.bytes)})`]);
    rows.push(['Weights', `${w.source || '?'}, ${epochsLine(w, w.target_epochs)}`]);
    if (meta.created) rows.push(['Created', meta.created.replace('T', ' ')]);
    return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  function weightNotice(meta) {
    const w = meta.weights || {};
    if (!w.target_epochs || (w.epochs_completed || 0) >= w.target_epochs) return '';
    return `These weights have completed ${epochsLine(w, w.target_epochs)} of training ` +
      `(${num(w.samples_seen)} samples seen). Expect rough results until the model is trained further.`;
  }

  function showResult(result) {
    S.last = result;
    const img = $('result-img');
    img.src = result.url;
    img.alt = `Generated image for: ${result.meta.prompt}`;
    img.hidden = false;
    $('frame-empty').hidden = true;
    $('result-info').hidden = false;
    setHTML($('result-facts'), factsHTML(result.meta));
    const note = weightNotice(result.meta);
    $('result-notice').hidden = !note;
    setText($('result-notice'), note);
    $('download').href = result.url + '?download=1';
    $('download').setAttribute('download', result.meta.file || 'inkos.png');
  }

  $('gen-form').addEventListener('submit', (e) => { e.preventDefault(); generate(); });
  $('regenerate').addEventListener('click', () => {
    if (!S.lastRequest) return;
    const r = S.lastRequest;
    generate({ prompt: r.prompt, model: r.model, size: r.size, seed: '', temperature: r.temperature ?? '', steps: r.steps ?? '', guidance: r.guidance ?? '' });
  });
  $('same-seed').addEventListener('click', () => {
    if (!S.last) return;
    const r = S.lastRequest || {};
    generate({ prompt: S.last.meta.prompt, model: S.last.meta.model, size: S.last.meta.size, seed: S.last.meta.seed,
      temperature: r.temperature ?? '', steps: r.steps ?? '', guidance: r.guidance ?? '' });
  });
  $('toggle-scale').addEventListener('click', () => {
    const on = $('frame').classList.toggle('actual');
    $('toggle-scale').setAttribute('aria-pressed', String(on));
  });

  /* ---------------------------------------------------------------- projects */
  async function loadProjects() {
    let data;
    try { data = await api('GET', '/api/projects'); } catch (e) { return; }
    const opts = data.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${p.images})</option>`).join('');
    for (const id of ['project', 'gallery-project']) {
      const sel = $(id);
      const keep = sel.value || (id === 'gallery-project' ? S.galleryProject : 'default');
      setHTML(sel, opts);
      sel.value = data.projects.some((p) => p.name === keep) ? keep : 'default';
    }
  }
  $('add-project').addEventListener('click', async () => {
    const name = $('new-project').value.trim();
    if (!name) return;
    try {
      await api('POST', '/api/projects', { name });
      await loadProjects();
      $('project').value = name;
      $('new-project').value = '';
    } catch (e) { banner(e.message); }
  });

  /* ----------------------------------------------------------------- gallery */
  async function loadGallery() {
    await loadProjects();
    S.galleryProject = $('gallery-project').value || 'default';
    let data;
    try { data = await api('GET', `/api/gallery?project=${encodeURIComponent(S.galleryProject)}`); } catch (e) { banner(e.message); return; }
    S.galleryItems = data.images;
    setText($('gallery-count'), `${data.images.length} image${data.images.length === 1 ? '' : 's'} stored in projects/${S.galleryProject}/`);
    $('gallery-empty').hidden = data.images.length > 0;
    setHTML($('thumbs'), data.images.map((it, i) =>
      `<button type="button" data-i="${i}" aria-current="${S.detail === it.file}" title="${esc(it.meta.prompt || it.file)}">
         <img src="${esc(it.url)}" alt="${esc(it.meta.prompt || it.file)}" loading="lazy"></button>`).join(''));
    if (S.detail && !data.images.some((it) => it.file === S.detail)) closeDetail();
  }
  function openDetail(i) {
    const it = S.galleryItems[i];
    if (!it) return;
    S.detail = it.file;
    $('detail').hidden = false;
    $('detail-img').src = it.url;
    $('detail-img').alt = it.meta.prompt || it.file;
    setHTML($('detail-facts'), it.meta.prompt ? factsHTML(it.meta) : `<dt>File</dt><dd>${esc(it.file)}</dd>`);
    $('detail-download').href = it.url + '?download=1';
    $('detail-download').setAttribute('download', it.file);
    document.querySelectorAll('#thumbs button').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.i) === i)));
    $('detail').scrollIntoView({ block: 'nearest' });
  }
  function closeDetail() { S.detail = null; $('detail').hidden = true; }
  $('thumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) openDetail(Number(b.dataset.i)); });
  $('gallery-project').addEventListener('change', () => { closeDetail(); loadGallery(); });
  $('gallery-refresh').addEventListener('click', loadGallery);
  $('detail-close').addEventListener('click', closeDetail);
  $('detail-delete').addEventListener('click', async () => {
    if (!S.detail || !window.confirm('Delete this image from the project?')) return;
    try {
      await api('DELETE', `/api/gallery/${encodeURIComponent(S.galleryProject)}/${encodeURIComponent(S.detail)}`);
      closeDetail();
      loadGallery();
    } catch (e) { banner(e.message); }
  });
  $('detail-reuse').addEventListener('click', () => {
    const it = S.galleryItems.find((x) => x.file === S.detail);
    if (!it || !it.meta.prompt) return;
    if (modelById(it.meta.model)) S.model = it.meta.model;
    S.size = it.meta.size;
    $('prompt').value = it.meta.prompt;
    $('seed').value = it.meta.seed ?? '';
    renderPicker();
    show('generate');
  });

  /* ------------------------------------------------------------------ models */
  function renderModels() {
    const st = S.status;
    if (!st) return;
    const hw = st.hardware;
    const cell = (k, v) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
    setHTML($('machine'),
      cell('Processor threads', hw.cpu_threads) +
      cell('Memory', hw.ram_gb ? `${hw.ram_gb} GB (${hw.ram_available_gb ?? '?'} GB free)` : 'unknown') +
      cell('Graphics', hw.cuda ? `${hw.cuda.name}, ${hw.cuda.vram_gb} GB` : hw.mps ? 'Apple GPU (MPS)' : 'none: CPU only') +
      cell('Disk free', `${hw.disk_free_gb} GB`) +
      cell('Software', `Python ${hw.python}, PyTorch ${hw.torch}`));
    setHTML($('model-cards'), st.models.map(modelCard).join(''));
  }

  function modelCard(m) {
    const t = m.training, w = m.weights, mem = m.memory;
    const frac = Math.min(1, (t.epochs_completed || 0) / t.target_epochs);
    const sources = m.dataset ? m.dataset.sources.map((s) => `<li><b>data</b>${esc(s.name)} - ${esc(s.license)}</li>`).join('') : '';
    const infer = Object.entries(mem.inference_mb).map(([s, v]) => `<tr><th>Generate ${esc(s)} px</th><td class="num">about ${num(v)} MB</td></tr>`).join('');
    const checks = (m.checks || []).map((c) => `<li><b>${esc(c.level)}</b>${esc(c.text)}</li>`).join('');
    const bench = m.bench ? `<p class="sub">Measured on ${esc(m.bench.device)}: training ${m.bench.train_samples_per_sec} samples/s; ` +
      `${num(m.bench.target_epochs)} epochs would take ${duration(m.bench.seconds_to_target)}. Generation ${m.bench.generation_seconds} s.</p>` : '';
    const install = (w && w.source === 'checkpoint') || m.newer_checkpoint
      ? `<div class="actions" style="margin-top:12px"><button type="button" data-export="${esc(m.id)}">Install newest checkpoint for inference</button></div>` : '';
    return `<article class="card">
      <header><div><h2>${esc(m.name)}</h2><p>${esc(m.summary)}</p></div>
        <span class="badge ${w && w.source === 'installed' ? 'on' : ''}">${w ? (w.source === 'installed' ? 'installed' : 'checkpoint only') : 'no weights'}</span></header>
      ${m.in_plan ? '' : `<section><p><b>Not in the ${esc(currentPlan().name)} plan.</b> It can be trained, but generating with it needs a plan that includes it.</p></section>`}
      <section><h3>Training completed</h3>
        <div class="big"><b>${num(t.epochs_completed || 0)}</b><span>of ${num(t.target_epochs)} target epochs</span></div>
        <p class="sub">${t.epoch_progress > 0 ? (100 * t.epoch_progress).toFixed(1) + '% of the next epoch, ' : ''}${num(t.samples_seen || 0)} samples seen, status: ${esc(t.status)}</p>
        <div class="bar slim" title="share of the target"><span style="width:${(100 * frac).toFixed(3)}%"></span></div></section>
      <section><h3>Weights used for generation</h3>${w ? `<table>
          <tr><th>Source</th><td>${w.source === 'installed' ? 'installed in models/' : 'training checkpoint (not yet installed)'}</td></tr>
          <tr><th>Trained</th><td>${esc(epochsLine(w, t.target_epochs))}</td></tr>
          <tr><th>Samples seen</th><td>${num(w.samples_seen)}</td></tr>
          <tr><th>File</th><td>${bytes(w.bytes)}${w.dtype ? ', ' + esc(w.dtype) : ''}</td></tr>
          <tr><th>Saved</th><td>${esc((w.exported_at || w.saved_at || '').replace('T', ' '))}</td></tr></table>`
        : '<p>None. This model cannot generate until it has been trained on this machine.</p>'}${install}</section>
      <section><h3>Memory</h3><table>
          <tr><th>Parameters</th><td class="num">${m.params_m} million</td></tr>
          <tr><th>Weights</th><td class="num">${num(mem.weights_mb)} MB</td></tr>${infer}
          <tr><th>Train, batch ${mem.training_batch_size}</th><td class="num">about ${num(mem.training_mb)} MB</td></tr></table>
        <p class="sub">Estimates for the model alone; Python and PyTorch add roughly 300 MB.</p></section>
      <section><h3>This machine</h3><ul class="plain">${checks}</ul>${bench}</section>
      <section><h3>Training data</h3>${m.dataset
        ? `<p class="sub">${num(m.dataset.train_count)} training and ${num(m.dataset.val_count)} validation samples prepared.</p><ul class="plain">${sources}</ul>`
        : `<p>Not prepared. Run <code>python -m inkos data prepare --model ${esc(m.id)}</code></p>`}</section>
      <section><h3>Built for</h3><p class="mono">${esc(m.architecture)}${m.starts_from && modelById(m.starts_from) ? ', starts from ' + esc(modelById(m.starts_from).name) + ' weights' : ''}</p>
        <div class="tags">${m.specialties.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
        ${m.palette ? `<div class="swatches" aria-label="Output palette">${m.palette.names.map((n, i) => `<span><i style="background:${esc(m.palette.hex[i])}"></i>${esc(n)}</span>`).join('')}</div>`
          : '<p class="sub">Output: black and white, 1 bit per pixel.</p>'}</section>
    </article>`;
  }

  $('model-cards').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-export]');
    if (!b) return;
    b.disabled = true;
    try {
      await api('POST', '/api/export', { model: b.dataset.export });
      await loadStatus();
      renderModels();
    } catch (err) { banner(err.message); b.disabled = false; }
  });

  /* ---------------------------------------------------------------- training */
  function chartSVG(hist) {
    const tr = hist.train || [], va = (hist.val || []).filter((p) => p[2] !== null && p[2] !== undefined);
    if (tr.length < 2) return '<p class="sub">The loss curve appears after the first training steps.</p>';
    const W = 620, H = 200, L = 48, R = 10, T = 10, B = 24;
    const all = tr.map((p) => p[2]).concat(va.map((p) => p[2])).filter((v) => v > 0);
    const lo = Math.log10(Math.min(...all)), hi = Math.log10(Math.max(...all));
    const span = Math.max(1e-6, hi - lo);
    const maxStep = Math.max(tr[tr.length - 1][0], va.length ? va[va.length - 1][0] : 0, 1);
    const x = (s) => L + (W - L - R) * (s / maxStep);
    const y = (v) => T + (H - T - B) * (1 - (Math.log10(Math.max(v, 1e-9)) - lo) / span);
    const line = tr.map((p) => `${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`).join(' ');
    const marks = va.map((p) => `<rect x="${(x(p[0]) - 3.5).toFixed(1)}" y="${(y(p[2]) - 3.5).toFixed(1)}" width="7" height="7" fill="#fff" stroke="#000" stroke-width="2"/>`).join('');
    const ticks = [hi, (hi + lo) / 2, lo].map((v) => {
      const yy = T + (H - T - B) * (1 - (v - lo) / span);
      return `<line x1="${L - 4}" y1="${yy}" x2="${L}" y2="${yy}" stroke="#000"/><text x="${L - 7}" y="${yy + 4}" text-anchor="end">${Math.pow(10, v).toFixed(2)}</text>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Training loss over steps" shape-rendering="crispEdges">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#000"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#000"/>
      ${ticks}<text x="${L}" y="${H - 7}">step 0</text><text x="${W - R}" y="${H - 7}" text-anchor="end">step ${num(maxStep)}</text>
      <text x="${(L + W) / 2}" y="${H - 7}" text-anchor="middle">line: training loss (log scale), squares: validation</text>
      <polyline points="${line}" fill="none" stroke="#000" stroke-width="2" shape-rendering="geometricPrecision"/>${marks}</svg>`;
  }

  function trainingCard(m, data) {
    const t = data.training;
    const running = !!t.running;
    const fracT = Math.min(1, (t.epochs_completed || 0) / t.target_epochs);
    const val = t.val || {};
    const stat = (k, v) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
    const hasData = !!data.dataset;
    const previews = (data.previews || []).map((u) => `<img src="${esc(u)}" alt="sample from the latest checkpoint" loading="lazy">`).join('');
    return `<article class="card" data-card="${esc(m.id)}">
      <header><div><h2>${esc(m.name)}</h2><p>${esc(t.message || (running ? 'Training is running in its own process.' : 'Not training right now.'))}</p></div>
        <span class="badge ${running ? 'on' : ''}">${esc(t.status)}</span></header>
      <section><h3>Epochs completed</h3>
        <div class="big"><b>${num(t.epochs_completed || 0)}</b><span>of ${num(t.target_epochs)} target epochs</span></div>
        <p class="sub">Target: ${(100 * fracT).toFixed(4)}%</p>
        <div class="bar slim"><span style="width:${(100 * fracT).toFixed(3)}%"></span></div>
        <p class="sub">Current epoch: ${(100 * (t.epoch_progress || 0)).toFixed(1)}%${t.steps_per_epoch ? ` (step ${num(t.step_in_epoch)} of ${num(t.steps_per_epoch)})` : ''}</p>
        <div class="bar slim"><span style="width:${(100 * (t.epoch_progress || 0)).toFixed(2)}%"></span></div></section>
      <section><div class="stats">
        ${stat('Samples seen', num(t.samples_seen || 0))}${stat('Steps', num(t.global_step || 0))}
        ${stat('Training loss', t.loss === null || t.loss === undefined ? '-' : fix(t.loss, 4))}
        ${stat('Validation loss', val.loss === undefined ? '-' : fix(val.loss, 4))}
        ${stat('Speed', t.samples_per_sec ? `${t.samples_per_sec} samples/s` : '-')}
        ${stat('To target at this speed', t.eta_seconds_to_target ? duration(t.eta_seconds_to_target) : '-')}
        ${stat('Time trained', t.train_seconds ? duration(t.train_seconds) : '-')}
        ${stat('Device', t.device || '-')}
        ${stat('Dataset', hasData ? `${num(data.dataset.train_count)} samples` : 'not prepared')}
        ${stat('Updated', t.updated_at ? t.updated_at.replace('T', ' ') : '-')}</div></section>
      <section><h3>Loss</h3>${chartSVG(data.history || {})}</section>
      ${previews ? `<section><h3>Samples from the latest validation</h3><div class="previews">${previews}</div></section>` : ''}
      <section><h3>Control</h3>
        ${hasData ? '' : `<p class="sub">Prepare data first: <code>python -m inkos data prepare --model ${esc(m.id)}</code></p>`}
        <div class="inline">
          <label>Stop after (hours)<input type="number" min="0.1" step="0.5" inputmode="decimal" placeholder="no limit" data-hours="${esc(m.id)}"></label>
          <button type="button" data-start="${esc(m.id)}" ${running || !hasData ? 'disabled' : ''}>${(t.global_step || 0) > 0 ? 'Resume training' : 'Start training'}</button>
          <button type="button" data-stop="${esc(m.id)}" ${running ? '' : 'disabled'}>Stop and save</button>
        </div>
        <p class="sub">Same as <code>python -m inkos train --model ${esc(m.id)}</code>. Stopping writes a checkpoint first.</p></section>
      <section><h3>Trainer log</h3><pre class="log">${esc((data.log || []).join('\n') || 'No log yet.')}</pre></section>
    </article>`;
  }

  async function loadTraining() {
    if (!S.status) await loadStatus();
    if (!S.status) return;
    const host = $('training-cards');
    for (const m of S.status.models) {
      let data;
      try { data = await api('GET', `/api/training?model=${encodeURIComponent(m.id)}`); } catch (e) { banner(e.message); return; }
      let card = host.querySelector(`[data-wrap="${m.id}"]`);
      if (!card) {
        card = document.createElement('div');
        card.dataset.wrap = m.id;
        host.appendChild(card);
      }
      const typed = card.querySelector('[data-hours]');
      const hours = typed ? typed.value : '';
      const focused = typed && document.activeElement === typed;
      if (focused) continue;                       // do not redraw under the user's fingers
      setHTML(card, trainingCard(m, data));
      const again = card.querySelector('[data-hours]');
      if (again && hours) again.value = hours;
    }
  }

  $('training-cards').addEventListener('click', async (e) => {
    const start = e.target.closest('[data-start]');
    const stop = e.target.closest('[data-stop]');
    try {
      if (start) {
        start.disabled = true;
        const hours = $('training-cards').querySelector(`[data-hours="${start.dataset.start}"]`).value;
        await api('POST', '/api/training/start', { model: start.dataset.start, max_hours: hours ? Number(hours) : null });
        setTimeout(loadTraining, 2500);
      } else if (stop) {
        stop.disabled = true;
        await api('POST', '/api/training/stop', { model: stop.dataset.stop });
        setTimeout(loadTraining, 2500);
      }
    } catch (err) { banner(err.message); loadTraining(); }
  });
  $('training-refresh').addEventListener('click', loadTraining);

  /* ------------------------------------------------------------------- plans */
  function renderPlans() {
    if (!S.status) return;
    const P = S.status.plan;
    const u = P.usage;
    setText($('plan-usage'), `Used today: ${u.images}${u.limit === null ? ' (no daily limit)' : ' of ' + u.limit + ' images'}`);
    setHTML($('plan-cards'), P.plans.map((p) => {
      const on = p.id === P.current;
      const models = S.status.models.map((m) => `<li><b>${p.models.includes(m.id) ? 'yes' : 'no'}</b>${esc(m.name)}${m.palette ? ' (colour)' : ''}</li>`).join('');
      return `<article class="card ${on ? 'current' : ''}">
        <header><div><h2>${esc(p.name)}</h2><p>${esc(p.tagline || '')}</p></div><span class="badge ${on ? 'on' : ''}">${on ? 'current plan' : 'available'}</span></header>
        ${p.price ? `<section><div class="big"><b>${esc(p.price)}</b></div></section>` : ''}
        <section><h3>Models</h3><ul class="plain">${models}</ul></section>
        <section><table>
          <tr><th>Largest size</th><td class="num">${p.max_size ? p.max_size + ' px' : 'any'}</td></tr>
          <tr><th>Images per day</th><td class="num">${p.images_per_day === null ? 'unlimited' : num(p.images_per_day)}</td></tr>
          <tr><th>Projects</th><td class="num">${p.projects === null ? 'unlimited' : num(p.projects)}</td></tr>
          <tr><th>Training</th><td class="num">all models</td></tr></table></section>
        <div class="cta"><button type="button" data-plan="${esc(p.id)}" ${on ? 'disabled' : ''}>${on ? 'In use' : 'Use this plan'}</button></div>
      </article>`;
    }).join(''));
  }
  $('plan-cards').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-plan]');
    if (!b) return;
    b.disabled = true;
    try {
      await api('POST', '/api/plan', { plan: b.dataset.plan });
      await loadStatus();
      await loadProjects();
      renderPlans();
    } catch (err) { banner(err.message); }
  });

  /* -------------------------------------------------------------------- tabs */
  function show(view) {
    S.view = view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    if (view === 'gallery') loadGallery();
    if (view === 'models') loadStatus().then(renderModels);
    if (view === 'training') loadTraining();
    if (view === 'generate') loadStatus();
    if (view === 'plans') loadStatus().then(renderPlans);
    try { window.history.replaceState(null, '', `#${view}`); } catch (e) { /* file:// */ }
  }
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) show(b.dataset.view);
  });

  setInterval(() => {
    if (document.hidden) return;
    if (S.view === 'training' && $('auto-refresh').checked) loadTraining();
  }, 6000);

  (async function init() {
    await loadStatus();
    await loadProjects();
    const want = (window.location.hash || '').slice(1);
    show(['generate', 'gallery', 'models', 'training', 'plans'].includes(want) ? want : 'generate');
  })();
})();
