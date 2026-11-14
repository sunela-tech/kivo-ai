import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sniffImage } from "../src/images";
import { advanceJob } from "../src/pipeline/run";
import { findStorage } from "../src/storage";
import { createHarness, fakeGlb, geminiReply, type Harness } from "./harness";

/**
 * Making a video from uploaded images: the upload itself (what is accepted, limits, privacy),
 * and the pipeline with Gemini and Meshy scripted — Gemini is shown the images, and each usable
 * image becomes one model through Meshy's Image to 3D instead of a text prompt.
 */

// ───────── tiny but structurally real image files ─────────

function png(width: number, height: number, extra = 64): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  for (let i = 33; i < b.length; i++) b[i] = (i * 7 + width) % 251; // different sizes → different files
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(200);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // SOI + APP0 (JFIF)
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3], 20); // SOF0
  return b;
}

function webp(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBPVP8X"), 8);
  b.set([10, 0, 0, 0, 0, 0, 0, 0], 16);
  const w = width - 1;
  const h2 = height - 1;
  b.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h2 & 255, (h2 >> 8) & 255, (h2 >> 16) & 255], 24);
  return b;
}

describe("reading image files", () => {
  it("recognises JPEG, PNG and WebP by their bytes and reads their real size", () => {
    expect(sniffImage(png(640, 480))).toEqual({ type: "image/png", width: 640, height: 480 });
    expect(sniffImage(jpeg(1024, 768))).toEqual({ type: "image/jpeg", width: 1024, height: 768 });
    expect(sniffImage(webp(300, 200))).toEqual({ type: "image/webp", width: 300, height: 200 });
  });

  it("is not fooled by other files", () => {
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a................................"))).toBeNull();
    expect(sniffImage(new Uint8Array(40))).toBeNull();
    expect(sniffImage(png(640, 480).slice(0, 20))).toBeNull();
  });
});

// ───────── scripted Gemini and Meshy ─────────

const WORLD = { skyTop: "#223355", skyHorizon: "#cc9966", groundColor: "#444444", ambient: 0.5, exposure: 0 };
const asset = (id: string, over: Record<string, unknown>) => ({ id, name: id, kind: "prop", prompt: `a ${id}`, imageIndex: 0, rig: "none", sizeMeters: 1, sizeAxis: "height", actionIds: [], customMotionPrompt: "", customMotionSeconds: 0, ...over });

const SEEN_TOY = { index: 1, subject: "Red toy robot", usable: true, reason: "", kind: "character", humanoid: true, description: "A red plastic toy robot with a square head and yellow eyes." };
const INTERPRETATION = { accepted: true, rejectionReason: "", title: "Toy Robot Parade", logline: "A toy robot marches across a table.", subjects: ["red toy robot"], setting: "a tabletop", mood: "warm", action: "walks and waves", images: [SEEN_TOY] };
const PLAN = {
  world: WORLD,
  assets: [
    asset("toy_robot", { name: "Toy Robot", kind: "character", prompt: "a red plastic toy robot with a square head", imageIndex: 1, rig: "humanoid", sizeMeters: 0.4, actionIds: [0] }),
    asset("table", { name: "Table", kind: "terrain", prompt: "a flat square wooden table top", sizeMeters: 6, sizeAxis: "width" }),
  ],
  beats: [{ start: 0, end: 5, description: "The toy walks forward." }],
};
const ANIMATION = {
  objects: [
    { id: "hero", assetId: "toy_robot", name: "Hero", position: { x: 0, y: 0, z: -1 }, rotationY: 0, scale: 1 },
    { id: "floor", assetId: "table", name: "Table", position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 },
  ],
  moves: [{ objectId: "hero", smooth: false, orientToPath: true, keyframes: [{ t: 0, position: { x: 0, y: 0, z: -1 }, easing: "linear" }, { t: 4, position: { x: 0, y: 0, z: 1 }, easing: "ease_out" }] }],
  clips: [{ objectId: "hero", start: 0, end: 4, action: "walk", speed: 1, loop: true }, { objectId: "hero", start: 4, end: 5, action: "idle", speed: 1, loop: true }],
  procedural: [],
};
const CINEMATOGRAPHY = {
  cameras: [{ id: "cam", name: "Cam", attachMode: "look_at", attachObjectId: "hero", smooth: true, keyframes: [{ t: 0, position: { x: 1, y: 0.4, z: 2 }, target: { x: 0, y: 0.25, z: 0 }, fov: 40, easing: "linear" }] }],
  shots: [{ name: "One", cameraId: "cam", start: 0, end: 5, transition: "fade", transitionDuration: 0.4 }],
  lights: [{ id: "sun", name: "Sun", type: "sun", color: "#ffd0a0", intensity: 3, position: { x: 5, y: 8, z: 5 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }],
  lightChanges: [],
};

interface GeminiCall {
  pass: string;
  text: string;
  images: { mimeType: string; data: string }[];
  system: string;
}

function scriptGemini(h: Harness, overrides: Partial<Record<"interpret" | "plan", unknown>> = {}) {
  const calls: GeminiCall[] = [];
  h.on("generativelanguage.googleapis.com", async (req) => {
    const body = (await req.json()) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[] };
    const system = body.systemInstruction.parts[0]!.text;
    const parts = body.contents[0]!.parts;
    const pass = system.includes("production designer") ? "plan" : system.includes("animation director") ? "animate" : system.includes("cinematographer") ? "cinematography" : "interpret";
    calls.push({ pass, system, text: parts.map((p) => p.text ?? "").join(""), images: parts.flatMap((p) => (p.inlineData ? [p.inlineData] : [])) });
    if (pass === "plan") return geminiReply(overrides.plan ?? PLAN);
    if (pass === "animate") return geminiReply(ANIMATION);
    if (pass === "cinematography") return geminiReply(CINEMATOGRAPHY);
    return geminiReply(overrides.interpret ?? INTERPRETATION);
  });
  return calls;
}

