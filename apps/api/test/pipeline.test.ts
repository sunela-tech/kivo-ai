import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceJob } from "../src/pipeline/run";
import { createHarness, fakeGlb, geminiReply, type Harness } from "./harness";

/**
 * The whole orchestrated pipeline with Gemini and Meshy scripted:
 * prompt → interpretation → plan → Meshy models/textures/rig/clips → animation → cameras → render queued.
 */

let h: Harness;
let meshy: ReturnType<typeof scriptMeshy>;
beforeEach(async () => {
  h = await createHarness();
  scriptGemini(h);
  meshy = scriptMeshy(h);
});
afterEach(() => h.close());

const INTERPRETATION = { accepted: true, rejectionReason: "", title: "Robot City", logline: "A robot explores a city.", subjects: ["robot"], setting: "city", mood: "dusk", action: "walks" };
const PLAN = {
  world: { skyTop: "#223355", skyHorizon: "#cc9966", groundColor: "#444444", ambient: 0.5, exposure: 0 },
  assets: [
    { id: "robot", name: "Robot", kind: "character", prompt: "a small humanoid robot", rig: "humanoid", sizeMeters: 1.2, sizeAxis: "height", actionIds: [0], customMotionPrompt: "", customMotionSeconds: 0 },
    { id: "tower", name: "Tower", kind: "building", prompt: "a ruined tower", rig: "none", sizeMeters: 30, sizeAxis: "height", actionIds: [], customMotionPrompt: "", customMotionSeconds: 0 },
    { id: "ground", name: "Ground", kind: "terrain", prompt: "a flat square slab of asphalt", rig: "none", sizeMeters: 50, sizeAxis: "width", actionIds: [], customMotionPrompt: "", customMotionSeconds: 0 },
  ],
  beats: [{ start: 0, end: 5, description: "The robot walks forward." }],
};
const ANIMATION = {
  objects: [
    { id: "hero", assetId: "robot", name: "Hero", position: { x: 0, y: 0, z: -3 }, rotationY: 0, scale: 1 },
    { id: "tower_1", assetId: "tower", name: "Tower", position: { x: 12, y: 0, z: 14 }, rotationY: 30, scale: 1 },
    { id: "floor", assetId: "ground", name: "Floor", position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 },
  ],
  moves: [{ objectId: "hero", smooth: false, orientToPath: true, keyframes: [{ t: 0, position: { x: 0, y: 0, z: -3 }, easing: "linear" }, { t: 4, position: { x: 0, y: 0, z: 2 }, easing: "ease_out" }] }],
  clips: [
    { objectId: "hero", start: 0, end: 4, action: "walk", speed: 1, loop: true },
    { objectId: "hero", start: 4, end: 5, action: "idle", speed: 1, loop: true },
    { objectId: "tower_1", start: 0, end: 5, action: "walk", speed: 1, loop: true },
  ],
  procedural: [],
};
const CINEMATOGRAPHY = {
  cameras: [{ id: "follow_cam", name: "Follow", attachMode: "follow", attachObjectId: "hero", smooth: true, keyframes: [{ t: 0, position: { x: 1, y: 1.2, z: -3 }, target: { x: 0, y: 0.7, z: 1 }, fov: 40, easing: "linear" }] }],
  shots: [{ name: "Follow", cameraId: "follow_cam", start: 0, end: 5, transition: "fade", transitionDuration: 0.4 }],
  lights: [{ id: "sun", name: "Sun", type: "sun", color: "#ffd0a0", intensity: 3, position: { x: 5, y: 8, z: -5 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }],
  lightChanges: [],
};

function scriptGemini(harness: Harness, overrides: Partial<Record<"interpret" | "plan" | "animate" | "cinematography", unknown>> = {}) {
  harness.on("generativelanguage.googleapis.com", async (req) => {
    const body = (await req.json()) as { systemInstruction: { parts: { text: string }[] } };
    const system = body.systemInstruction.parts[0]!.text;
    if (system.includes("production designer")) return geminiReply(overrides.plan ?? PLAN);
    if (system.includes("animation director")) return geminiReply(overrides.animate ?? ANIMATION);
    if (system.includes("cinematographer")) return geminiReply(overrides.cinematography ?? CINEMATOGRAPHY);
    return geminiReply(overrides.interpret ?? INTERPRETATION);
  });
}

function scriptMeshy(harness: Harness, opts: { rigRejected?: boolean; failPrompt?: string } = {}) {
  const tasks = new Map<string, { kind: string; polls: number; body: Record<string, unknown> }>();
  const created: { kind: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  harness.on("api.meshy.ai/openapi/v1/balance", () => Response.json({ balance: 5000 }));
  harness.on("api.meshy.ai/openapi/v1/animations/library", () => Response.json([{ action_id: 0, name: "Idle", category: "DailyActions", sub_category: "Idle" }, { action_id: 28, name: "Big Wave Hello", category: "DailyActions", sub_category: "Interacting" }]));
  harness.on("assets.meshy.test", (req) => new Response(req.url.includes("actions") ? fakeGlb(["Idle"]) : req.url.endsWith(".png") ? new Uint8Array([137, 80, 78, 71]) : fakeGlb(), { headers: { "content-length": "100" } }));
  harness.on(/api\.meshy\.ai\/openapi\/(v2\/text-to-3d|v1\/rigging|v1\/animations)(\/[^/?]+)?$/, async (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/library")) return undefined;
    const kind = url.pathname.includes("text-to-3d") ? "text" : url.pathname.includes("rigging") ? "rig" : "animation";
    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      if (kind === "rig" && opts.rigRejected) return Response.json({ message: "Pose estimation failed" }, { status: 422 });
      const id = `task_${++n}`;
      tasks.set(id, { kind: kind === "text" ? String(body.mode) : kind, polls: 0, body });
      created.push({ kind: kind === "text" ? String(body.mode) : kind, body });
      return Response.json({ result: id });
    }
    const id = url.pathname.split("/").pop()!;
    const task = tasks.get(id);
    if (!task) return Response.json({ message: "not found" }, { status: 404 });
    task.polls++;
    if (task.polls < 2) return Response.json({ id, status: "IN_PROGRESS", progress: 50 });
    if (opts.failPrompt && task.body.prompt === opts.failPrompt) {
      return Response.json({ id, status: "FAILED", progress: 0, task_error: { type: "invalid_input", message: "The prompt is too complex for 3D generation." }, consumed_credits: 0 });
    }
    const base = { id, status: "SUCCEEDED", progress: 100 };
    if (task.kind === "preview") return Response.json({ ...base, type: "text-to-3d-preview", consumed_credits: 5, model_urls: { glb: "https://assets.meshy.test/preview.glb" } });
    if (task.kind === "refine") return Response.json({ ...base, type: "text-to-3d-refine", consumed_credits: 10, model_urls: { glb: "https://assets.meshy.test/model.glb" }, thumbnail_url: "https://assets.meshy.test/thumb.png" });
    if (task.kind === "rig") return Response.json({ ...base, consumed_credits: 5, result: { rigged_character_glb_url: "https://assets.meshy.test/rigged.glb", basic_animations: { walking_glb_url: "https://assets.meshy.test/walk.glb", running_glb_url: "https://assets.meshy.test/run.glb" } } });
    return Response.json({ ...base, consumed_credits: 3, result: { animation_glb_url: "https://assets.meshy.test/actions.glb" } });
  });
  return { created, tasks };
}

/** Run the job the way the queue would: advance until it parks or finishes. */
async function drive(jobId: string, maxTicks = 60): Promise<string[]> {
  const stages: string[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const again = await advanceJob(h.env, jobId);
    const row = await h.db.prepare("SELECT stage, status FROM jobs WHERE id = ?").bind(jobId).first<{ stage: string; status: string }>();
    if (stages[stages.length - 1] !== row!.stage) stages.push(row!.stage);
    if (again === null) break;
  }
  return stages;
}

async function start(token: string, render = true, prompt = "A robot explores an abandoned city.") {
  const project = await h.json("/api/projects", { token, body: { prompt, style: "scifi" } });
  const started = await h.json(`/api/projects/${project.body.project.id}/generate`, { token, body: { render } });
  expect(started.status).toBe(202);
  return { projectId: project.body.project.id as string, jobId: started.body.job.id as string };
}

describe("generation pipeline", () => {
  it("runs prompt → Gemini → Meshy → Gemini → render queue, through the real stages", async () => {
    const token = await h.token("user_pipe");
    const { projectId, jobId } = await start(token);
    const stages = await drive(jobId);
    expect(stages).toEqual(["generating_models", "preparing_textures", "rigging_characters", "preparing_rendering"]);

    // Every visible model was generated by Meshy with the Free plan's model.
    const previews = meshy.created.filter((c) => c.kind === "preview");
    expect(previews).toHaveLength(3);
    for (const p of previews) expect(p.body).toMatchObject({ ai_model: "meshy-6-lite", should_remesh: true, target_formats: ["glb"] });
    expect(previews.find((p) => String(p.body.prompt).includes("humanoid robot"))!.body.pose_mode).toBe("a-pose");
    expect(meshy.created.filter((c) => c.kind === "refine")).toHaveLength(3);
    expect(meshy.created.filter((c) => c.kind === "rig")).toHaveLength(1); // only the humanoid
    expect(meshy.created.filter((c) => c.kind === "animation")).toHaveLength(1);

    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "running", stage: "preparing_rendering" });
    const queued = await h.db.prepare("SELECT status, priority, frames_total, settings FROM render_jobs WHERE job_id = ?").bind(jobId).first<{ status: string; priority: number; frames_total: number; settings: string }>();
    expect(queued).toMatchObject({ status: "queued", priority: 0, frames_total: 120 });
    expect(JSON.parse(queued!.settings)).toMatchObject({ width: 854, height: 480, fps: 24, duration: 5, watermark: true });

    // The scene is valid, uses real clip names, and dropped the clip Gemini gave to an unrigged tower.
    const scene = (await h.json(`/api/projects/${projectId}/scene`, { token })).body;
    expect(scene.spec.title).toBe("Robot City");
    expect(scene.spec.objects.map((o: { id: string }) => o.id)).toEqual(["hero", "tower_1", "floor"]);
    const clips = scene.spec.tracks.filter((t: { type: string }) => t.type === "action");
    expect(clips).toHaveLength(1);
    expect(clips[0].clips.map((c: { action: string }) => c.action)).toEqual(["walk", "idle"]);
    expect(job.warnings.join(" ")).toMatch(/no skeleton/);
    expect(scene.assets.robot).toMatchObject({ status: "ready", rigStatus: "rigged", clipNames: ["walk", "run", "idle"] });
    expect(scene.assets.tower).toMatchObject({ status: "ready", rigStatus: "none", clipNames: [] });
    expect(scene.assets.robot.modelUrl).toMatch(/^\/api\/media\/o\/.+[?&]s=/);

    // Models are stored in R2 under the owner's prefix and their real Meshy cost is recorded.
    const stored = await h.env.BUCKET.list({ prefix: "users/user_pipe/assets/" });
    const files = stored.objects.map((o) => o.key.split("/").pop()).sort();
    expect(files).toEqual(["actions.glb", "model.glb", "model.glb", "model.glb", "rigged.glb", "run.glb", "thumb.png", "thumb.png", "thumb.png", "walk.glb"]);
    const spent = await h.db.prepare("SELECT SUM(units) AS n FROM cost_events WHERE user_id = 'user_pipe' AND provider = 'meshy'").first<{ n: number }>();
    expect(spent!.n).toBe(3 * 15 + 5 + 3);
  });

  it("reuses models it already generated instead of paying Meshy again", async () => {
    const token = await h.token("user_reuse", { pla: "u:pro" });
    const first = await start(token);
    await drive(first.jobId);
    const before = meshy.created.length;
    await h.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").bind(first.jobId).run();

    const second = await start(token, true, "A robot explores an abandoned city again.");
    const stages = await drive(second.jobId);
    expect(meshy.created.length).toBe(before); // not a single new Meshy task
    expect(stages).toEqual(["preparing_rendering"]);
    const job = (await h.json(`/api/jobs/${second.jobId}`, { token })).body.job;
    expect(job.stage).toBe("preparing_rendering");
    const assets = await h.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE user_id = 'user_reuse'").first<{ n: number }>();
    expect(assets!.n).toBe(3);
  });

  it("stops at an editable scene in Advanced Mode and prepays its first render", async () => {
    const token = await h.token("user_adv");
    const { projectId, jobId } = await start(token, false);
    await drive(jobId);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "succeeded", result: "scene", willRender: false });
    expect(job.stages).not.toContain("rendering_video");
    const project = (await h.json(`/api/projects/${projectId}`, { token })).body.project;
    expect(project).toMatchObject({ status: "scene_ready", hasScene: true, prepaidRenders: 1 });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM render_jobs").first<{ n: number }>())!.n).toBe(0);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(1);
  });

  it("keeps a model Meshy cannot rig, says so, and animates it as a rigid body", async () => {
    await h.close();
    h = await createHarness();
    scriptGemini(h);
    meshy = scriptMeshy(h, { rigRejected: true });
    const token = await h.token("user_norig");
    const { projectId, jobId } = await start(token, false);
    await drive(jobId);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job.status).toBe("succeeded");
    const scene = (await h.json(`/api/projects/${projectId}/scene`, { token })).body;
    expect(scene.assets.robot).toMatchObject({ status: "ready", rigStatus: "unsupported", clipNames: [] });
    expect(scene.assets.robot.rigNote).toMatch(/could not rig/i);
    expect(scene.spec.tracks.some((t: { type: string }) => t.type === "action")).toBe(false); // no pretend skeletal animation
    expect(scene.spec.tracks.some((t: { type: string; objectId: string }) => t.type === "transform" && t.objectId === "hero")).toBe(true);
    expect(job.warnings.join(" ")).toMatch(/Robot.*rigid body/);
  });

  it("fails with a clear message and a refund when Meshy cannot build a model", async () => {
    await h.close();
    h = await createHarness();
    scriptGemini(h);
    const hint = "a ruined tower. science fiction style, hard surface detail, emissive accents";
    meshy = scriptMeshy(h, { failPrompt: hint });
    const token = await h.token("user_meshyfail");
    const { projectId, jobId } = await start(token);
    await drive(jobId);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "meshy_failed" } });
    expect(job.error.message).toMatch(/Tower/);
    expect(job.error.message).toMatch(/too complex/);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
    expect((await h.json(`/api/projects/${projectId}`, { token })).body.project.status).toBe("failed");
  });

  it("refuses a prompt Gemini rejects, without charging", async () => {
    await h.close();
    h = await createHarness();
    scriptGemini(h, { interpret: { ...INTERPRETATION, accepted: false, rejectionReason: "That isn't something Kivo can film. Try describing characters and an action." } });
    meshy = scriptMeshy(h);
    const token = await h.token("user_rejected");
    const { jobId } = await start(token);
    await drive(jobId);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "prompt_rejected", message: "That isn't something Kivo can film. Try describing characters and an action." } });
    expect(meshy.created).toHaveLength(0);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("retries when Gemini is down, then fails cleanly and refunds", async () => {
    await h.close();
    h = await createHarness();
    h.on("generativelanguage.googleapis.com", () => Response.json({ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }, { status: 503 }));
    meshy = scriptMeshy(h);
    const token = await h.token("user_gemini_down");
    const { jobId } = await start(token);

    const first = await advanceJob(h.env, jobId);
    expect(first).toBeGreaterThan(0); // scheduled to retry with backoff
    let job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "running", stage: "understanding_prompt", detail: "Retrying after a temporary problem" });

    for (let i = 0; i < 8; i++) if ((await advanceJob(h.env, jobId)) === null) break;
    job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "gemini_unavailable" } });
    expect(job.error.message).toMatch(/not charged/i);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("enforces the Meshy cost ceiling before spending anything", async () => {
    await h.close();
    h = await createHarness({ KIVO_PLAN_OVERRIDES: JSON.stringify({ free: { meshyCreditsPerJob: 20 } }) });
    scriptGemini(h);
    meshy = scriptMeshy(h);
    const token = await h.token("user_ceiling");
    const { jobId } = await start(token);
    await drive(jobId);
    const job = (await h.json(`/api/jobs/${jobId}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "cost_ceiling" } });
    expect(meshy.created).toHaveLength(0);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("never creates the same Meshy task twice, even if the queue delivers a job twice at once", async () => {
    const token = await h.token("user_dupe");
    const { jobId } = await start(token);
    // Two deliveries race; the job lock lets exactly one of them work.
    await Promise.all([advanceJob(h.env, jobId), advanceJob(h.env, jobId), advanceJob(h.env, jobId)]);
    await drive(jobId);
    expect(meshy.created.filter((c) => c.kind === "preview")).toHaveLength(3);
    expect(meshy.created.filter((c) => c.kind === "refine")).toHaveLength(3);
    expect(meshy.created.filter((c) => c.kind === "rig")).toHaveLength(1);
  });
});

describe("AI Director", () => {
  async function sceneReady(userId: string) {
    const token = await h.token(userId);
    const { projectId, jobId } = await start(token, false);
    await drive(jobId);
    return { token, projectId };
  }

  it("applies a change to the scene and regenerates nothing", async () => {
    const { token, projectId } = await sceneReady("user_director");
    const before = (await h.json(`/api/projects/${projectId}/scene`, { token })).body;
    const meshyBefore = meshy.created.length;
    h.on("generativelanguage.googleapis.com", async (req) => {
      const body = (await req.json()) as { systemInstruction: { parts: { text: string }[] } };
      if (!body.systemInstruction.parts[0]!.text.includes("AI Director")) return undefined;
      return geminiReply({
        summary: "Switched the lighting to a warm sunset.",
        cannotDo: "",
        operations: [
          { op: "set_world", world: { skyTop: "#3a2a5a", skyHorizon: "#ff8844", ambient: 0.4 } },
          { op: "upsert_light", light: { id: "sun", type: "sun", color: "#ff9a5c", intensity: 2.5, position: { x: -10, y: 3, z: -8 }, target: { x: 0, y: 0, z: 0 } } },
          { op: "update_object", id: "does_not_exist", patch: { scale: 3 } },
        ],
      });
    });
    const res = await h.json(`/api/projects/${projectId}/director`, { token, body: { instruction: "Change the lighting to sunset." } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, pending: false, summary: "Switched the lighting to a warm sunset." });
    expect(res.body.applied).toHaveLength(2);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.spec.world).toMatchObject({ skyHorizon: "#ff8844", ambient: 0.4, groundColor: before.spec.world.groundColor });
    expect(res.body.spec.lights[0]).toMatchObject({ id: "sun", color: "#ff9a5c" });
    // Untouched parts are byte-for-byte the same, and no Meshy work happened.
    expect(res.body.spec.objects).toEqual(before.spec.objects);
    expect(res.body.spec.cameras).toEqual(before.spec.cameras);
    expect(res.body.spec.assets).toEqual(before.spec.assets);
    expect(meshy.created.length).toBe(meshyBefore);
    expect(res.body.version).toBe(before.version + 1);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(1); // directing does not use videos
  });

  it("sends only the new model to Meshy when the user asks for a new object", async () => {
    const { token, projectId } = await sceneReady("user_director_new");
    const meshyBefore = meshy.created.length;
    h.on("generativelanguage.googleapis.com", async (req) => {
      const body = (await req.json()) as { systemInstruction: { parts: { text: string }[] } };
      if (!body.systemInstruction.parts[0]!.text.includes("AI Director")) return undefined;
      return geminiReply({
        summary: "Added a street lamp next to the robot.",
        cannotDo: "",
        operations: [
          { op: "add_asset", asset: { id: "lamp", name: "Street lamp", kind: "prop", prompt: "a bent rusty street lamp", rig: "none", sizeMeters: 4, sizeAxis: "height" } },
          { op: "add_object", object: { id: "lamp_1", assetId: "lamp", position: { x: 2, y: 0, z: 0 }, rotationY: 0, scale: 1 } },
        ],
      });
    });
    const res = await h.json(`/api/projects/${projectId}/director`, { token, body: { instruction: "Add a street lamp." } });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ changed: true, pending: true, newModels: ["Street lamp"] });
    expect(res.body.job.stages).toEqual(["generating_models", "preparing_textures", "rigging_characters"]);

    await drive(res.body.job.id);
    const created = meshy.created.slice(meshyBefore);
    expect(created.map((c) => c.kind)).toEqual(["preview", "refine"]);
    expect(String(created[0]!.body.prompt)).toContain("street lamp");

    const scene = (await h.json(`/api/projects/${projectId}/scene`, { token })).body;
    expect(scene.spec.objects.map((o: { id: string }) => o.id)).toContain("lamp_1");
    expect(scene.assets.lamp).toMatchObject({ status: "ready" });
    expect((await h.json(`/api/jobs/${res.body.job.id}`, { token })).body.job).toMatchObject({ status: "succeeded", result: "scene" });
  });

  it("changes nothing when the director cannot do what was asked", async () => {
    const { token, projectId } = await sceneReady("user_director_no");
    const before = (await h.json(`/api/projects/${projectId}/scene`, { token })).body;
    h.on("generativelanguage.googleapis.com", async (req) => {
      const body = (await req.json()) as { systemInstruction: { parts: { text: string }[] } };
      if (!body.systemInstruction.parts[0]!.text.includes("AI Director")) return undefined;
      return geminiReply({ summary: "", cannotDo: "The robot has no backflip clip. Try a clip it has: walk, run, idle.", operations: [] });
    });
    const res = await h.json(`/api/projects/${projectId}/director`, { token, body: { instruction: "Make the robot do a backflip." } });
    expect(res.body).toMatchObject({ changed: false, cannotDo: "The robot has no backflip clip. Try a clip it has: walk, run, idle." });
    expect((await h.json(`/api/projects/${projectId}/scene`, { token })).body.version).toBe(before.version);
  });
});
