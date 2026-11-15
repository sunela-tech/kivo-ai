// INKOS Cloud Worker.
//
// Serves the app (bundled into this script), verifies Clerk sign-in, applies the
// Clerk Billing plan to every request, keeps the daily image count and the
// gallery in D1, and only hands model weights to users whose plan includes
// the model. The models themselves run in the user's browser.

import APP from '../public/data/app.json' with { type: 'json' };
import { AuthError, issuerFromPublishableKey, userPlans, verifySessionToken } from './auth.js';
import STATIC from './static.gen.js';

const MODELS = new Map(APP.models.filter((m) => m.cloud).map((m) => [m.id, m]));
const PLANS = APP.plans;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const MAX_PNG = 512 * 1024;
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
  const row = await env.DB.prepare('SELECT images FROM usage WHERE user_id = ?1 AND day = ?2').bind(user.userId, today()).first();
  const images = row ? row.images : 0;
  const limit = user.plan.images_per_day;
  return { date: today(), images, limit, remaining: limit === null ? null : Math.max(0, limit - images) };
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
    const limit = user.plan.images_per_day ?? 2 ** 31 - 1;
    // one atomic statement: count the image only while the day's allowance lasts
    const row = await env.DB.prepare(
      `INSERT INTO usage (user_id, day, images) VALUES (?1, ?2, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET images = images + 1 WHERE usage.images < ?3
       RETURNING images`).bind(user.userId, today(), limit).first();
    if (!row || row.images > limit) {
      throw new HttpError(403, `Today's ${user.plan.images_per_day} images of the ${user.plan.name} plan are used up.`, { upgrade: true });
    }
    return json({ ok: true, usage: await usage(env, user) });
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
    try { png = Uint8Array.from(atob(String(b.png || '')), (c) => c.charCodeAt(0)); } catch { throw new HttpError(400, 'png must be base64'); }
    if (png.length > MAX_PNG) throw new HttpError(413, 'image too large');
    const info = pngSize(png);
    if (!info || info.w !== info.h) throw new HttpError(400, 'not an INKOS PNG');
    const meta = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const model = checkModel(user, String(meta.model || ''));
    checkSize(user, model, info.w);
    const clean = {
      model: model.id, model_name: model.name, size: info.w, prompt: String(meta.prompt || '').slice(0, 2000),
      seed: Number.isFinite(meta.seed) ? meta.seed : null, temperature: Number.isFinite(meta.temperature) ? meta.temperature : null,
      tokens: Number.isFinite(meta.tokens) ? meta.tokens : null, complete: !!meta.complete, seconds: Number.isFinite(meta.seconds) ? meta.seconds : null,
      colors: meta.colors && typeof meta.colors === 'object' ? meta.colors : null, bytes: png.length,
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
    const name = `inkos-${one[1]}.png`;
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400',
      'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${name}"` } });
  }
  if (one && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM images WHERE id = ?1 AND user_id = ?2').bind(one[1], user.userId).run();
    return json({ deleted: one[1] });
  }

  throw new HttpError(404, 'not found');
}

async function weights(request, env, url) {
  const m = /^\/weights\/([a-z0-9_]+)\.(json|bin)$/.exec(url.pathname);
  if (!m || request.method !== 'GET') return new Response('not found', { status: 404 });
  const user = await authenticate(request, env);
  checkModel(user, m[1]);
  // weights live in Workers KV under weights/<model>.<ext>; metadata.size is the byte length
  const { value, metadata } = await env.WEIGHTS.getWithMetadata(`weights/${m[1]}.${m[2]}`, { type: 'stream' });
  if (!value) throw new HttpError(404, 'these weights are not installed on the server');
  const headers = { 'content-type': m[2] === 'json' ? 'application/json' : 'application/octet-stream',
    'cache-control': 'private, max-age=86400' };
  let body = value;
  if (metadata && metadata.size && typeof FixedLengthStream !== 'undefined') {
    const fixed = new FixedLengthStream(metadata.size);      // sends Content-Length, so the page can show progress
    value.pipeTo(fixed.writable);
    body = fixed.readable;
  }
  return new Response(body, { headers });
}

function staticFile(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const f = STATIC[url.pathname];
  if (!f) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(request.method === 'HEAD' ? null : f.body, {
    headers: { 'content-type': f.type, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname.startsWith('/weights/')) return await weights(request, env, url);
      return staticFile(request, url);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message, signIn: true }, 401);
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
};
