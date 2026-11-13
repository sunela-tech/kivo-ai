import { errorMessage } from "@kivo/shared";

export function now(): number {
  return Date.now();
}

/** Compact, URL-safe, time-sortable id. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let rand = "";
  for (const b of bytes) rand += (b % 36).toString(36);
  return `${prefix}_${time}${rand}`;
}

/** An error that is safe to show to the user: `code` maps to an actionable message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? errorMessage(code));
  }
}

/** A pipeline failure. `retryable` failures are retried with backoff before the job fails. */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/**
 * The R2 bucket, or a clear error when this deployment has no storage.
 * Generation cannot work without it, so it is refused up front instead of failing halfway.
 */
export function bucket(env: { BUCKET?: R2Bucket }): R2Bucket {
  if (!env.BUCKET) throw new HttpError(503, "storage_unavailable");
  return env.BUCKET;
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Remove secrets from anything that might be logged. */
export function redact(text: string): string {
  return text
    .replace(/msy_[A-Za-z0-9]+/g, "msy_***")
    .replace(/sk_(test|live)_[A-Za-z0-9]+/g, "sk_***")
    .replace(/whsec_[A-Za-z0-9+/=]+/g, "whsec_***")
    .replace(/(key=|Bearer\s+)[A-Za-z0-9._-]{12,}/g, "$1***");
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(redact(JSON.stringify({ event, ...fields })));
}

export async function fetchWithTimeout(input: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30000, ...rest } = init;
  return fetch(input, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}