function scriptMeshy(h: Harness, opts: { rejectImage?: { status: number; message: string } } = {}) {
  const tasks = new Map<string, { kind: string; polls: number }>();
  const created: { kind: string; id: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  h.on("api.meshy.ai/openapi/v1/balance", () => Response.json({ balance: 5000 }));
  h.on("api.meshy.ai/openapi/v1/animations/library", () => Response.json([{ action_id: 0, name: "Idle", category: "DailyActions", sub_category: "Idle" }]));
  h.on("assets.meshy.test", (req) => new Response(req.url.includes("actions") ? fakeGlb(["Idle"]) : req.url.endsWith(".png") ? new Uint8Array([137, 80, 78, 71]) : fakeGlb()));
  h.on(/api\.meshy\.ai\/openapi\/(v2\/text-to-3d|v1\/image-to-3d|v1\/rigging|v1\/animations)(\/[^/?]+)?$/, async (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/library")) return undefined;
    const family = url.pathname.includes("image-to-3d") ? "image" : url.pathname.includes("text-to-3d") ? "text" : url.pathname.includes("rigging") ? "rig" : "animation";
    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      if (family === "image" && opts.rejectImage) return Response.json({ message: opts.rejectImage.message }, { status: opts.rejectImage.status });
      const id = `task_${++n}`;
      const kind = family === "text" ? String(body.mode) : family;
      tasks.set(id, { kind, polls: 0 });
      created.push({ kind, id, body });
      return Response.json({ result: id });
    }
    const id = url.pathname.split("/").pop()!;
    const task = tasks.get(id);
    if (!task) return Response.json({ message: "not found" }, { status: 404 });
    // A task is only found under its own endpoint, as on the real API.
    const expected = task.kind === "image" ? "image-to-3d" : task.kind === "rig" ? "rigging" : task.kind === "animation" ? "animations" : "text-to-3d";
    if (!url.pathname.includes(expected)) return Response.json({ message: "not found" }, { status: 404 });
    task.polls++;
    if (task.polls < 2) return Response.json({ id, status: "IN_PROGRESS", progress: 40 });
    const base = { id, status: "SUCCEEDED", progress: 100 };
    if (task.kind === "image") return Response.json({ ...base, type: "image-to-3d", consumed_credits: 15, model_urls: { glb: "https://assets.meshy.test/from-image.glb" }, thumbnail_url: "https://assets.meshy.test/thumb.png" });
    if (task.kind === "preview") return Response.json({ ...base, type: "text-to-3d-preview", consumed_credits: 5, model_urls: { glb: "https://assets.meshy.test/preview.glb" } });
    if (task.kind === "refine") return Response.json({ ...base, type: "text-to-3d-refine", consumed_credits: 10, model_urls: { glb: "https://assets.meshy.test/model.glb" }, thumbnail_url: "https://assets.meshy.test/thumb.png" });
    if (task.kind === "rig") return Response.json({ ...base, consumed_credits: 5, result: { rigged_character_glb_url: "https://assets.meshy.test/rigged.glb", basic_animations: { walking_glb_url: "https://assets.meshy.test/walk.glb", running_glb_url: "https://assets.meshy.test/run.glb" } } });
    return Response.json({ ...base, consumed_credits: 3, result: { animation_glb_url: "https://assets.meshy.test/actions.glb" } });
  });
  return { created };
}

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => h.close());

