import { Hono } from "hono";
import type { AppBindings, Env } from "../env";
import { planFromSlug } from "../plans";
import { HttpError, log, now, timingSafeEqual } from "../util";
import { deleteUserData } from "./account";

/**
 * Clerk webhooks (delivered through Svix).
 *
 * Every delivery is verified with the endpoint's signing secret before it is
 * read: HMAC-SHA256 over "id.timestamp.body", constant-time compare, and a
 * five-minute replay window. `svix-id` is stored as the primary key of
 * billing_events, so a redelivered event is acknowledged but applied only once.
 */
export const webhooks = new Hono<AppBindings>();

const TOLERANCE_SECONDS = 5 * 60;

export async function verifySvix(secret: string, headers: Headers, payload: string): Promise<void> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) throw new HttpError(400, "internal", "Missing webhook signature headers.");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) throw new HttpError(400, "internal", "Webhook timestamp is outside the allowed window.");

  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  } catch {
    throw new HttpError(503, "internal", "CLERK_WEBHOOK_SECRET is not a valid signing secret.");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  const ok = signatures.split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && !!value && timingSafeEqual(value, expected);
  });
  if (!ok) throw new HttpError(401, "internal", "Webhook signature does not match.");
}

interface ClerkEvent {
  type: string;
  data: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Pull the paying user and their active plan out of a Clerk Billing payload, tolerating shape differences between event types. */
export function readSubscription(event: ClerkEvent): { userId: string | null; slug: string | null; status: string | null; subscriptionId: string | null; periodEnd: number | null } {
  const data = event.data;
  const payer = (data.payer ?? {}) as Record<string, unknown>;
  const userId = str(payer.user_id) ?? str(data.user_id) ?? str(data.payer_id);
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [data];
  // The active paid item wins; otherwise the active default plan.
  const active = items.filter((i) => str(i.status) === "active" || str(i.status) === "past_due");
  const chosen = active.find((i) => Number(((i.plan ?? {}) as Record<string, unknown>).amount ?? 0) > 0) ?? active[0] ?? items[0];
  const plan = (chosen?.plan ?? {}) as Record<string, unknown>;
  const periodEnd = Number(chosen?.period_end ?? data.period_end ?? 0);
  return {
    userId,
    slug: str(plan.slug) ?? str(chosen?.plan_slug),
    status: str(chosen?.status) ?? str(data.status),
    subscriptionId: str(data.subscription_id) ?? (event.type.startsWith("subscription.") ? str(data.id) : null),
    periodEnd: Number.isFinite(periodEnd) && periodEnd > 0 ? periodEnd : null,
  };
}

async function applyEvent(env: Env, event: ClerkEvent): Promise<string | null> {
  const t = now();
  if (event.type === "user.created" || event.type === "user.updated") {
    const id = str(event.data.id);
    if (!id) return null;
    const emails = Array.isArray(event.data.email_addresses) ? (event.data.email_addresses as Record<string, unknown>[]) : [];
    const primary = emails.find((e) => e.id === event.data.primary_email_address_id) ?? emails[0];
    const name = [str(event.data.first_name), str(event.data.last_name)].filter(Boolean).join(" ") || null;
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, updated_at = excluded.updated_at",
    )
      .bind(id, str(primary?.email_address), name, t, t)
      .run();
    return id;
  }
  if (event.type === "user.deleted") {
    const id = str(event.data.id);
    if (id) await deleteUserData(env, id);
    return id;
  }
  if (event.type.startsWith("subscription.") || event.type.startsWith("subscriptionItem.")) {
    const sub = readSubscription(event);
    if (!sub.userId) return null;
    const ended = ["subscriptionItem.ended", "subscriptionItem.abandoned", "subscriptionItem.incomplete", "subscriptionItem.upcoming"].includes(event.type);
    const plan = planFromSlug(sub.slug);
    if (ended || !plan) return sub.userId; // recorded for history; entitlement is unchanged by these
    const status = event.type.endsWith("pastDue") ? "past_due" : event.type === "subscriptionItem.canceled" ? "active" : (sub.status ?? "active");
    // The signed session claim is authoritative while the user is active; this row is the fallback and the audit trail.
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, plan, status, clerk_plan_slug, clerk_subscription_id, period_end, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'webhook', ?)
       ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, clerk_plan_slug = excluded.clerk_plan_slug,
         clerk_subscription_id = COALESCE(excluded.clerk_subscription_id, subscriptions.clerk_subscription_id), period_end = excluded.period_end, source = 'webhook', updated_at = excluded.updated_at`,
    )
      .bind(sub.userId, plan, status, sub.slug, sub.subscriptionId, sub.periodEnd, t)
      .run();
    return sub.userId;
  }
  if (event.type.startsWith("paymentAttempt.")) {
    const payer = (event.data.payer ?? {}) as Record<string, unknown>;
    return str(payer.user_id) ?? str(event.data.user_id);
  }
  return null;
}

webhooks.post("/clerk", async (c) => {
  if (!c.env.CLERK_WEBHOOK_SECRET) {
    throw new HttpError(503, "internal", "Clerk webhooks are not configured (CLERK_WEBHOOK_SECRET secret is missing).");
  }
  const payload = await c.req.text();
  if (payload.length > 512 * 1024) throw new HttpError(413, "internal", "Webhook payload too large.");
  await verifySvix(c.env.CLERK_WEBHOOK_SECRET, c.req.raw.headers, payload);

  let event: ClerkEvent;
  try {
    event = JSON.parse(payload) as ClerkEvent;
  } catch {
    throw new HttpError(400, "internal", "Webhook payload is not JSON.");
  }
  if (typeof event?.type !== "string" || typeof event.data !== "object" || event.data === null) throw new HttpError(400, "internal", "Unrecognised webhook payload.");

  const id = c.req.header("svix-id")!;
  const first = await c.env.DB.prepare("INSERT INTO billing_events (id, type, user_id, payload, received_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT (id) DO NOTHING")
    .bind(id, event.type.slice(0, 80), payload.slice(0, 100_000), now())
    .run();
  if (first.meta.changes === 0) return c.json({ ok: true, duplicate: true });

  try {
    const userId = await applyEvent(c.env, event);
    if (userId && event.type !== "user.deleted") await c.env.DB.prepare("UPDATE billing_events SET user_id = ? WHERE id = ?").bind(userId, id).run();
  } catch (error) {
    // Let Svix retry: forget the delivery so the retry is processed.
    await c.env.DB.prepare("DELETE FROM billing_events WHERE id = ?").bind(id).run();
    log("webhook_failed", { type: event.type, error: String(error) });
    throw new HttpError(500, "internal", "Webhook processing failed.");
  }
  return c.json({ ok: true });
});
