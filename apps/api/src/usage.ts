import { usagePeriod, type PlanLimits } from "@kivo/shared";
import type { Env } from "./env";
import { newId, now, utcDay } from "./util";

/**
 * Quota accounting.
 *
 * usage_events is an append-only ledger. A job reserves one video when it is
 * created and is refunded if it fails or is canceled. Both writes are guarded:
 *   - the reserve is a single INSERT … SELECT … WHERE used < limit, so two
 *     simultaneous requests cannot both take the last video;
 *   - UNIQUE (job_id, kind) makes reserve and refund idempotent, so retries,
 *     duplicate queue deliveries and repeated failures never double-charge or
 *     double-refund.
 */

const USED_SQL =
  "(SELECT COALESCE(SUM(CASE kind WHEN 'reserve' THEN units ELSE -units END), 0) FROM usage_events WHERE user_id = ?1 AND period = ?2)";

export async function usedThisPeriod(env: Env, userId: string, period = usagePeriod()): Promise<number> {
  const row = await env.DB.prepare(`SELECT ${USED_SQL} AS used`).bind(userId, period).first<{ used: number }>();
  return row?.used ?? 0;
}

/** Atomically reserve one video for a job. Returns false when the monthly quota is used up. */
export async function reserveVideo(env: Env, userId: string, jobId: string, plan: PlanLimits, reason: string): Promise<boolean> {
  const period = usagePeriod();
  const result = await env.DB.prepare(
    `INSERT INTO usage_events (id, user_id, job_id, kind, units, period, reason, created_at)
     SELECT ?3, ?1, ?4, 'reserve', 1, ?2, ?5, ?6 WHERE ${USED_SQL} < ?7
     ON CONFLICT (job_id, kind) DO NOTHING`,
  )
    .bind(userId, period, newId("use"), jobId, reason, now(), plan.videosPerMonth)
    .run();
  if (result.meta.changes > 0) return true;
  // Already reserved for this job (idempotent retry) counts as success.
  const existing = await env.DB.prepare("SELECT 1 AS ok FROM usage_events WHERE job_id = ? AND kind = 'reserve'").bind(jobId).first();
  return !!existing;
}

/** Give the video back. Safe to call any number of times; only the first has an effect. */
export async function refundVideo(env: Env, jobId: string, reason: string): Promise<boolean> {
  const reserve = await env.DB.prepare("SELECT user_id, period, units FROM usage_events WHERE job_id = ? AND kind = 'reserve'")
    .bind(jobId)
    .first<{ user_id: string; period: string; units: number }>();
  if (!reserve) return false;
  const result = await env.DB.prepare(
    "INSERT INTO usage_events (id, user_id, job_id, kind, units, period, reason, created_at) VALUES (?, ?, ?, 'refund', ?, ?, ?, ?) ON CONFLICT (job_id, kind) DO NOTHING",
  )
    .bind(newId("use"), reserve.user_id, jobId, reserve.units, reserve.period, reason, now())
    .run();
  return result.meta.changes > 0;
}

export async function recordCost(env: Env, userId: string, jobId: string | null, provider: "meshy" | "gemini" | "render", units: number, detail: string): Promise<void> {
  if (units <= 0) return;
  await env.DB.prepare("INSERT INTO cost_events (id, user_id, job_id, provider, units, detail, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("cost"), userId, jobId, provider, Math.round(units), detail.slice(0, 200), utcDay(), now())
    .run();
}

export async function meshySpend(env: Env, userId: string): Promise<{ userToday: number; globalToday: number }> {
  const day = utcDay();
  const [user, global] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(units), 0) AS n FROM cost_events WHERE user_id = ? AND provider = 'meshy' AND day = ?").bind(userId, day).first<{ n: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(units), 0) AS n FROM cost_events WHERE provider = 'meshy' AND day = ?").bind(day).first<{ n: number }>(),
  ]);
  return { userToday: user?.n ?? 0, globalToday: global?.n ?? 0 };
}

export function globalMeshyCeiling(env: Env): number {
  const n = Number(env.MESHY_DAILY_CREDIT_CEILING ?? "3000");
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

export interface UsageSummary {
  period: string;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

export async function usageSummary(env: Env, userId: string, plan: PlanLimits): Promise<UsageSummary> {
  const period = usagePeriod();
  const used = await usedThisPeriod(env, userId, period);
  const d = new Date();
  const resetsAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { period, used, limit: plan.videosPerMonth, remaining: Math.max(0, plan.videosPerMonth - used), resetsAt };
}