const upload = (token: string, projectId: string, file: Uint8Array, headers: Record<string, string> = {}) =>
  h.json(`/api/projects/${projectId}/images`, { token, method: "POST", raw: file, headers: { "content-type": "application/octet-stream", "content-length": String(file.length), ...headers } });

async function newProject(token: string, prompt = "") {
  return (await h.json("/api/projects", { token, body: { prompt } })).body.project.id as string;
}

async function drive(jobId: string, maxTicks = 60): Promise<string[]> {
  const stages: string[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const again = await advanceJob(h.env, jobId);
    const row = await h.db.prepare("SELECT stage FROM jobs WHERE id = ?").bind(jobId).first<{ stage: string }>();
    if (stages[stages.length - 1] !== row!.stage) stages.push(row!.stage);
    if (again === null) break;
  }
  return stages;
}

describe("uploading images to a project", () => {
  it("stores a real image privately and serves it only through a signed link", async () => {
    const token = await h.token("user_up");
    const projectId = await newProject(token);
    const file = png(800, 600);
    const res = await upload(token, projectId, file, { "x-kivo-filename": encodeURIComponent("my toy <robot>.png") });
    expect(res.status).toBe(201);
    expect(res.body.image).toMatchObject({ name: "my toy robot.png", contentType: "image/png", width: 800, height: 600, bytes: file.length });

    const served = await h.request(res.body.image.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(file);
    expect((await h.request(res.body.image.url.replace(/s=[^&]+/, "s=forged"))).status).toBe(401);

    const detail = await h.json(`/api/projects/${projectId}`, { token });
    expect(detail.body.images).toHaveLength(1);
    expect((await h.json(`/api/projects/${projectId}/images`, { token })).body).toMatchObject({ max: 3 }); // Free: 4 models per scene, one kept for the ground
  });

  it("accepts JPEG and WebP too, whatever the browser says the type is", async () => {
    const token = await h.token("user_types");
    const projectId = await newProject(token);
    expect((await upload(token, projectId, jpeg(1200, 900), { "content-type": "text/plain" })).body.image.contentType).toBe("image/jpeg");
    expect((await upload(token, projectId, webp(512, 512))).body.image.contentType).toBe("image/webp");
  });

  it("refuses files that are not usable images, with a reason, and keeps nothing", async () => {
    const token = await h.token("user_bad");
    const projectId = await newProject(token);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const cases: [Uint8Array, number, RegExp][] = [
      [svg, 400, /not a JPG, PNG or WebP/],
      [new Uint8Array(0), 400, /empty/],
      [png(20, 20), 400, /too small/],
      [png(20000, 300), 400, /too large/],
      [png(800, 600, 4 * 1024 * 1024), 413, /larger than 4 MB/],
    ];
    for (const [file, status, message] of cases) {
      const res = await upload(token, projectId, file, { "content-type": "image/png" });
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe("invalid_image");
      expect(res.body.error.message).toMatch(message);
    }
    expect((await h.json(`/api/projects/${projectId}/images`, { token })).body.images).toHaveLength(0);
    expect((await h.bucket.list({ prefix: "users/user_bad/uploads/" })).objects).toHaveLength(0);
  });

  it("treats the same picture twice as one image, and enforces the plan's image limit", async () => {
    const token = await h.token("user_limit");
    const projectId = await newProject(token);
    const first = await upload(token, projectId, png(700, 700));
    const again = await upload(token, projectId, png(700, 700));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, image: { id: first.body.image.id } });

    expect((await upload(token, projectId, png(701, 700))).status).toBe(201);
    expect((await upload(token, projectId, png(702, 700))).status).toBe(201);
    const fourth = await upload(token, projectId, png(703, 700));
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toMatchObject({ code: "too_many_images" });
    expect(fourth.body.error.message).toMatch(/up to 3 images on the Free plan/);
    expect((await h.bucket.list({ prefix: "users/user_limit/uploads/" })).objects).toHaveLength(3);

    // A plan with more models per scene can use four.
    const pro = await h.token("user_limit_pro", { pla: "u:pro" });
    const proProject = await newProject(pro);
    for (let i = 0; i < 4; i++) expect((await upload(pro, proProject, png(800 + i, 600))).status).toBe(201);
    expect((await upload(pro, proProject, png(900, 600))).status).toBe(409);
  });

  it("keeps one user's images out of another user's reach", async () => {
    const alice = await h.token("user_alice_img");
    const bob = await h.token("user_bob_img");
    const projectId = await newProject(alice);
    const image = (await upload(alice, projectId, png(640, 640))).body.image;
    expect((await upload(bob, projectId, png(640, 641))).status).toBe(404);
    expect((await h.json(`/api/projects/${projectId}/images`, { token: bob })).status).toBe(404);
    expect((await h.request(`/api/projects/${projectId}/images/${image.id}`, { method: "DELETE", token: bob })).status).toBe(404);
    expect((await h.request(`/api/projects/${projectId}/images`, { method: "POST", raw: png(640, 640) })).status).toBe(401);
  });

  it("removes an image and its file, and cleans up when the project or the account is deleted", async () => {
    const token = await h.token("user_cleanup");
    const projectId = await newProject(token);
    const a = (await upload(token, projectId, png(640, 480))).body.image;
    await upload(token, projectId, png(641, 480));
    const removed = await h.json(`/api/projects/${projectId}/images/${a.id}`, { method: "DELETE", token });
    expect(removed.body.images).toHaveLength(1);
    expect((await h.request(a.url)).status).toBe(404);
    expect((await h.bucket.list({ prefix: "users/user_cleanup/uploads/" })).objects).toHaveLength(1);

    expect((await h.request(`/api/projects/${projectId}`, { method: "DELETE", token })).status).toBe(200);
    expect((await h.bucket.list({ prefix: "users/user_cleanup/uploads/" })).objects).toHaveLength(0);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM project_images WHERE user_id = 'user_cleanup'").first<{ n: number }>())!.n).toBe(0);

    const second = await newProject(token);
    await upload(token, second, png(650, 480));
    h.on("api.clerk.com", () => Response.json({ deleted: true }));
    expect((await h.request("/api/account", { method: "DELETE", token })).status).toBe(200);
    expect((await h.bucket.list({ prefix: "users/user_cleanup/" })).objects).toHaveLength(0);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM project_images WHERE user_id = 'user_cleanup'").first<{ n: number }>())!.n).toBe(0);
  });

  it("works on a deployment that stores files in KV instead of R2", async () => {
    h.env.BUCKET = undefined;
    h.env.MEDIA_KV = h.kv;
    const token = await h.token("user_kv_img");
    const projectId = await newProject(token);
    const file = jpeg(1000, 800);
    const res = await upload(token, projectId, file);
    expect(res.status).toBe(201);
    expect(new Uint8Array(await (await h.request(res.body.image.url)).arrayBuffer())).toEqual(file);
    expect(await findStorage(h.env)!.head(`users/user_kv_img/uploads/${projectId}/${res.body.image.id}.jpg`)).toMatchObject({ size: file.length, contentType: "image/jpeg" });
  });
});

