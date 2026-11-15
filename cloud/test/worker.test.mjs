// The Worker's API, with a real SQLite database standing in for D1 and
// locally signed tokens standing in for Clerk's.
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { issuerFromPublishableKey, resetKeyCache, userPlans } from '../src/auth.js';
import worker, { planFor } from '../src/worker.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const HOST = 'test-host-1.clerk.accounts.dev';
const PK = 'pk_test_' + Buffer.from(HOST + '$').toString('base64').replace(/=+$/, '');
const ORIGIN = 'https://inkos.example.workers.dev';

// --- stand-ins for the Workers runtime ---------------------------------------
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { this.db.prepare(this.sql).run(...this.params); return { success: true }; }
}
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(here('../migrations/0001_init.sql'), 'utf8'));
  return { db, prepare: (sql) => new Stmt(db, sql) };
}
// Workers KV holding the weights, as cloud/README.md uploads them
const kv = {
  async getWithMetadata(key, { type }) {
    const f = here('../public/' + key);
    if (!/^weights\/[a-z0-9_]+\.(json|bin)$/.test(key) || !existsSync(f)) return { value: null, metadata: null };
    const bytes = readFileSync(f);
    assert.equal(type, 'stream');
    return { value: new Blob([bytes]).stream(), metadata: { size: bytes.length } };
  },
};

// --- tokens ------------------------------------------------------------------
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const otherPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const JWKS = JSON.stringify({ keys: [{ ...jwk, kid: 'ins_test', use: 'sig', alg: 'RS256' }] });
const b64u = (b) => Buffer.from(b).toString('base64url');

async function token(claims = {}, { kid = 'ins_test', key = keyPair.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { sub: 'user_a', iss: `https://${HOST}`, azp: ORIGIN, exp: now + 60, nbf: now - 5, iat: now, sid: 'sess_1', v: 2, ...claims };
  const head = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })) + '.' + b64u(JSON.stringify(body));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head));
  return `${head}.${b64u(sig)}`;
}

function setup() {
  resetKeyCache();
  const env = { CLERK_PUBLISHABLE_KEY: PK, CLERK_JWKS_JSON: JWKS, DB: d1(), WEIGHTS: kv };
  const call = async (method, path, { tok, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  };
  return { env, call };
}

const tinyPNG = (size) => {
  const b = new Uint8Array(40);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, size);
  new DataView(b.buffer).setUint32(20, size);
  b[24] = 1;
  return Buffer.from(b).toString('base64');
};

// --- tests -------------------------------------------------------------------
test('publishable key decodes to the Frontend API issuer', () => {
  assert.equal(issuerFromPublishableKey(PK), `https://${HOST}`);
  assert.throws(() => issuerFromPublishableKey('sk_test_x'));
});

test('plan claims map to INKOS plans; the best plan wins', () => {
  assert.deepEqual(userPlans({ pla: 'u:user_plus,o:org_plan' }), ['user_plus']);
  assert.equal(planFor({}).id, 'basic');
  assert.equal(planFor({ pla: 'u:free_user' }).id, 'basic');
  assert.equal(planFor({ pla: 'u:user_plus' }).id, 'plus');
  assert.equal(planFor({ pla: 'u:user_pro' }).id, 'studio');
  assert.equal(planFor({ pla: 'o:user_pro' }).id, 'basic');          // organisation plans are not user plans
  assert.equal(planFor({ pla: 'u:free_user,u:user_pro' }).id, 'studio');
});

test('anything but a valid Clerk session token is refused', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/config')).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);
  const now = Math.floor(Date.now() / 1000);
  const bad = [
    'not-a-token',
    await token({ exp: now - 100 }),                                   // expired
    await token({ iss: 'https://evil.clerk.accounts.dev' }),            // another instance
    await token({ azp: 'https://evil.example' }),                       // issued for another site
    await token({ sts: 'pending' }),
    await token({}, { kid: 'unknown' }),
    await token({}, { key: otherPair.privateKey }),                     // forged signature
  ];
  for (const t of bad) {
    const r = await call('GET', '/api/me', { tok: t });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(r.body.signIn, true);
  }
  const ok = await call('GET', '/api/me', { tok: await token() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.userId, 'user_a');
  assert.equal(ok.body.plan.id, 'basic');
});

test('config exposes only the public key', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/config');
  assert.deepEqual(r.body, { publishableKey: PK, frontendApi: `https://${HOST}` });
});

test('weights are only served to plans that include the model', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/weights/inkos1.json')).status, 401);
  const basic = await token();
  const r = await call('GET', '/weights/inkos1.json', { tok: basic });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal((await call('GET', '/weights/inkos1_1.bin', { tok: basic })).status, 403);
  assert.equal((await call('GET', '/weights/inkos1_1.json', { tok: await token({ pla: 'u:user_plus' }) })).status, 200);
  assert.equal((await call('GET', '/weights/inkos1_pro.bin', { tok: await token({ pla: 'u:user_pro' }) })).status, 400);
  assert.equal((await call('GET', '/weights/%2e%2e%2fdata%2fapp.json', { tok: basic })).status, 404);
  assert.equal((await call('GET', '/weights/inkos1_1%2ebin', { tok: basic })).status, 404);
});

