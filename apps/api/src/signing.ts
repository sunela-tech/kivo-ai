import type { Env } from "./env";
import { HttpError, timingSafeEqual } from "./util";

/**
 * Signed, expiring media URLs.
 *
 * <video> and GLTF loaders cannot send an Authorization header, so authenticated
 * API responses hand out short-lived HMAC-signed links instead. A link is bound
 * to one resource path and expires; nothing in the bucket is public.
 */

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function secretOf(env: Env): string {
  if (!env.SIGNING_SECRET || env.SIGNING_SECRET.length < 16) {
    throw new HttpError(503, "internal", "Media signing is not configured (SIGNING_SECRET secret is missing).");
  }
  return env.SIGNING_SECRET;
}

export const MEDIA_TTL_SECONDS = 60 * 60;

/** Sign a media path such as `/api/media/video/vid_123`. */
export async function signPath(env: Env, path: string, ttlSeconds = MEDIA_TTL_SECONDS, query: Record<string, string> = {}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmac(secretOf(env), `${path}\n${exp}`);
  const params = new URLSearchParams({ ...query, e: String(exp), s: sig });
  return `${path}?${params.toString()}`;
}

export async function verifySignedPath(env: Env, path: string, exp: string | undefined, sig: string | undefined): Promise<void> {
  const expiry = Number(exp);
  if (!sig || !Number.isFinite(expiry)) throw new HttpError(401, "internal", "This link is missing its signature.");
  if (expiry < Date.now() / 1000) throw new HttpError(401, "internal", "This link has expired. Reload the page to get a fresh one.");
  const expected = await hmac(secretOf(env), `${path}\n${expiry}`);
  if (!timingSafeEqual(expected, sig)) throw new HttpError(401, "internal", "This link's signature is not valid.");
}
