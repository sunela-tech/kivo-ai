import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PLANS } from "@kivo/shared";
import { cancelJob, failJob, loadJob } from "../src/pipeline/jobs";
import { refundVideo, reserveVideo, usedThisPeriod } from "../src/usage";
import { createHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function newProject(token: string, prompt = "a robot walks through a city") {
  const res = await h.json("/api/projects", { token, body: { prompt } });
  expect(res.status).toBe(201);
  return res.body.project.id as string;
}

describe("monthly quota", () => {
  it("lets Free users start exactly 3 videos, then stops them with an actionable error", async () => {
    const token = await h.token("user_quota");
    const jobs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await h.json(`/api/projects/${await newProject(token)}/generate`, { token, body: {} });
      expect(res.status).toBe(202);
      expect(res.body.usage.used).toBe(i + 1);
      jobs.push(res.body.job.id);
      // Finish the job so the concurrency limit (1 on Free) does not interfere with this test.
      await h.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").bind(res.body.job.id).run();
    }
    const blocked = await h.json(`/api/projects/${await newProject(token)}/generate`, { token, body: {} });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe("quota_exceeded");
    expect(blocked.body.error.message).toMatch(/3 videos/);
    expect(blocked.body.error.usage).toMatchObject({ used: 3, remaining: 0 });
    // The rejected attempt left nothing behind.
    const count = await h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = 'user_quota'").first<{ n: number }>();
    expect(count!.n).toBe(3);
  });

  it("refunds a failed job exactly once", async () => {
    const token = await h.token("user_refund");
    const started = await h.json(`/api/projects/${await newProject(token)}/generate`, { token, body: {} });
    expect(await usedThisPeriod(h.env, "user_refund")).toBe(1);

    const job = (await loadJob(h.env, started.body.job.id))!;
    await failJob(h.env, job, "meshy_failed");
    await failJob(h.env, (await loadJob(h.env, job.id))!, "meshy_failed"); // duplicate delivery
    await failJob(h.env, job, "render_failed"); // stale copy of the row
    expect(await refundVideo(h.env, job.id, "again")).toBe(false);
    expect(await usedThisPeriod(h.env, "user_refund")).toBe(0);

    const events = await h.db.prepare("SELECT kind FROM usage_events WHERE job_id = ? ORDER BY created_at").bind(job.id).all<{ kind: string }>();
    expect(events.results.map((e) => e.kind)).toEqual(["reserve", "refund"]);
    const row = await loadJob(h.env, job.id);
    expect(row).toMatchObject({ status: "failed", error_code: "meshy_failed" });
    expect(row!.error_message).toMatch(/not charged/i);
  });

  it("refunds a canceled job and never charges twice for one job", async () => {
    const token = await h.token("user_cancel");
    const started = await h.json(`/api/projects/${await newProject(token)}/generate`, { token, body: {} });
    const jobId = started.body.job.id as string;
    // A retried reservation for the same job is a no-op.
    expect(await reserveVideo(h.env, "user_cancel", jobId, DEFAULT_PLANS.free, "retry")).toBe(true);
    expect(await usedThisPeriod(h.env, "user_cancel")).toBe(1);

    await cancelJob(h.env, (await loadJob(h.env, jobId))!);
    expect(await usedThisPeriod(h.env, "user_cancel")).toBe(0);
    expect((await loadJob(h.env, jobId))!.status).toBe("canceled");
  });

  it("cannot be raced past the limit", async () => {
    const t = Date.now();
    await h.db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES ('user_race', ?, ?)").bind(t, t).run();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveVideo(h.env, "user_race", `job_race_${i}`, DEFAULT_PLANS.free, "race")));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await usedThisPeriod(h.env, "user_race")).toBe(3);
  });

  it("enforces concurrent jobs per plan", async () => {
    const free = await h.token("user_conc_free");
    expect((await h.json(`/api/projects/${await newProject(free)}/generate`, { token: free, body: {} })).status).toBe(202);
    const second = await h.json(`/api/projects/${await newProject(free)}/generate`, { token: free, body: {} });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("concurrency_exceeded");
    // The blocked attempt was not charged.
    expect(await usedThisPeriod(h.env, "user_conc_free")).toBe(1);

    const pro = await h.token("user_conc_pro", { pla: "u:pro" });
    expect((await h.json(`/api/projects/${await newProject(pro)}/generate`, { token: pro, body: {} })).status).toBe(202);
    expect((await h.json(`/api/projects/${await newProject(pro)}/generate`, { token: pro, body: {} })).status).toBe(202);
    expect((await h.json(`/api/projects/${await newProject(pro)}/generate`, { token: pro, body: {} })).status).toBe(429);
  });

  it("lets a user cancel a job and get the video back", async () => {
    const token = await h.token("user_cancel_api");
    const started = await h.json(`/api/projects/${await newProject(token)}/generate`, { token, body: {} });
    const canceled = await h.json(`/api/jobs/${started.body.job.id}/cancel`, { token, method: "POST" });
    expect(canceled.status).toBe(200);
    // A queue message was sent so the pipeline can stop cleanly.
    expect(h.sent.some((m) => m.body.jobId === started.body.job.id)).toBe(true);
    const { advanceJob } = await import("../src/pipeline/run");
    await advanceJob(h.env, started.body.job.id);
    const job = await h.json(`/api/jobs/${started.body.job.id}`, { token });
    expect(job.body.job).toMatchObject({ status: "canceled" });
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("rate-limits generation requests", async () => {
    const token = await h.token("user_rate", { pla: "u:studio" });
    const id = await newProject(token);
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await h.request(`/api/projects/${id}/generate`, { token, body: {} });
      if (res.status === 429 && (await res.json() as { error: { message: string } }).error.message.includes("Too many requests")) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(2);
  });
});

describe("private data", () => {
  it("never lets one user see or change another user's project", async () => {
    const alice = await h.token("user_alice");
    const mallory = await h.token("user_mallory");
    const id = await newProject(alice, "alice's secret film");

    for (const [method, path, body] of [
      ["GET", `/api/projects/${id}`, undefined],
      ["PATCH", `/api/projects/${id}`, { title: "mine now" }],
      ["DELETE", `/api/projects/${id}`, undefined],
      ["GET", `/api/projects/${id}/scene`, undefined],
      ["PUT", `/api/projects/${id}/scene`, { spec: {} }],
      ["POST", `/api/projects/${id}/generate`, {}],
      ["POST", `/api/projects/${id}/render`, {}],
      ["POST", `/api/projects/${id}/duplicate`, undefined],
      ["POST", `/api/projects/${id}/director`, { instruction: "make it mine" }],
      ["GET", `/api/projects/${id}/videos`, undefined],
    ] as const) {
      const res = await h.request(path, { method, token: mallory, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const list = await h.json("/api/projects", { token: mallory });
    expect(list.body.projects).toEqual([]);
    const still = await h.json(`/api/projects/${id}`, { token: alice });
    expect(still.body.project.title).not.toBe("mine now");
  });

  it("serves media only through valid, unexpired signatures", async () => {
    const key = "users/user_alice/videos/demo.mp4";
    await h.bucket.put(key, new Uint8Array(1000).fill(7), { httpMetadata: { contentType: "video/mp4" } });
    const { mediaUrl } = await import("../src/dto");
    const url = (await mediaUrl(h.env, key))!;

    const ok = await h.request(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    expect((await ok.arrayBuffer()).byteLength).toBe(1000);

    // Seeking works (Range), and nothing is served without the signature.
    const ranged = await h.request(url, { headers: { range: "bytes=100-199" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const path = url.split("?")[0]!;
    const params = new URLSearchParams(url.split("?")[1]);
    expect((await h.request(path)).status).toBe(401);
    expect((await h.request(`${path}?e=${params.get("e")}&s=${params.get("s")!.slice(0, -2)}xx`)).status).toBe(401);
    expect((await h.request(`${path}?e=${Number(params.get("e")) + 9999}&s=${params.get("s")}`)).status).toBe(401);
    expect((await h.request(`${path}?e=1&s=${params.get("s")}`)).status).toBe(401);
    // A signature for one object does not open another.
    const other = btoa("users/user_bob/videos/private.mp4").replace(/=+$/, "");
    expect((await h.request(`/api/media/o/${other}?e=${params.get("e")}&s=${params.get("s")}`)).status).toBe(401);
  });

  it("deletes a project together with its videos and unshared models", async () => {
    const token = await h.token("user_deleter");
    const id = await newProject(token);
    const t = Date.now();
    await h.bucket.put("users/user_deleter/videos/r1.mp4", "video");
    await h.bucket.put("users/user_deleter/assets/ast_only/model.glb", "glb");
    await h.bucket.put("users/user_deleter/assets/ast_shared/model.glb", "glb");
    await h.db.batch([
      h.db.prepare("INSERT INTO videos (id, project_id, user_id, render_job_id, scene_id, r2_key, bytes, duration, width, height, fps, codec, created_at) VALUES ('vid_1', ?, 'user_deleter', 'r1', 's1', 'users/user_deleter/videos/r1.mp4', 5, 5, 854, 480, 24, 'h264', ?)").bind(id, t),
      h.db.prepare("INSERT INTO assets (id, user_id, cache_key, name, kind, prompt, ai_model, spec, status, created_at, updated_at, last_used_at) VALUES ('ast_only', 'user_deleter', 'k1', 'Only', 'prop', 'p', 'meshy-6-lite', '{}', 'ready', ?, ?, ?)").bind(t, t, t),
      h.db.prepare("INSERT INTO assets (id, user_id, cache_key, name, kind, prompt, ai_model, spec, status, created_at, updated_at, last_used_at) VALUES ('ast_shared', 'user_deleter', 'k2', 'Shared', 'prop', 'p', 'meshy-6-lite', '{}', 'ready', ?, ?, ?)").bind(t, t, t),
      h.db.prepare("INSERT INTO project_assets (project_id, alias, asset_id) VALUES (?, 'only', 'ast_only'), (?, 'shared', 'ast_shared'), ('prj_other', 'shared', 'ast_shared')").bind(id, id),
    ]);

    expect((await h.request(`/api/projects/${id}`, { method: "DELETE", token })).status).toBe(200);
    expect(await h.bucket.head("users/user_deleter/videos/r1.mp4")).toBeNull();
    expect(await h.bucket.head("users/user_deleter/assets/ast_only/model.glb")).toBeNull();
    expect(await h.bucket.head("users/user_deleter/assets/ast_shared/model.glb")).not.toBeNull();
    const left = await h.db.prepare("SELECT id FROM assets WHERE user_id = 'user_deleter'").all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(["ast_shared"]);
    expect((await h.json(`/api/projects/${id}`, { token })).status).toBe(404);
  });

  it("deletes the whole account: files, rows, and the Clerk user", async () => {
    const token = await h.token("user_leaving");
    await newProject(token);
    await h.bucket.put("users/user_leaving/videos/a.mp4", "x");
    await h.bucket.put("users/user_leaving/assets/ast_z/model.glb", "x");
    await h.bucket.put("users/user_staying/videos/a.mp4", "x");
    let clerkDelete = "";
    h.on("api.clerk.com/v1/users/", (req) => {
      clerkDelete = `${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization")}`;
      return Response.json({ deleted: true });
    });

    const res = await h.json("/api/account", { method: "DELETE", token });
    expect(res.body).toEqual({ deleted: true, clerkDeleted: true });
    expect(clerkDelete).toBe("DELETE /v1/users/user_leaving Bearer sk_test_clerk");
    expect(await h.bucket.head("users/user_leaving/videos/a.mp4")).toBeNull();
    expect(await h.bucket.head("users/user_leaving/assets/ast_z/model.glb")).toBeNull();
    expect(await h.bucket.head("users/user_staying/videos/a.mp4")).not.toBeNull();
    for (const table of ["users", "projects", "jobs", "usage_events"]) {
      const column = table === "users" ? "id" : "user_id";
      const row = await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 'user_leaving'`).first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
  });
});

describe("a deployment without file storage", () => {
  it("says so, and refuses generation before creating or charging anything", async () => {
    const bare = await createHarness({ BUCKET: undefined });
    const token = await bare.token("user_nostorage");

    const health = await bare.json("/api/health");
    expect(health.body.configured.storage).toBe(false);
    expect((await bare.json("/api/config")).body.storageReady).toBe(false);

    // Everything that does not need files still works.
    expect((await bare.json("/api/me", { token })).status).toBe(200);
    const project = await bare.json("/api/projects", { token, body: { prompt: "a robot walks through a city" } });
    expect(project.status).toBe(201);

    const started = await bare.json(`/api/projects/${project.body.project.id}/generate`, { token, body: {} });
    expect(started.status).toBe(503);
    expect(started.body.error.code).toBe("storage_unavailable");
    expect(started.body.error.message).toMatch(/Cloudflare R2 is not enabled/);
    expect(started.body.error.message).toMatch(/Nothing was charged/);
    expect((await bare.db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n).toBe(0);
    expect((await bare.json("/api/me", { token })).body.usage.used).toBe(0);
    expect(bare.sent).toHaveLength(0);

    // Deleting still works: there are simply no files to remove.
    expect((await bare.request(`/api/projects/${project.body.project.id}`, { method: "DELETE", token })).status).toBe(200);
    await bare.close();
  });

  it("reports storage as ready when the bucket is bound", async () => {
    expect((await h.json("/api/health")).body.configured.storage).toBe(true);
    expect((await h.json("/api/config")).body.storageReady).toBe(true);
  });
});
