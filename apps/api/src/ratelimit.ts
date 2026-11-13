import type { Env } from "./env";
import { HttpError } from "./util";

/**
 * Fixed-window rate limiting backed by D1 (atomic upsert-and-count).
 * Protects the expensive endpoints (generation, AI Director) and the API in general.
 */
export async function rateLimit(env: Env, key: string, limit: number, windowSeconds: number): Promise<void> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, bucket, count) VALUES (?, ?, 1) ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, bucket)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    throw new HttpError(429, "internal", `Too many requests. Try again in ${retryAfter} seconds.`, { retryAfter });
  }
}

export async function pruneRateLimits(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000 / 60) - 120;
  await env.DB.prepare("DELETE FROM rate_limits WHERE bucket < ?").bind(cutoff).run();
}
