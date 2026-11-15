// Clerk session-token verification without a secret key.
//
// The browser sends `Authorization: Bearer <session token>` (from
// Clerk.session.getToken()). The token is an RS256 JWT signed by the
// instance's Frontend API; its public keys are at <issuer>/.well-known/jwks.json.

const enc = new TextEncoder();
const SKEW = 10; // seconds of clock leeway

export class AuthError extends Error {
  constructor(message) { super(message); this.status = 401; }
}

/** pk_test_<base64(host$)> -> https://host */
export function issuerFromPublishableKey(pk) {
  const m = /^pk_(test|live)_(.+)$/.exec(pk || '');
  if (!m) throw new Error('CLERK_PUBLISHABLE_KEY is not a Clerk publishable key');
  const host = atob(m[2].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/, '');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('CLERK_PUBLISHABLE_KEY does not decode to a host name');
  return `https://${host}`;
}

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
const b64urlJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// JWKS cache, per isolate
let jwksCache = { url: null, at: 0, keys: new Map() };

async function getKey(kid, env, issuer) {
  const url = `${issuer}/.well-known/jwks.json`;
  const fresh = jwksCache.url === url && Date.now() - jwksCache.at < 3600_000;
  if (!fresh || !jwksCache.keys.has(kid)) {
    let jwks;
    if (env.CLERK_JWKS_JSON) jwks = JSON.parse(env.CLERK_JWKS_JSON);          // tests and local development only
    else {
      // refetch at most once a minute when an unknown kid shows up
      if (fresh && Date.now() - jwksCache.at < 60_000) throw new AuthError('unknown signing key');
      const r = await fetch(url, { cf: { cacheTtl: 300 } });
      if (!r.ok) throw new Error(`could not load Clerk signing keys (${r.status})`);
      jwks = await r.json();
    }
    const keys = new Map();
    for (const k of jwks.keys || []) {
      if (k.kty !== 'RSA' || (k.use && k.use !== 'sig')) continue;
      keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    jwksCache = { url, at: Date.now(), keys };
  }
  const key = jwksCache.keys.get(kid);
  if (!key) throw new AuthError('unknown signing key');
  return key;
}

/**
 * Verify a Clerk session token. Returns its claims, or throws AuthError.
 * allowedParties: origins allowed in the `azp` claim (the app's own origin).
 */
export async function verifySessionToken(token, env, allowedParties) {
  const issuer = issuerFromPublishableKey(env.CLERK_PUBLISHABLE_KEY);
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  let header, claims;
  try { header = b64urlJSON(parts[0]); claims = b64urlJSON(parts[1]); } catch { throw new AuthError('malformed token'); }
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('unsupported token');
  const key = await getKey(header.kid, env, issuer);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new AuthError('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now - SKEW) throw new AuthError('session token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW) throw new AuthError('session token not yet valid');
  if (claims.iss !== issuer) throw new AuthError('token from another Clerk instance');
  if (claims.azp && !allowedParties.includes(claims.azp)) throw new AuthError('token issued for another site');
  if (claims.sts && claims.sts !== 'active') throw new AuthError('session is not active');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('token has no user');
  return claims;
}

/** Clerk's `pla` claim: "u:user_plus" (comma-separated scope:slug). -> user-scope plan slugs */
export function userPlans(claims) {
  const out = [];
  for (const part of String(claims.pla || '').split(',')) {
    const p = part.trim();
    const i = p.indexOf(':');
    if (i < 0) continue;
    const scope = p.slice(0, i);
    if (scope === 'u' || scope === 'ou' || scope === 'uo') out.push(p.slice(i + 1));
  }
  return out;
}

export function resetKeyCache() { jwksCache = { url: null, at: 0, keys: new Map() }; }
