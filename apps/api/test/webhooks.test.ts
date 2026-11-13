import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const SECRET = Buffer.from("webhook-signing-secret-for-tests");

function signed(payload: unknown, opts: { id?: string; timestamp?: number; secret?: Buffer } = {}) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", opts.secret ?? SECRET).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { raw: body, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}`, "content-type": "application/json" } };
}

const post = (req: ReturnType<typeof signed>) => h.request("/api/webhooks/clerk", { method: "POST", raw: req.raw, headers: req.headers });

describe("Clerk webhooks", () => {
  it("rejects unsigned, wrongly signed and replayed deliveries", async () => {
    const event = { type: "subscriptionItem.active", data: { status: "active", plan: { slug: "studio", amount: 6900 }, payer: { user_id: "user_attacker" } } };
    expect((await h.request("/api/webhooks/clerk", { method: "POST", raw: JSON.stringify(event), headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await post(signed(event, { secret: Buffer.from("someone-elses-secret") }))).status).toBe(401);
    expect((await post(signed(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(400);
    // A valid signature over a different body does not transfer.
    const good = signed(event);
    expect((await h.request("/api/webhooks/clerk", { method: "POST", raw: good.raw.replace("user_attacker", "user_victim"), headers: good.headers })).status).toBe(401);
    const row = await h.db.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("records a verified subscription change once, even if delivered twice", async () => {
    const event = { type: "subscriptionItem.active", data: { id: "csubi_1", status: "active", plan: { slug: "pro", amount: 900 }, payer: { user_id: "user_paid" }, period_end: 1800000000000 } };
    const delivery = signed(event, { id: "msg_fixed" });
    expect((await post(delivery)).status).toBe(200);
    const again = await post(signed(event, { id: "msg_fixed" }));
    expect(await again.json()).toEqual({ ok: true, duplicate: true });

    const sub = await h.db.prepare("SELECT plan, status, clerk_plan_slug, source FROM subscriptions WHERE user_id = 'user_paid'").first();
    expect(sub).toEqual({ plan: "pro", status: "active", clerk_plan_slug: "pro", source: "webhook" });
    const events = await h.db.prepare("SELECT type, user_id FROM billing_events WHERE id = 'msg_fixed'").all();
    expect(events.results).toEqual([{ type: "subscriptionItem.active", user_id: "user_paid" }]);

    // With no plan claim in the session, the backend uses this record.
    const me = await h.json("/api/me", { token: await h.token("user_paid", { pla: undefined }) });
    expect(me.body.plan.id).toBe("pro");
  });

  it("reads the active paid item from a subscription event and marks past-due", async () => {
    const event = {
      type: "subscription.updated",
      data: {
        id: "csub_9",
        status: "active",
        payer: { user_id: "user_multi" },
        items: [
          { status: "ended", plan: { slug: "pro", amount: 900 } },
          { status: "active", plan: { slug: "free_user", amount: 0 } },
          { status: "active", plan: { slug: "ultra", amount: 2500 } },
        ],
      },
    };
    expect((await post(signed(event))).status).toBe(200);
    expect((await h.db.prepare("SELECT plan FROM subscriptions WHERE user_id = 'user_multi'").first<{ plan: string }>())!.plan).toBe("ultra");

    await post(signed({ type: "subscriptionItem.pastDue", data: { status: "past_due", plan: { slug: "ultra", amount: 2500 }, payer: { user_id: "user_multi" } } }));
    expect((await h.db.prepare("SELECT status FROM subscriptions WHERE user_id = 'user_multi'").first<{ status: string }>())!.status).toBe("past_due");
  });

  it("ignores plans it does not know instead of granting anything", async () => {
    await post(signed({ type: "subscriptionItem.active", data: { status: "active", plan: { slug: "enterprise_unlimited", amount: 1 }, payer: { user_id: "user_unknown" } } }));
    expect(await h.db.prepare("SELECT plan FROM subscriptions WHERE user_id = 'user_unknown'").first()).toBeNull();
    expect((await h.json("/api/me", { token: await h.token("user_unknown", { pla: "u:enterprise_unlimited" }) })).body.plan.id).toBe("free");
  });

  it("stores profile updates and erases everything when Clerk says the user was deleted", async () => {
    await post(signed({ type: "user.created", data: { id: "user_gone", first_name: "Ada", last_name: "L", primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: "ada@example.com" }] } }));
    expect(await h.db.prepare("SELECT email, display_name FROM users WHERE id = 'user_gone'").first()).toEqual({ email: "ada@example.com", display_name: "Ada L" });

    const token = await h.token("user_gone");
    await h.json("/api/projects", { token, body: { prompt: "something private" } });
    await h.bucket.put("users/user_gone/videos/v.mp4", "x");
    expect((await post(signed({ type: "user.deleted", data: { id: "user_gone", deleted: true } }))).status).toBe(200);
    expect(await h.db.prepare("SELECT id FROM users WHERE id = 'user_gone'").first()).toBeNull();
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = 'user_gone'").first<{ n: number }>())!.n).toBe(0);
    expect(await h.bucket.head("users/user_gone/videos/v.mp4")).toBeNull();
  });

  it("refuses to run without a configured signing secret", async () => {
    const bare = await createHarness({ CLERK_WEBHOOK_SECRET: undefined });
    const res = await bare.request("/api/webhooks/clerk", { method: "POST", raw: "{}", headers: {} });
    expect(res.status).toBe(503);
    await bare.close();
  });
});
