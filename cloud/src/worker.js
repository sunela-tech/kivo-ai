// INKOS Cloud Worker.
//
// Serves the app (bundled into this script), verifies Clerk sign-in, applies the
// Clerk Billing plan to every request, keeps the daily image count and the
// gallery in D1, and only hands model weights to users whose plan includes
// the model. The models themselves run in the user's browser (the Pro models
// through onnxruntime-web, served from /ort/).

import APP from '../public/data/app.json' with { type: 'json' };
import { AuthError, issuerFromPublishableKey, userPlans, verifySessionToken } from './auth.js';
import STATIC from './static.gen.js';
import { CostError, tokenCost } from './usage.js';

const MODELS = new Map(APP.models.filter((m) => m.cloud).map((m) => [m.id, m]));
const PLANS = APP.plans;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const MAX_PNG = 512 * 1024;
const MAX_GIF = 1900 * 1024;          // a D1 row holds up to 2 MB
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// who is asking, and what their plan allows

/** Clerk plan slugs in the token -> the INKOS plan (the best one if there are several). */
export function planFor(claims) {
  const slugs = userPlans(claims);
  let plan = PLANS.find((p) => p.id === APP.default_plan);
  for (const p of PLANS) if (slugs.includes(p.clerk_plan) && PLANS.indexOf(p) > PLANS.indexOf(plan)) plan = p;
  return plan;
}

async function authenticate(request, env) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw new AuthError('sign in first');
  const origin = new URL(request.url).origin;
  const allowed = [origin, ...String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  const claims = await verifySessionToken(m[1], env, allowed);
  return { userId: claims.sub, plan: planFor(claims), claims };
}

async function usage(env, user) {
  const row = await env.DB.prepare('SELECT images, tokens FROM usage WHERE user_id = ?1 AND day = ?2').bind(user.userId, today()).first();
  const images = row ? row.images : 0, tokens = row ? row.tokens : 0;
  const limit = user.plan.tokens_per_day;
  return { date: today(), images, tokens, limit, remaining: limit === null ? null : Math.max(0, limit - tokens),
    percent: limit ? Math.min(100, Math.round((1000 * tokens) / limit) / 10) : null };
}

async function projectNames(env, user) {
  const { results } = await env.DB.prepare('SELECT name FROM projects WHERE user_id = ?1 ORDER BY created_at').bind(user.userId).all();
  return ['default', ...results.map((r) => r.name).filter((n) => n !== 'default')];
}

function checkModel(user, modelId) {
  const m = MODELS.get(modelId);
  if (!m) throw new HttpError(400, 'unknown model');
  if (!user.plan.models.includes(modelId)) {
    throw new HttpError(403, `${m.name} is not part of the ${user.plan.name} plan.`, { upgrade: true });
  }
  return m;
}

function checkSize(user, model, size) {
  if (!model.sizes.includes(size)) throw new HttpError(400, `size must be one of ${model.sizes.join(', ')}`);
  if (user.plan.max_size && size > user.plan.max_size) {
    throw new HttpError(403, `The ${user.plan.name} plan generates up to ${user.plan.max_size} px.`, { upgrade: true });
  }
}

