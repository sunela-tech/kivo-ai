import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeScene, type SceneSpec } from "@kivo/shared";
import { saveScene } from "../src/pipeline/jobs";
import { sweep } from "../src/pipeline/render";
import { advanceJob } from "../src/pipeline/run";
import { RENDER_TOKEN, createHarness, fakeMp4, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const auth = { authorization: `Bearer ${RENDER_TOKEN}` };

/** A 20-second, 60 fps, multi-camera scene: more than a Free export allows, which is exactly the point. */
function bigScene(): SceneSpec {
  return normalizeScene({
    version: 1,
    title: "Big scene",
    output: { duration: 20, fps: 60, aspect: "16:9" },
    world: {},
    assets: [{ id: "hero", name: "Hero", kind: "prop", prompt: "a statue", rig: "none", size: { meters: 2, axis: "height" } }],
    objects: [{ id: "hero_1", assetId: "hero", name: "Hero", position: [0, 0, 0] }],
    lights: [
      { id: "sun", name: "Sun", type: "sun", intensity: 3, position: [5, 10, 5] },
      { id: "rim", name: "Rim", type: "spot", intensity: 900, position: [-3, 4, -3] },
    ],
    cameras: [
      { id: "cam_a", name: "A", keyframes: [{ t: 0, position: [0, 2, -8], target: [0, 1, 0] }] },
      { id: "cam_b", name: "B", keyframes: [{ t: 0, position: [6, 2, 0], target: [0, 1, 0] }, { t: 20, position: [0, 2, 6], target: [0, 1, 0] }] },
      { id: "cam_c", name: "C", attach: { mode: "follow", objectId: "hero_1" }, keyframes: [{ t: 0, position: [0, 1, -3], target: [0, 1, 0] }] },
    ],
    shots: [
      { id: "s1", cameraId: "cam_a", start: 0, end: 8 },
      { id: "s2", cameraId: "cam_b", start: 8, end: 14, transition: "dissolve", transitionDuration: 0.5 },
      { id: "s3", cameraId: "cam_c", start: 14, end: 20, transition: "fade", transitionDuration: 0.4 },
    ],
    tracks: [{ id: "hero_move", type: "transform", objectId: "hero_1", keyframes: [{ t: 0, position: [0, 0, 0] }, { t: 20, position: [0, 0, 10] }] }],
  }).spec;
}

async function projectWithScene(userId: string, plan: string) {
  const token = await h.token(userId, { pla: `u:${plan}` });
  const created = await h.json("/api/projects", { token, body: { prompt: "a statue", resolution: "480p" } });
  const projectId = created.body.project.id as string;
  const t = Date.now();
  const assetId = `ast_${userId}`;
  await h.bucket.put(`users/${userId}/assets/${assetId}/model.glb`, "glb-bytes", { httpMetadata: { contentType: "model/gltf-binary" } });
  await h.db.batch([
    h.db.prepare("INSERT INTO assets (id, user_id, cache_key, name, kind, prompt, ai_model, spec, status, model_key, created_at, updated_at, last_used_at) VALUES (?, ?, ?, 'Hero', 'prop', 'a statue', 'meshy-6-lite', '{}', 'ready', ?, ?, ?, ?)").bind(assetId, userId, `key_${userId}`, `users/${userId}/assets/${assetId}/model.glb`, t, t, t),
    h.db.prepare("INSERT INTO project_assets (project_id, alias, asset_id) VALUES (?, 'hero', ?)").bind(projectId, assetId),
  ]);
  return { token, projectId, assetId };
}

async function startRender(token: string, projectId: string, resolution = "4k") {
  const res = await h.json(`/api/projects/${projectId}/render`, { token, body: { resolution } });
  expect(res.status).toBe(202);
  await advanceJob(h.env, res.body.job.id);
  return res.body.job.id as string;
}

const claim = (workerId = "worker-1") => h.json("/api/render/claim", { headers: auth, body: { workerId } });

describe("advanced editing is never plan-gated; exports are", () => {
  it("lets a Free user save a long, multi-camera scene", async () => {
    const { token, projectId } = await projectWithScene("user_free_editor", "free_user");
    const saved = await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    expect(saved.status).toBe(200);
    expect(saved.body.spec.output).toMatchObject({ duration: 20, fps: 60 });
    expect(saved.body.spec.cameras).toHaveLength(3);
    expect(saved.body.spec.lights).toHaveLength(2);
    expect(saved.body.spec.shots).toHaveLength(3);
  });

  it("clamps a Free export to 5 s, 24 fps, 480p with a watermark", async () => {
    const { token, projectId } = await projectWithScene("user_free_render", "free_user");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "4k");
    const job = await h.json(`/api/jobs/${jobId}`, { token });
    expect(job.body.job.stage).toBe("preparing_rendering");
    expect(job.body.job.warnings.join(" ")).toMatch(/Duration limited to 5s/);
    expect(job.body.job.warnings.join(" ")).toMatch(/Frame rate limited to 24/);

    const claimed = await claim();
    expect(claimed.status).toBe(200);
    expect(claimed.body.settings).toMatchObject({ width: 854, height: 480, fps: 24, duration: 5, watermark: true });
    // The scene handed to Blender is trimmed to what will be exported.
    expect(claimed.body.scene.output).toMatchObject({ duration: 5, fps: 24 });
    expect(claimed.body.scene.shots.at(-1).end).toBe(5);
    expect(claimed.body.assets.hero.files["model.glb"].url).toMatch(/\/api\/render\/jobs\/rnd_.*\/files\/ast_user_free_render\/model\.glb$/);
    await h.json(`/api/render/jobs/${claimed.body.renderJobId}/fail`, { headers: auth, body: { workerId: "worker-1", code: "render_failed", message: "test cleanup", retryable: false } });
  });

  it("gives a Studio user the full export with no watermark", async () => {
    const { token, projectId } = await projectWithScene("user_studio_render", "studio");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    await startRender(token, projectId, "4k");
    const claimed = await claim();
    expect(claimed.body.settings).toMatchObject({ width: 3840, height: 2160, fps: 60, duration: 20, watermark: false });
    await h.json(`/api/render/jobs/${claimed.body.renderJobId}/fail`, { headers: auth, body: { workerId: "worker-1", code: "render_failed", message: "test cleanup", retryable: false } });
  });
});