describe("generating a video from images", () => {
  it("shows Gemini the image, builds that model with Meshy Image to 3D, and animates it like any other", async () => {
    const gemini = scriptGemini(h);
    const meshy = scriptMeshy(h);
    const token = await h.token("user_img_gen");
    const projectId = await newProject(token); // no written idea at all
    const file = png(900, 900);
    await upload(token, projectId, file, { "x-kivo-filename": "toy.png" });

    const started = await h.json(`/api/projects/${projectId}/generate`, { token, body: { render: true } });
    expect(started.status).toBe(202);
    const stages = await drive(started.body.job.id);
    expect(stages).toEqual(["generating_models", "preparing_textures", "rigging_characters", "preparing_rendering"]);

    // Gemini saw the picture itself once, when reading the idea; later passes work from its notes.
    const interpret = gemini.find((c) => c.pass === "interpret")!;
    expect(interpret.images).toEqual([{ mimeType: "image/png", data: Buffer.from(file).toString("base64") }]);
    expect(interpret.system).toMatch(/attached 1 image/);
    expect(interpret.text).toMatch(/nothing written/);
    const plan = gemini.find((c) => c.pass === "plan")!;
    expect(plan.images).toHaveLength(0);
    expect(plan.text).toMatch(/Image 1: Red toy robot — A red plastic toy robot.*humanoid: yes.*MUST be a model with imageIndex 1/);

    // The toy came from the image: one Image to 3D task, no text preview or refine for it.
    const fromImage = meshy.created.filter((c) => c.kind === "image");
    expect(fromImage).toHaveLength(1);
    expect(fromImage[0]!.body).toMatchObject({ ai_model: "meshy-6-lite", should_texture: true, should_remesh: true, target_formats: ["glb"], moderation: true, pose_mode: "a-pose" });
    expect(fromImage[0]!.body.image_url).toBe(`data:image/png;base64,${Buffer.from(file).toString("base64")}`);
    expect(fromImage[0]!.body).not.toHaveProperty("enable_pbr"); // not offered with Meshy 6 Lite
    expect(meshy.created.filter((c) => c.kind === "preview").map((c) => c.body.prompt)).toEqual([expect.stringContaining("wooden table top")]);
    expect(meshy.created.filter((c) => c.kind === "refine")).toHaveLength(1);
    // It is rigged from the image task and gets its clips, like a prompt-made character.
    expect(meshy.created.find((c) => c.kind === "rig")!.body).toMatchObject({ input_task_id: fromImage[0]!.id, height_meters: 0.4 });
    expect(meshy.created.filter((c) => c.kind === "animation")).toHaveLength(1);

    const scene = (await h.json(`/api/projects/${projectId}/scene`, { token })).body;
    const assets = Object.values(scene.assets) as { name: string; fromImage: boolean; status: string; rigStatus: string; clipNames: string[] }[];
    expect(assets.find((a) => a.name === "Toy Robot")).toMatchObject({ fromImage: true, status: "ready", rigStatus: "rigged" });
    expect(assets.find((a) => a.name === "Toy Robot")!.clipNames).toEqual(expect.arrayContaining(["walk", "run", "idle"]));
    expect(assets.find((a) => a.name === "Table")).toMatchObject({ fromImage: false, status: "ready" });

    expect(scene.spec.objects.map((o: { assetId: string }) => o.assetId).sort()).toEqual(["table", "toy_robot"]);
    expect(scene.spec.title).toBe("Toy Robot Parade");
    const spent = await h.db.prepare("SELECT SUM(units) AS n FROM cost_events WHERE user_id = 'user_img_gen' AND provider = 'meshy'").first<{ n: number }>();
    expect(spent!.n).toBe(15 + 5 + 10 + 5 + 3); // image model, table preview + refine, rig, one clip
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(1);
  });

  it("reuses the model when the same picture is uploaded to another project", async () => {
    scriptGemini(h);
    const meshy = scriptMeshy(h);
    const token = await h.token("user_img_reuse", { pla: "u:pro" });
    const file = png(900, 901);
    for (let round = 0; round < 2; round++) {
      const projectId = await newProject(token, "The toy walks across the table.");
      await upload(token, projectId, file);
      const started = await h.json(`/api/projects/${projectId}/generate`, { token, body: { render: false } });
      await drive(started.body.job.id);
      expect((await h.json(`/api/jobs/${started.body.job.id}`, { token })).body.job).toMatchObject({ status: "succeeded", result: "scene" });
    }
    expect(meshy.created.filter((c) => c.kind === "image")).toHaveLength(1);
    expect(meshy.created.filter((c) => c.kind === "image")[0]!.body).toMatchObject({ ai_model: "meshy-6" });
  });

  it("says why an image was not turned into a model, and still makes the video from the written idea", async () => {
    const landscape = { index: 2, subject: "beach", usable: false, reason: "It shows a whole landscape, not one object.", kind: "prop", humanoid: false, description: "" };
    scriptGemini(h, { interpret: { ...INTERPRETATION, images: [SEEN_TOY, landscape] } });
    const meshy = scriptMeshy(h);
    const token = await h.token("user_img_mixed");
    const projectId = await newProject(token, "A toy robot walks along a beach.");
    await upload(token, projectId, png(900, 902));
    await upload(token, projectId, png(1600, 900));
    const started = await h.json(`/api/projects/${projectId}/generate`, { token, body: { render: false } });
    await drive(started.body.job.id);
    const job = (await h.json(`/api/jobs/${started.body.job.id}`, { token })).body.job;
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job.warnings.join(" ")).toMatch(/Image 2 was not turned into a 3D model: It shows a whole landscape/);
    expect(meshy.created.filter((c) => c.kind === "image")).toHaveLength(1);
  });

  it("adds the model itself when the plan forgets an uploaded image", async () => {
    scriptGemini(h, { plan: { ...PLAN, assets: [asset("hero", { name: "Hero", kind: "character", prompt: "a small robot", rig: "humanoid", sizeMeters: 1 }), PLAN.assets[1]] } });
    const meshy = scriptMeshy(h);
    const token = await h.token("user_img_forgot");
    const projectId = await newProject(token, "A robot walks.");
    await upload(token, projectId, png(900, 903));
    const started = await h.json(`/api/projects/${projectId}/generate`, { token, body: { render: false } });
    await advanceJob(h.env, started.body.job.id);
    await advanceJob(h.env, started.body.job.id);
    await advanceJob(h.env, started.body.job.id);
    expect(meshy.created.filter((c) => c.kind === "image")).toHaveLength(1);
    const rows = await h.db.prepare("SELECT name, source_image_key FROM assets WHERE user_id = 'user_img_forgot' ORDER BY name").all<{ name: string; source_image_key: string | null }>();
    expect(rows.results.find((r) => r.name === "Red toy robot")!.source_image_key).toMatch(/^users\/user_img_forgot\/uploads\/.+\.png$/);
  });

  it("needs an idea or an image: neither is refused, and unusable images alone fail with a clear reason and a refund", async () => {
    const unusable = { index: 1, subject: "", usable: false, reason: "It is a screenshot of text.", kind: "prop", humanoid: false, description: "" };
    scriptGemini(h, { interpret: { ...INTERPRETATION, images: [unusable] } });
    scriptMeshy(h);
    const token = await h.token("user_img_none");
    const empty = await newProject(token);
    const refused = await h.json(`/api/projects/${empty}/generate`, { token, body: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("invalid_prompt");

    await upload(token, empty, png(900, 904));
    const started = await h.json(`/api/projects/${empty}/generate`, { token, body: {} });
    expect(started.status).toBe(202);
    await drive(started.body.job.id);
    const job = (await h.json(`/api/jobs/${started.body.job.id}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "invalid_prompt" } });
    expect(job.error.message).toMatch(/None of the uploaded images shows one clear object.*image 1: It is a screenshot of text/);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("fails with Meshy's reason, and refunds, when Meshy refuses the image", async () => {
    scriptGemini(h);
    scriptMeshy(h, { rejectImage: { status: 400, message: "The image was blocked by content moderation." } });
    const token = await h.token("user_img_blocked");
    const projectId = await newProject(token, "The toy walks.");
    await upload(token, projectId, png(900, 905));
    const started = await h.json(`/api/projects/${projectId}/generate`, { token, body: {} });
    await drive(started.body.job.id);
    const job = (await h.json(`/api/jobs/${started.body.job.id}`, { token })).body.job;
    expect(job).toMatchObject({ status: "failed", error: { code: "meshy_failed" } });
    expect(job.error.message).toMatch(/the uploaded image could not be used \(The image was blocked by content moderation\.\)/);
    expect((await h.json("/api/me", { token })).body.usage.used).toBe(0);
  });

  it("will not let an image be removed while a video is being generated from it", async () => {
    scriptGemini(h);
    scriptMeshy(h);
    const token = await h.token("user_img_busy");
    const projectId = await newProject(token, "The toy walks.");
    const image = (await upload(token, projectId, png(900, 906))).body.image;
    await h.json(`/api/projects/${projectId}/generate`, { token, body: {} });
    const res = await h.json(`/api/projects/${projectId}/images/${image.id}`, { method: "DELETE", token });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/being generated/);
  });
});
