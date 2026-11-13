import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import * as miniflare from "miniflare";
import { vi } from "vitest";
import type { Env, PipelineMessage } from "../src/env";
import worker from "../src/index";

/**
 * Test harness: the real Worker code against real (local) D1 and R2 from
 * Miniflare, with the outside world — Clerk's JWKS, Gemini, Meshy — replaced by
 * a scripted fetch. Queue sends are captured so tests advance jobs explicitly.
 */

export const ISSUER = "https://test-instance.clerk.accounts.dev";
export const PUBLISHABLE_KEY = `pk_test_${Buffer.from("test-instance.clerk.accounts.dev$").toString("base64").replace(/=+$/, "")}`;
export const ORIGIN = "https://kivo.test";
export const RENDER_TOKEN = "render-token-for-tests-0123456789abcdef";

type Handler = (request: Request) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

export interface Harness {
  env: Env;
  sent: { body: PipelineMessage; delaySeconds?: number }[];
  /** Calls to external services, in order: "METHOD url". */
  calls: string[];
  on: (match: string | RegExp, handler: Handler) => void;
  token: (userId: string, claims?: Record<string, unknown>) => Promise<string>;
  request: (path: string, init?: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; raw?: BodyInit }) => Promise<Response>;
  json: <T = any>(path: string, init?: Parameters<Harness["request"]>[1]) => Promise<{ status: number; body: T }>;
  db: D1Database;
  /** The test bucket (also `env.BUCKET` unless a test removes storage). */
  bucket: R2Bucket;
  close: () => Promise<void>;
}

let keys: ReturnType<typeof generateKeyPair> | undefined;

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0001_init.sql"), "utf8");

export async function createHarness(vars: Partial<Env> = {}): Promise<Harness> {
  const options = { modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: "2026-10-01", d1Databases: { DB: "test-db" }, r2Buckets: { BUCKET: "test-bucket" } };
  const convert = (miniflare as unknown as { convertV4MiniflareOptions?: (o: unknown) => unknown }).convertV4MiniflareOptions;
  const mf = new Miniflare((convert ? convert(options) : options) as never);
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const sql = migration
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  for (const statement of sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.prepare(statement).run();

  // One signing key per test process: the Worker caches the instance's JWKS, as it does in production.
  keys ??= generateKeyPair("RS256");
  const { publicKey, privateKey } = await keys;
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  const sent: Harness["sent"] = [];
  const calls: string[] = [];
  const handlers: { match: string | RegExp; handler: Handler }[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    if (request.url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    calls.push(`${request.method} ${request.url}`);
    for (const { match, handler } of [...handlers].reverse()) {
      if (typeof match === "string" ? request.url.includes(match) : match.test(request.url)) {
        const res = await handler(request);
        if (res) return res;
      }
    }
    throw new Error(`Unexpected external request in test: ${request.method} ${request.url}`);
  });

  const r2 = (await mf.getR2Bucket("BUCKET")) as unknown as R2Bucket;
  const env: Env = {
    DB: db,
    BUCKET: r2,
    PIPELINE: {
      async send(body: PipelineMessage, opts?: { delaySeconds?: number }) {
        sent.push({ body, delaySeconds: opts?.delaySeconds });
      },
    } as unknown as Queue<PipelineMessage>,
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    GEMINI_MODELS: "gemini-test",
    GEMINI_API_KEY: "test-gemini-key",
    MESHY_API_KEY: "msy_test",
    CLERK_SECRET_KEY: "sk_test_clerk",
    CLERK_WEBHOOK_SECRET: `whsec_${Buffer.from("webhook-signing-secret-for-tests").toString("base64")}`,
    RENDER_SERVICE_TOKEN: RENDER_TOKEN,
    SIGNING_SECRET: "media-signing-secret-for-tests-0123456789",
    MESHY_DAILY_CREDIT_CEILING: "3000",
    RENDER_QUEUE_TIMEOUT_MINUTES: "30",
    RENDER_QUALITY: "standard",
    ...vars,
  };

  const token: Harness["token"] = (userId, claims = {}) =>
    new SignJWT({ sid: `sess_${userId}`, azp: ORIGIN, sts: "active", v: 2, pla: "u:free_user", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) - 5)
      .setExpirationTime(claims.exp ? (claims.exp as number) : "60s")
      .sign(privateKey);

  const request: Harness["request"] = async (path, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
      headers,
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      ...(init.raw ? { duplex: "half" } : {}),
    } as RequestInit);
    return worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
  };

  return {
    env,
    sent,
    calls,
    db,
    bucket: r2,
    on: (match, handler) => void handlers.push({ match, handler }),
    token,
    request,
    async json(path, init) {
      const res = await request(path, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      vi.unstubAllGlobals();
      await mf.dispose();
    },
  };
}

/** A minimal file that passes Kivo's stored-video check: ISO BMFF with front-loaded moov and an avc1 sample entry. */
export function fakeMp4(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  const put = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset);
  bytes.set([0, 0, 0, 24], 0);
  put(4, "ftypisom");
  put(32, "moov");
  put(120, "avc1");
  put(2000, "mdat");
  return bytes;
}

/** A tiny valid GLB (binary glTF with one mesh and one image) for Meshy download mocks. */
export function fakeGlb(animations: string[] = []): Uint8Array {
  const json = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [] }], images: [{ mimeType: "image/png" }], animations: animations.map((name) => ({ name })) });
  const padded = json + " ".repeat((4 - (json.length % 4)) % 4);
  const out = new Uint8Array(20 + padded.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(new TextEncoder().encode(padded), 20);
  return out;
}

export function geminiReply(data: unknown): Response {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { totalTokenCount: 100 } });
}