describe("render service protocol", () => {
  it("requires the render token", async () => {
    expect((await h.request("/api/render/claim", { body: { workerId: "w" } })).status).toBe(401);
    expect((await h.request("/api/render/claim", { body: { workerId: "w" }, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    // A user session is not a render token.
    expect((await h.request("/api/render/claim", { body: { workerId: "w" }, token: await h.token("user_x") })).status).toBe(401);
  });

  it("hands out higher-priority plans first", async () => {
    const free = await projectWithScene("user_prio_free", "free_user");
    const studio = await projectWithScene("user_prio_studio", "studio");
    const pro = await projectWithScene("user_prio_pro", "pro");
    for (const p of [free, studio, pro]) await h.json(`/api/projects/${p.projectId}/scene`, { method: "PUT", token: p.token, body: { spec: bigScene() } });
    await startRender(free.token, free.projectId); // queued first
    await startRender(pro.token, pro.projectId);
    await startRender(studio.token, studio.projectId); // queued last

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await claim(`w${i}`);
      const row = await h.db.prepare("SELECT user_id FROM render_jobs WHERE id = ?").bind(c.body.renderJobId).first<{ user_id: string }>();
      order.push(row!.user_id);
      await h.json(`/api/render/jobs/${c.body.renderJobId}/fail`, { headers: auth, body: { workerId: `w${i}`, code: "render_failed", message: "cleanup", retryable: false } });
    }
    expect(order).toEqual(["user_prio_studio", "user_prio_pro", "user_prio_free"]);
    expect((await h.request("/api/render/claim", { headers: auth, body: { workerId: "w9" } })).status).toBe(204);
  });

  it("reports real frame progress, verifies the MP4, and only then completes", async () => {
    const { token, projectId } = await projectWithScene("user_happy", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "720p");
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(1);

    const c = await claim();
    const id = c.body.renderJobId as string;
    const frames = 20 * 30;
    expect(c.body.settings).toMatchObject({ width: 1280, height: 720, fps: 30, duration: 20, watermark: false });

    // Models are downloadable by the worker, and only this render's models.
    const file = await h.request(c.body.assets.hero.files["model.glb"].url, { headers: auth });
    expect(await file.text()).toBe("glb-bytes");
    expect((await h.request(`/api/render/jobs/${id}/files/ast_user_prio_free/model.glb`, { headers: auth })).status).toBe(404);
    expect((await h.request(`/api/render/jobs/${id}/files/ast_user_happy/..%2Fsecret.glb`, { headers: auth })).status).not.toBe(200);

    let p = await h.json(`/api/render/jobs/${id}/progress`, { headers: auth, body: { workerId: "worker-1", phase: "rendering", framesDone: 150, framesTotal: frames, engine: "cycles-cpu" } });
    expect(p.body).toEqual({ cancel: false });
    let job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ stage: "rendering_video", progress: 0.25, detail: "Frame 150 of 600" });

    await h.json(`/api/render/jobs/${id}/progress`, { headers: auth, body: { workerId: "worker-1", phase: "encoding" } });
    job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ stage: "encoding_mp4", progress: null }); // no number exists for this stage, so none is shown

    await h.json(`/api/render/jobs/${id}/progress`, { headers: auth, body: { workerId: "worker-1", phase: "uploading" } });
    expect((await h.json(`/api/jobs/${jobId}`, { token })).body.job.stage).toBe("saving_video");

    // Completion without an uploaded file is refused; the job is not "completed".
    const mp4 = fakeMp4(8192);
    const done = { workerId: "worker-1", width: 1280, height: 720, fps: 30, frames, durationSeconds: 20, bytes: mp4.length, codec: "h264", engine: "cycles-cpu", notes: [] };
    const up = await h.request(`/api/render/jobs/${id}/thumbnail`, { method: "PUT", headers: { ...auth, "x-kivo-worker": "worker-1", "content-type": "image/jpeg", "content-length": "4" }, raw: new Uint8Array([1, 2, 3, 4]) });
    expect(up.status).toBe(200);
    const upv = await h.request(`/api/render/jobs/${id}/video`, { method: "PUT", headers: { ...auth, "x-kivo-worker": "worker-1", "content-type": "video/mp4", "content-length": String(mp4.length) }, raw: mp4 });
    expect(upv.status).toBe(200);

    const completed = await h.json(`/api/render/jobs/${id}/complete`, { headers: auth, body: done });
    expect(completed.status).toBe(200);
    job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "succeeded", stage: "completed", result: "video", videoId: completed.body.videoId });

    // The finished video is playable through a signed URL, appears in history, and stays charged.
    const detail = await h.json(`/api/projects/${projectId}`, { token });
    expect(detail.body.project).toMatchObject({ status: "ready", latestVideoId: completed.body.videoId });
    expect(detail.body.video).toMatchObject({ width: 1280, height: 720, fps: 30, codec: "h264", watermark: false });
    const played = await h.request(detail.body.video.url);
    expect(played.status).toBe(200);
    expect(new Uint8Array(await played.arrayBuffer()).slice(4, 8)).toEqual(new TextEncoder().encode("ftyp"));
    const download = await h.request(detail.body.video.downloadUrl);
    expect(download.headers.get("content-disposition")).toMatch(/attachment; filename=".*\.mp4"/);
    expect((await h.json(`/api/projects/${projectId}/videos`, { token })).body.videos).toHaveLength(1);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(1);
  });

  it("rejects a file that is not a real MP4, fails the job, and refunds it", async () => {
    const { token, projectId } = await projectWithScene("user_badfile", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "720p");
    const c = await claim();
    const id = c.body.renderJobId as string;
    const junk = new TextEncoder().encode("<html>not a video</html>".repeat(100));
    await h.request(`/api/render/jobs/${id}/video`, { method: "PUT", headers: { ...auth, "x-kivo-worker": "worker-1", "content-length": String(junk.length) }, raw: junk });
    const res = await h.json(`/api/render/jobs/${id}/complete`, {
      headers: auth,
      body: { workerId: "worker-1", width: 1280, height: 720, fps: 30, frames: 600, durationSeconds: 20, bytes: junk.length, codec: "h264" },
    });
    expect(res.status).toBe(422);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "video_invalid" } });
    expect((await h.json(`/api/projects/${projectId}/videos`, { token })).body.videos).toEqual([]);
    expect((await h.json(`/api/projects/${projectId}`, { token })).body.video).toBeNull();
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
    const stored = await h.bucket.list({ prefix: "users/user_badfile/videos/" });
    expect(stored.objects).toEqual([]);
  });

  it("rejects a completion whose frame count or size does not match the job", async () => {
    const { token, projectId } = await projectWithScene("user_mismatch", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "720p");
    const c = await claim();
    const mp4 = fakeMp4();
    await h.request(`/api/render/jobs/${c.body.renderJobId}/video`, { method: "PUT", headers: { ...auth, "x-kivo-worker": "worker-1", "content-length": String(mp4.length) }, raw: mp4 });
    const res = await h.json(`/api/render/jobs/${c.body.renderJobId}/complete`, {
      headers: auth,
      body: { workerId: "worker-1", width: 1280, height: 720, fps: 30, frames: 12, durationSeconds: 0.4, bytes: mp4.length, codec: "h264" },
    });
    expect(res.status).toBe(422);
    expect((await h.json(`/api/jobs/${jobId}`, { token })).body.job.status).toBe("failed");
  });

  it("tells the worker to stop when the user cancels, and refunds", async () => {
    const { token, projectId } = await projectWithScene("user_cancel_render", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "720p");
    const c = await claim();
    await h.json(`/api/render/jobs/${c.body.renderJobId}/progress`, { headers: auth, body: { workerId: "worker-1", phase: "rendering", framesDone: 5, framesTotal: 600 } });
    expect((await h.json(`/api/jobs/${jobId}/cancel`, { token, method: "POST" })).body.job.status).toBe("canceled");
    const p = await h.json(`/api/render/jobs/${c.body.renderJobId}/progress`, { headers: auth, body: { workerId: "worker-1", phase: "rendering", framesDone: 6, framesTotal: 600 } });
    expect(p.body).toEqual({ cancel: true });
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("requeues a render whose worker died, then fails and refunds after the retry", async () => {
    const { token, projectId } = await projectWithScene("user_lease", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "720p");

    const first = await claim("dead-worker-1");
    await h.db.prepare("UPDATE render_jobs SET lease_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, first.body.renderJobId).run();
    await sweep(h.env);
    let job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "running", stage: "preparing_rendering" });

    const second = await claim("dead-worker-2");
    expect(second.body.renderJobId).toBe(first.body.renderJobId);
    // The first worker comes back from the dead: it no longer owns the job.
    const stale = await h.json(`/api/render/jobs/${first.body.renderJobId}/progress`, { headers: auth, body: { workerId: "dead-worker-1", phase: "rendering", framesDone: 10 } });
    expect(stale.body).toEqual({ cancel: true });

    await h.db.prepare("UPDATE render_jobs SET lease_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, first.body.renderJobId).run();
    await sweep(h.env);
    job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("fails and refunds a render nobody picks up", async () => {
    const { token, projectId } = await projectWithScene("user_unclaimed", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    const jobId = await startRender(token, projectId, "720p");
    await h.db.prepare("UPDATE render_jobs SET created_at = ? WHERE job_id = ?").bind(Date.now() - 31 * 60_000, jobId).run();
    await sweep(h.env);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "render_unavailable" } });
    expect(job.error.message).toMatch(/not charged/i);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("refuses to render a scene whose model is not in storage", async () => {
    const { token, projectId, assetId } = await projectWithScene("user_missing_model", "pro");
    await h.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec: bigScene() } });
    await h.bucket.delete(`users/user_missing_model/assets/${assetId}/model.glb`);
    const res = await h.json(`/api/projects/${projectId}/render`, { token, body: {} });
    await advanceJob(h.env, res.body.job.id);
    const job = (await h.json(`/api/jobs/${res.body.job.id}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "storage_error" } });
    expect((await h.request("/api/render/claim", { headers: auth, body: { workerId: "w" } })).status).toBe(204);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });
});

describe("scene-only generation prepays one render", () => {
  it("does not charge a second video for the first render of an Advanced Mode scene", async () => {
    const { token, projectId } = await projectWithScene("user_prepaid", "free_user");
    await saveScene(h.env, projectId, "user_prepaid", bigScene(), "gemini", null);
    await h.db.prepare("UPDATE projects SET render_credits = 1 WHERE id = ?").bind(projectId).run();

    const first = await h.json(`/api/projects/${projectId}/render`, { token, body: {} });
    expect(first.status).toBe(202);
    expect(first.body.usage.used).toBe(0);
    // If that render fails, the prepaid render comes back.
    await advanceJob(h.env, first.body.job.id);
    const c = await claim();
    await h.json(`/api/render/jobs/${c.body.renderJobId}/fail`, { headers: auth, body: { workerId: "worker-1", code: "render_failed", message: "boom", retryable: false } });
    const credits = await h.db.prepare("SELECT render_credits FROM projects WHERE id = ?").bind(projectId).first<{ render_credits: number }>();
    expect(credits!.render_credits).toBe(1);
  });
});