test('generation tickets enforce model, size and the daily allowance atomically', async () => {
  const { env, call } = setup();
  const basic = await token();
  let r = await call('POST', '/api/generations', { tok: basic, body: { model: 'inkos1_1', size: 512 } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /INKOS 1.1 is not part of the Basic plan/);
  assert.equal(r.body.upgrade, true);
  r = await call('POST', '/api/generations', { tok: basic, body: { model: 'inkos1', size: 1024 } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /up to 512 px/);
  r = await call('POST', '/api/generations', { tok: basic, body: { model: 'inkos1', size: 512 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.usage.images, 1);
  assert.deepEqual(r.body.usage.remaining, 29);
  env.DB.db.prepare('UPDATE usage SET images = 30').run();
  r = await call('POST', '/api/generations', { tok: basic, body: { model: 'inkos1', size: 256 } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /used up/);
  // another user is not affected; Studio has no limit
  const studio = await token({ sub: 'user_b', pla: 'u:user_pro' });
  env.DB.db.prepare("INSERT INTO usage VALUES ('user_b', ?, 100000)").run(new Date().toISOString().slice(0, 10));
  r = await call('POST', '/api/generations', { tok: studio, body: { model: 'inkos1_1', size: 1024 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.usage.limit, null);
  // concurrent tickets never exceed the allowance
  const plus = await token({ sub: 'user_c', pla: 'u:user_plus' });
  env.DB.db.prepare("INSERT INTO usage VALUES ('user_c', ?, 295)").run(new Date().toISOString().slice(0, 10));
  const res = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/generations', { tok: plus, body: { model: 'inkos1_1', size: 1024 } })));
  assert.equal(res.filter((x) => x.status === 200).length, 5);
  assert.equal(env.DB.db.prepare("SELECT images FROM usage WHERE user_id = 'user_c'").get().images, 300);
});

test('projects follow the plan; the gallery is private to each user', async () => {
  const { call } = setup();
  const basic = await token();
  let r = await call('POST', '/api/projects', { tok: basic, body: { name: 'Second' } });
  assert.equal(r.status, 403);
  const plus = await token({ pla: 'u:user_plus' });
  r = await call('POST', '/api/projects', { tok: plus, body: { name: 'Second' } });
  assert.deepEqual(r.body.projects, ['default', 'Second']);
  assert.equal((await call('POST', '/api/projects', { tok: plus, body: { name: '../x' } })).status, 400);

  r = await call('POST', '/api/gallery', { tok: plus, body: { project: 'Second', png: tinyPNG(512), meta: { model: 'inkos1_1', prompt: 'red heart', seed: 4 } } });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.meta.size, 512);
  assert.equal(r.body.meta.weights.target_epochs, 10000);
  // basic users may not save 1024 px or colour images
  assert.equal((await call('POST', '/api/gallery', { tok: basic, body: { png: tinyPNG(1024), meta: { model: 'inkos1' } } })).status, 403);
  assert.equal((await call('POST', '/api/gallery', { tok: basic, body: { png: tinyPNG(256), meta: { model: 'inkos1_1' } } })).status, 403);
  assert.equal((await call('POST', '/api/gallery', { tok: plus, body: { png: Buffer.from('hello').toString('base64'), meta: { model: 'inkos1' } } })).status, 400);

  r = await call('GET', '/api/gallery?project=Second', { tok: plus });
  assert.equal(r.body.images.length, 1);
  assert.equal(r.body.images[0].meta.prompt, 'red heart');
  r = await call('GET', `/api/gallery/${id}?download=1`, { tok: plus });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.deepEqual([...r.body.subarray(0, 4)], [137, 80, 78, 71]);
  const stranger = await token({ sub: 'user_z', pla: 'u:user_plus' });
  assert.equal((await call('GET', `/api/gallery/${id}`, { tok: stranger })).status, 404);
  await call('DELETE', `/api/gallery/${id}`, { tok: stranger });
  assert.equal((await call('GET', `/api/gallery/${id}`, { tok: plus })).status, 200);
  await call('DELETE', `/api/gallery/${id}`, { tok: plus });
  assert.equal((await call('GET', `/api/gallery/${id}`, { tok: plus })).status, 404);
});

test('the app itself is served without sign-in, from the Worker bundle', async () => {
  const { call } = setup();
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/engine/model.js', 'text/javascript'],
    ['/style.css', 'text/css'], ['/data/app.json', 'application/json'], ['/data/font.json', 'application/json']]) {
    const r = await call('GET', path);
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get('content-type').startsWith(type), path);
  }
  assert.equal((await call('GET', '/nope.html')).status, 404);
  assert.equal((await call('GET', '/weights/inkos1.bin')).status, 401);          // never served as a static file
  assert.equal((await call('GET', '/test/fixtures.json')).status, 404);
});

test('weights stream from KV with their size', async () => {
  const { call } = setup();
  const r = await call('GET', '/weights/inkos1.bin', { tok: await token() });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.body.length, readFileSync(here('../public/weights/inkos1.bin')).length);
});
