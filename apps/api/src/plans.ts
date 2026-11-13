import { DEFAULT_CLERK_PLAN_SLUGS, resolvePlans, type PlanId, type PlanLimits } from "@kivo/shared";
import type { Env } from "./env";
import { log, now } from "./util";

let cache: { source: string; plans: Record<PlanId, PlanLimits> } | null = null;

/** Plan limits with operator overrides applied. Invalid overrides are ignored loudly, never half-applied. */
export function getPlans(env: Env): Record<PlanId, PlanLimits> {
  const source = env.KIVO_PLAN_OVERRIDES ?? "";
  if (cache && cache.source === source) return cache.plans;
  let plans: Record<PlanId, PlanLimits>;
  try {
    plans = resolvePlans(source);
  } catch (error) {
    log("plan_overrides_invalid", { error: String(error) });
    plans = resolvePlans("");
  }
  cache = { source, plans };
  return plans;
}

/**
 * Plan from the Clerk session token's `pla` claim ("u:pro"). The claim is inside
 * the JWT Clerk signs, so it cannot be altered by the browser.
 */
export function planFromClaim(claim: string | null | undefined): PlanId | null {
  if (!claim) return null;
  for (const part of claim.split(",")) {
    const [scope, slug] = part.trim().split(":");
    if (scope === "u" && slug && DEFAULT_CLERK_PLAN_SLUGS[slug]) return DEFAULT_CLERK_PLAN_SLUGS[slug]!;
  }
  return null;
}

export function planFromSlug(slug: string | null | undefined): PlanId | null {
  return (slug && DEFAULT_CLERK_PLAN_SLUGS[slug]) || null;
}

/**
 * Resolve the user's plan on the backend:
 *   1. the signed session claim (fresh on every request), else
 *   2. the subscription row maintained by verified Clerk webhooks, else
 *   3. Free.
 * Nothing the browser sends in a request body or header is consulted.
 */
export async function resolveUserPlan(env: Env, userId: string, claim: string | null): Promise<PlanLimits> {
  const plans = getPlans(env);
  const fromClaim = planFromClaim(claim);
  const row = await env.DB.prepare("SELECT plan, status, source FROM subscriptions WHERE user_id = ?").bind(userId).first<{ plan: PlanId; status: string; source: string }>();
  if (fromClaim) {
    if (!row || row.plan !== fromClaim || row.source !== "session") {
      await env.DB.prepare(
        "INSERT INTO subscriptions (user_id, plan, status, source, updated_at) VALUES (?, ?, 'active', 'session', ?) " +
          "ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, status = 'active', source = 'session', updated_at = excluded.updated_at",
      )
        .bind(userId, fromClaim, now())
        .run();
    }
    return plans[fromClaim];
  }
  if (row && plans[row.plan] && (row.status === "active" || row.status === "past_due")) return plans[row.plan];
  return plans.free;
}
