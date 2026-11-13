import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe("authentication", () => {
  it("rejects requests without a session", async () => {
    const { status, body } = await h.json("/api/me");
    expect(status).toBe(401);
    expect(body.error.message).toMatch(/sign in/i);
  });

  it("accepts a valid Clerk session token and creates the user", async () => {
    const { status, body } = await h.json("/api/me", { token: await h.token("user_alice") });
    expect(status).toBe(200);
    expect(body.user).toMatchObject({ id: "user_alice", preferredMode: "simple", onboarded: false });
    expect(body.plan.id).toBe("free");
    expect(body.usage).toMatchObject({ used: 0, limit: 3, remaining: 3 });
  });

  it("rejects expired, forged and foreign-origin tokens", async () => {
    const expired = await h.token("user_alice", { exp: Math.floor(Date.now() / 1000) - 120 });
    expect((await h.request("/api/me", { token: expired })).status).toBe(401);

    const valid = await h.token("user_alice");
    const [head, payload] = valid.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sub: "user_victim" })).toString("base64url");
    expect((await h.request("/api/me", { token: `${head}.${forgedPayload}.${valid.split(".")[2]}` })).status).toBe(401);

    const elsewhere = await h.token("user_alice", { azp: "https://evil.example" });
    expect((await h.request("/api/me", { token: elsewhere })).status).toBe(401);
    expect((await h.request("/api/me", { token: "not-a-jwt" })).status).toBe(401);
  });

  it("takes the plan from the signed claim, never from the request", async () => {
    const pro = await h.token("user_bob", { pla: "u:pro" });
    const me = await h.json("/api/me", { token: pro });
    expect(me.body.plan).toMatchObject({ id: "pro", videosPerMonth: 30, maxResolution: "720p", watermark: false });

    // A browser claiming a bigger plan in a header or body changes nothing.
    const free = await h.token("user_carol");
    const lied = await h.json("/api/me", { token: free, headers: { "x-plan": "studio" } });
    expect(lied.body.plan.id).toBe("free");
    const project = await h.json("/api/projects", { token: free, body: { prompt: "a robot", plan: "studio", resolution: "4k", duration: 180 } });
    expect(project.status).toBe(201);
    const started = await h.json(`/api/projects/${project.body.project.id}/generate`, { token: free, body: { render: true, plan: "studio" } });
    expect(started.status).toBe(202);
    const job = await h.db.prepare("SELECT plan, params FROM jobs WHERE id = ?").bind(started.body.job.id).first<{ plan: string; params: string }>();
    expect(job!.plan).toBe("free");
    expect(JSON.parse(job!.params)).toMatchObject({ duration: 5, fps: 24, resolution: "480p" });
  });

  it("falls back to the webhook-maintained subscription when the token has no plan claim", async () => {
    const t = Date.now();
    await h.db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES ('user_dave', ?, ?)").bind(t, t).run();
    await h.db.prepare("INSERT INTO subscriptions (user_id, plan, status, source, updated_at) VALUES ('user_dave', 'ultra', 'active', 'webhook', ?)").bind(t).run();
    const me = await h.json("/api/me", { token: await h.token("user_dave", { pla: undefined }) });
    expect(me.body.plan.id).toBe("ultra");
  });

  it("exposes every creative tool on every plan", async () => {
    const { body } = await h.json("/api/config");
    expect(body.plans.map((p: { id: string }) => p.id)).toEqual(["free", "pro", "ultra", "studio"]);
    for (const plan of body.plans) {
      expect(plan).toMatchObject({ simpleMode: true, advancedMode: true, editor: true, animationEditor: true, cameraEditor: true, aiDirector: true });
    }
    expect(body.stages).toHaveLength(12);
  });

  it("remembers the preferred mode for any plan", async () => {
    const token = await h.token("user_alice");
    expect((await h.request("/api/me", { method: "PATCH", token, body: { preferredMode: "advanced", onboarded: true } })).status).toBe(200);
    const me = await h.json("/api/me", { token });
    expect(me.body.user).toMatchObject({ preferredMode: "advanced", onboarded: true });
    expect(me.body.plan.id).toBe("free");
  });

  it("reports which integrations are configured without revealing secrets", async () => {
    const res = await h.request("/api/health");
    const text = await res.text();
    expect(JSON.parse(text).configured).toMatchObject({ gemini: true, meshy: true, renderService: true });
    expect(text).not.toContain("msy_test");
    expect(text).not.toContain("sk_test_clerk");
  });
});
