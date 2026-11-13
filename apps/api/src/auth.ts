import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppBindings, Env } from "./env";
import { resolveUserPlan } from "./plans";
import { HttpError, log, now } from "./util";

/**
 * Clerk session verification.
 *
 * Session tokens are RS256 JWTs. They are verified against the instance's JWKS,
 * whose URL comes from our own configuration (derived from the publishable
 * key) — never from the token. `azp` must be an origin we serve.
 */

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function clerkFrontendApi(publishableKey: string): string {
  const encoded = publishableKey.split("_").slice(2).join("_");
  let host: string;
  try {
    host = atob(encoded).replace(/\$$/, "");
  } catch {
    throw new HttpError(503, "internal", "CLERK_PUBLISHABLE_KEY is not a valid Clerk publishable key.");
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    throw new HttpError(503, "internal", "CLERK_PUBLISHABLE_KEY is not a valid Clerk publishable key.");
  }
  return `https://${host}`;
}

function allowedOrigins(env: Env, requestUrl: string): Set<string> {
  const origins = new Set<string>([new URL(requestUrl).origin]);
  for (const o of (env.ALLOWED_ORIGINS ?? "").split(",")) if (o.trim()) origins.add(o.trim().replace(/\/$/, ""));
  return origins;
}

export async function verifySessionToken(env: Env, token: string, requestUrl: string): Promise<JWTPayload> {
  const issuer = clerkFrontendApi(env.CLERK_PUBLISHABLE_KEY);
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    jwksByIssuer.set(issuer, jwks);
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer, algorithms: ["RS256"], clockTolerance: 5 }));
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC" || (error instanceof TypeError && !code)) {
      // Could not reach Clerk to fetch signing keys: an outage on our side, not a bad session.
      log("clerk_jwks_unreachable", { error: error instanceof Error ? error.message : String(error) });
      throw new HttpError(503, "internal", "Sign-in could not be verified right now. Try again in a moment.");
    }
    throw new HttpError(401, "internal", "Your session has expired. Sign in again.");
  }
  if (!payload.sub) throw new HttpError(401, "internal", "Your session is not valid. Sign in again.");
  const azp = typeof payload.azp === "string" ? payload.azp.replace(/\/$/, "") : null;
  if (azp && !allowedOrigins(env, requestUrl).has(azp)) {
    throw new HttpError(401, "internal", "This session was issued for a different site.");
  }
  if ((payload as { sts?: string }).sts === "pending") {
    throw new HttpError(401, "internal", "Finish signing in to continue.");
  }
  return payload;
}

/** Requires a valid Clerk session; loads the user row and their plan (from the signed claim). */
export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "internal", "Sign in to use Kivo.");
  const payload = await verifySessionToken(c.env, token, c.req.url);
  const userId = payload.sub!;
  const planClaim = typeof (payload as { pla?: unknown }).pla === "string" ? ((payload as { pla?: string }).pla as string) : null;

  const t = now();
  await c.env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING").bind(userId, t, t).run();
  c.set("user", { id: userId, planClaim });
  c.set("plan", await resolveUserPlan(c.env, userId, planClaim));
  await next();
};