async function body(request) {
  const n = Number(request.headers.get('content-length') || 0);
  if (n > MAX_BODY) throw new HttpError(413, 'request too large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'request too large');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'body must be JSON'); }
}

function pngSize(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((v, i) => bytes[i] !== v)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  return { w: dv.getUint32(16), h: dv.getUint32(20), depth: bytes[24], type: bytes[25] };
}

function gifSize(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  if (bytes.length < 14 || (head !== 'GIF89a' && head !== 'GIF87a')) return null;
  return { w: bytes[6] | (bytes[7] << 8), h: bytes[8] | (bytes[9] << 8) };
}

// ---------------------------------------------------------------------------
// routes

async function api(request, env, url) {
  const path = url.pathname, method = request.method;

  if (path === '/api/config' && method === 'GET') {
    return json({ publishableKey: env.CLERK_PUBLISHABLE_KEY, frontendApi: issuerFromPublishableKey(env.CLERK_PUBLISHABLE_KEY) });
  }

  const user = await authenticate(request, env);

  if (path === '/api/me' && method === 'GET') {
    return json({ userId: user.userId, plan: user.plan, usage: await usage(env, user), projects: await projectNames(env, user) });
  }

  if (path === '/api/generations' && method === 'POST') {
    const b = await body(request);
    const model = checkModel(user, String(b.model || ''));
    checkSize(user, model, Number(b.size));
    let cost;
    try { cost = tokenCost(APP.usage, model.id, Number(b.size), b.steps); } catch (e) {
      if (e instanceof CostError) throw new HttpError(400, e.message);
      throw e;
    }
    const limit = user.plan.tokens_per_day ?? 2 ** 50;
    const spent = () => new HttpError(403, `This needs ${cost.toLocaleString('en-US')} tokens, more than is left of today's usage on the ${user.plan.name} plan.`, { upgrade: true });
    if (cost > limit) throw spent();
    // one atomic statement: charge the tokens only while the day's allowance covers them
    const row = await env.DB.prepare(
      `INSERT INTO usage (user_id, day, images, tokens) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (user_id, day) DO UPDATE SET images = images + 1, tokens = tokens + ?3 WHERE usage.tokens + ?3 <= ?4
       RETURNING tokens`).bind(user.userId, today(), cost, limit).first();
    if (!row || row.tokens > limit) throw spent();
    return json({ ok: true, cost, usage: await usage(env, user) });
  }

  if (path === '/api/projects' && method === 'GET') {
    const names = await projectNames(env, user);
    const { results } = await env.DB.prepare('SELECT project, COUNT(*) AS n FROM images WHERE user_id = ?1 GROUP BY project').bind(user.userId).all();
    const counts = Object.fromEntries(results.map((r) => [r.project, r.n]));
    return json({ projects: names.map((name) => ({ name, images: counts[name] || 0 })), limit: user.plan.projects });
  }

  if (path === '/api/projects' && method === 'POST') {
    const name = String((await body(request)).name || '').trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, "project names use letters, digits, space, '-' and '_' (max 40)");
    const names = await projectNames(env, user);
    if (!names.includes(name)) {
      if (user.plan.projects !== null && names.length >= user.plan.projects) {
        throw new HttpError(403, `The ${user.plan.name} plan holds ${user.plan.projects} project${user.plan.projects === 1 ? '' : 's'}.`, { upgrade: true });
      }
      await env.DB.prepare('INSERT OR IGNORE INTO projects (user_id, name, created_at) VALUES (?1, ?2, ?3)')
        .bind(user.userId, name, new Date().toISOString()).run();
    }
    return json({ created: name, projects: await projectNames(env, user) });
  }

  if (path === '/api/gallery' && method === 'GET') {
    const project = url.searchParams.get('project') || 'default';
    const { results } = await env.DB.prepare(
      'SELECT id, project, created_at, meta FROM images WHERE user_id = ?1 AND project = ?2 ORDER BY created_at DESC LIMIT 200')
      .bind(user.userId, project).all();
    return json({ project, images: results.map((r) => ({ id: r.id, project: r.project, created_at: r.created_at, meta: JSON.parse(r.meta) })) });
  }

  if (path === '/api/gallery' && method === 'POST') {
    const b = await body(request);
    const project = String(b.project || 'default');
    if (!(await projectNames(env, user)).includes(project)) throw new HttpError(400, 'no such project');
    let png;
    try { png = Uint8Array.from(atob(String(b.png || b.gif || '')), (c) => c.charCodeAt(0)); } catch { throw new HttpError(400, 'the file must be base64'); }
    const meta = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const model = checkModel(user, String(meta.model || ''));
    const video = model.media === 'video';
    if (png.length > (video ? MAX_GIF : MAX_PNG)) throw new HttpError(413, 'file too large for the gallery');
    const info = video ? gifSize(png) : pngSize(png);
    if (!info || info.w !== info.h) throw new HttpError(400, video ? 'not an INKOS GIF' : 'not an INKOS PNG');
    checkSize(user, model, info.w);
    const clean = {
      model: model.id, model_name: model.name, size: info.w, prompt: String(meta.prompt || '').slice(0, 2000),
      seed: Number.isFinite(meta.seed) ? meta.seed : null, temperature: Number.isFinite(meta.temperature) ? meta.temperature : null,
      tokens: Number.isFinite(meta.tokens) ? meta.tokens : null, complete: !!meta.complete, seconds: Number.isFinite(meta.seconds) ? meta.seconds : null,
      steps: Number.isFinite(meta.steps) ? meta.steps : null, guidance: Number.isFinite(meta.guidance) ? meta.guidance : null,
      backend: ['webgpu', 'wasm'].includes(meta.backend) ? meta.backend : null,
      colors: meta.colors && typeof meta.colors === 'object' ? meta.colors : null, bytes: png.length,
      media: video ? 'gif' : 'png', frames: video && Number.isFinite(meta.frames) ? meta.frames : null,
      fps: video && Number.isFinite(meta.fps) ? meta.fps : null, tokens_used: Number.isFinite(meta.tokens_used) ? meta.tokens_used : null,
      weights: model.training ? { epochs_completed: model.training.epochs_completed, epoch_progress: model.training.epoch_progress,
        samples_seen: model.training.samples_seen, target_epochs: model.target_epochs } : null,
    };
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const created = new Date().toISOString();
    await env.DB.prepare('INSERT INTO images (id, user_id, project, created_at, meta, png) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, user.userId, project, created, JSON.stringify(clean), png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)).run();
    return json({ id, created_at: created, meta: clean }, 201);
  }

  const one = /^\/api\/gallery\/([a-f0-9]{16})$/.exec(path);
  if (one && method === 'GET') {
    const row = await env.DB.prepare('SELECT png, meta FROM images WHERE id = ?1 AND user_id = ?2').bind(one[1], user.userId).first();
    if (!row) throw new HttpError(404, 'not found');
    const bytes = row.png instanceof ArrayBuffer ? new Uint8Array(row.png) : new Uint8Array(row.png);
    const gif = gifSize(bytes) !== null;
    const name = `inkos-${one[1]}.${gif ? 'gif' : 'png'}`;
    return new Response(bytes, { headers: { 'content-type': gif ? 'image/gif' : 'image/png', 'cache-control': 'private, max-age=86400',
      'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${name}"` } });
  }
  if (one && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM images WHERE id = ?1 AND user_id = ?2').bind(one[1], user.userId).run();
    return json({ deleted: one[1] });
  }

  throw new HttpError(404, 'not found');
}

// A file in Workers KV. A value holds at most 25 MiB, so larger files are
// stored in parts: <key> holds part 0 with metadata {size, parts}, and
// <key>#1, <key>#2, ... the rest. They are streamed back as one body.
async function kvFile(env, ctx, key) {
  const { value, metadata } = await env.WEIGHTS.getWithMetadata(key, { type: 'stream' });
  if (!value) return null;
  const size = metadata && metadata.size, parts = (metadata && metadata.parts) || 1;
  if (!size || typeof FixedLengthStream === 'undefined') {
    if (parts > 1) throw new HttpError(500, 'this runtime cannot join stored parts');
    return value;
  }
  const fixed = new FixedLengthStream(size);                  // sends Content-Length, so the page can show progress
  const pump = (async () => {
    await value.pipeTo(fixed.writable, { preventClose: parts > 1 });
    for (let k = 1; k < parts; k++) {
      const next = await env.WEIGHTS.get(`${key}#${k}`, { type: 'stream' });
      if (!next) throw new Error(`part ${k} of ${key} is missing`);
      await next.pipeTo(fixed.writable, { preventClose: k < parts - 1 });
    }
  })().catch(async (e) => { console.error(e); try { await fixed.writable.abort(e); } catch { /* already closed */ } });
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);
  return fixed.readable;
}

const FILE_TYPES = { json: 'application/json', bin: 'application/octet-stream', onnx: 'application/octet-stream',
  mjs: 'text/javascript; charset=utf-8', wasm: 'application/wasm' };

async function weights(request, env, ctx, url) {
  // /weights/<model>.json|bin  (INKOS 1 family)   /weights/<model>/<file>  (Pro: ONNX graphs + manifest)
  const m = /^\/weights\/([a-z0-9_]+)(?:\.(json|bin)|\/(manifest\.json|[a-z]+\.onnx))$/.exec(url.pathname);
  if (!m || request.method !== 'GET') return new Response('not found', { status: 404 });
  const user = await authenticate(request, env);
  const model = checkModel(user, m[1]);
  if ((model.engine === 'pro') !== !!m[3]) throw new HttpError(404, 'not found');
  const key = m[3] ? `weights/${m[1]}/${m[3]}` : `weights/${m[1]}.${m[2]}`;
  const body = await kvFile(env, ctx, key);
  if (!body) throw new HttpError(404, 'these weights are not installed on the server');
  return new Response(body, { headers: { 'content-type': FILE_TYPES[key.split('.').pop()], 'cache-control': 'private, max-age=86400' } });
}

// onnxruntime-web, which runs the Pro models in the browser. Public: it holds no model.
async function runtimeFile(request, env, ctx, url) {
  const m = /^\/ort\/(\d+\.\d+\.\d+)\/(ort[a-z.-]*\.(mjs|wasm))$/.exec(url.pathname);
  if (!m || request.method !== 'GET') return new Response('not found', { status: 404 });
  const body = await kvFile(env, ctx, `ort/${m[1]}/${m[2]}`);
  if (!body) return new Response('not found', { status: 404 });
  return new Response(body, { headers: { 'content-type': FILE_TYPES[m[3]], 'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff' } });
}

function staticFile(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const f = STATIC[url.pathname];
  if (!f) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(request.method === 'HEAD' ? null : f.body, {
    headers: { 'content-type': f.type, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname.startsWith('/weights/')) return await weights(request, env, ctx, url);
      if (url.pathname.startsWith('/ort/')) return await runtimeFile(request, env, ctx, url);
      return staticFile(request, url);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message, signIn: true }, 401);
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
};
