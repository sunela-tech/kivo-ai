import { Hono } from "hono";
import { z } from "zod";
import {
  ASPECTS,
  RESOLUTIONS,
  SceneValidationError,
  VISUAL_STYLE_IDS,
  applyDirectorOps,
  errorMessage,
  normalizeScene,
  resolutionRank,
  type PlanLimits,
  type Resolution,
  type SceneSpec,
} from "@kivo/shared";
import { requireUser } from "../auth";
import { directScene } from "../director";
import { assetDto, jobDto, projectDto, videoDto, type VideoRow } from "../dto";
import type { AppBindings, Env } from "../env";
import { animationLibrary } from "../meshy";
import { clipNames, type AssetRow } from "../pipeline/assets";
import { loadProject, loadScene, saveScene, type JobRow, type ProjectRow } from "../pipeline/jobs";
import { enqueue, provisionAssets, type JobState } from "../pipeline/run";
import { rateLimit } from "../ratelimit";
import { reserveVideo, usageSummary, recordCost } from "../usage";
import { findStorage, requireStorageRoom, storage } from "../storage";
import { HttpError, PipelineError, newId, now } from "../util";

export const projects = new Hono<AppBindings>();
projects.use("*", requireUser);

const ProjectInput = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().max(2000).optional(),
  mode: z.enum(["simple", "advanced"]).optional(),
  style: z.string().refine((s) => VISUAL_STYLE_IDS.includes(s), "unknown style").optional(),
  duration: z.number().min(1).max(600).optional(),
  fps: z.number().int().min(12).max(120).optional(),
  aspect: z.enum(ASPECTS).optional(),
  resolution: z.enum(RESOLUTIONS).optional(),
});

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "internal", "The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, "internal", `Invalid request: ${issue?.path.join(".") || "body"} — ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** Every project query is scoped by owner: a project id from another account is simply "not found". */
async function ownProject(env: Env, userId: string, id: string): Promise<ProjectRow> {
  const project = await loadProject(env, id);
  if (!project || project.user_id !== userId) throw new HttpError(404, "internal", "Project not found.");
  return project;
}

function titleFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 7).join(" ");
  return (words.length > 60 ? `${words.slice(0, 57)}…` : words) || "Untitled project";
}

/** Defaults a new project to the most the user's plan can export. */
function defaultsFor(plan: PlanLimits) {
  return { duration: Math.min(5, plan.maxDurationSec), fps: Math.min(24, plan.maxFps), aspect: "16:9" as const, resolution: plan.maxResolution };
}

projects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200").bind(c.get("user").id).all<ProjectRow>();
  return c.json({ projects: await Promise.all(results.map((p) => projectDto(c.env, p))) });
});

projects.post("/", async (c) => {
  const input = await body(c, ProjectInput);
  const user = c.get("user");
  const plan = c.get("plan");
  await rateLimit(c.env, `projects:${user.id}`, 30, 60);
  const d = defaultsFor(plan);
  const id = newId("prj");
  const t = now();
  await c.env.DB.prepare(
    "INSERT INTO projects (id, user_id, title, prompt, mode, style, duration, fps, aspect, resolution, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
  )
    .bind(
      id,
      user.id,
      input.title ?? titleFromPrompt(input.prompt ?? ""),
      input.prompt ?? "",
      input.mode ?? "simple",
      input.style ?? "cinematic",
      input.duration ?? d.duration,
      input.fps ?? d.fps,
      input.aspect ?? d.aspect,
      input.resolution ?? d.resolution,
      t,
      t,
    )
    .run();
  return c.json({ project: await projectDto(c.env, (await loadProject(c.env, id))!) }, 201);
});

projects.get("/:id", async (c) => {
  const user = c.get("user");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const [video, jobs] = await Promise.all([
    project.latest_video_id ? c.env.DB.prepare("SELECT * FROM videos WHERE id = ? AND user_id = ?").bind(project.latest_video_id, user.id).first<VideoRow>() : null,
    c.env.DB.prepare("SELECT * FROM jobs WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 5").bind(project.id, user.id).all<JobRow>(),
  ]);
  return c.json({
    project: await projectDto(c.env, project),
    video: video ? await videoDto(c.env, video, project.title) : null,
    jobs: jobs.results.map(jobDto),
  });
});

projects.patch("/:id", async (c) => {
  const user = c.get("user");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const input = await body(c, ProjectInput);
  const fields = Object.entries(input).filter(([, v]) => v !== undefined);
  if (fields.length) {
    await c.env.DB.prepare(`UPDATE projects SET ${fields.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...fields.map(([, v]) => v), now(), project.id)
      .run();
  }
  return c.json({ project: await projectDto(c.env, (await loadProject(c.env, project.id))!) });
});

/** Delete a project with everything that belongs only to it: videos, scene versions, jobs, and unshared models. */
export async function deleteProject(env: Env, project: ProjectRow): Promise<void> {
  const active = await env.DB.prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running')").bind(project.id).all<{ id: string }>();
  for (const job of active.results) await env.DB.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").bind(job.id).run();

  const videos = await env.DB.prepare("SELECT r2_key, thumbnail_key FROM videos WHERE project_id = ?").bind(project.id).all<{ r2_key: string; thumbnail_key: string | null }>();
  const keys = videos.results.flatMap((v) => [v.r2_key, v.thumbnail_key]).filter((k): k is string => !!k);

  const orphans = await env.DB.prepare(
    "SELECT a.id, a.user_id FROM assets a JOIN project_assets pa ON pa.asset_id = a.id WHERE pa.project_id = ? AND NOT EXISTS (SELECT 1 FROM project_assets o WHERE o.asset_id = a.id AND o.project_id != ?)",
  )
    .bind(project.id, project.id)
    .all<{ id: string; user_id: string }>();
  const store = findStorage(env);
  if (store) {
    if (keys.length) await store.delete(keys);
    for (const asset of orphans.results) await store.deletePrefix(`users/${asset.user_id}/assets/${asset.id}/`);
  }

  const statements = [
    env.DB.prepare("DELETE FROM videos WHERE project_id = ?").bind(project.id),
    env.DB.prepare("DELETE FROM render_jobs WHERE project_id = ?").bind(project.id),
    env.DB.prepare("DELETE FROM scenes WHERE project_id = ?").bind(project.id),
    env.DB.prepare("DELETE FROM project_assets WHERE project_id = ?").bind(project.id),
    env.DB.prepare("DELETE FROM jobs WHERE project_id = ? AND status NOT IN ('queued', 'running')").bind(project.id),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id),
  ];
  for (const asset of orphans.results) statements.push(env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(asset.id));
  await env.DB.batch(statements);
}

projects.delete("/:id", async (c) => {
  const project = await ownProject(c.env, c.get("user").id, c.req.param("id"));
  await deleteProject(c.env, project);
  return c.json({ deleted: true });
});

projects.post("/:id/duplicate", async (c) => {
  const user = c.get("user");
  const source = await ownProject(c.env, user.id, c.req.param("id"));
  await rateLimit(c.env, `projects:${user.id}`, 30, 60);
  const id = newId("prj");
  const t = now();
  // The copy shares the generated models (no new Meshy cost) and starts from the current scene. It has no videos yet.
  await c.env.DB.prepare(
    "INSERT INTO projects (id, user_id, title, prompt, mode, style, duration, fps, aspect, resolution, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, `${source.title} (copy)`.slice(0, 120), source.prompt, source.mode, source.style, source.duration, source.fps, source.aspect, source.resolution, source.scene_id ? "scene_ready" : "draft", t, t)
    .run();
  await c.env.DB.prepare("INSERT INTO project_assets (project_id, alias, asset_id) SELECT ?, alias, asset_id FROM project_assets WHERE project_id = ?").bind(id, source.id).run();
  if (source.scene_id) {
    const scene = await loadScene(c.env, source.scene_id);
    if (scene) await saveScene(c.env, id, user.id, scene.spec, "user", `Duplicated from "${source.title}"`);
  }
  return c.json({ project: await projectDto(c.env, (await loadProject(c.env, id))!) }, 201);
});

// ───────────── jobs: generate and render ─────────────

/**
 * Create a job, enforcing the plan's concurrency limit and monthly quota on the
 * backend. Both checks are single SQL statements, so parallel requests cannot
 * slip past them.
 */
async function startJob(
  env: Env,
  userId: string,
  plan: PlanLimits,
  project: ProjectRow,
  job: { kind: "generate" | "render" | "director"; stage: string; params: Record<string, unknown>; state?: JobState; charge: "video" | "none" },
): Promise<JobRow> {
  // No storage (or no room left in it), no generation: refuse before anything is created or charged.
  await requireStorageRoom(env);
  const id = newId("job");
  const t = now();
  const inserted = await env.DB.prepare(
    `INSERT INTO jobs (id, user_id, project_id, kind, status, stage, plan, params, state, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')) < ?`,
  )
    .bind(id, userId, project.id, job.kind, job.stage, plan.id, JSON.stringify(job.params), JSON.stringify(job.state ?? {}), t, t, userId, plan.concurrentJobs)
    .run();
  if (inserted.meta.changes === 0) {
    throw new HttpError(429, "concurrency_exceeded", `The ${plan.name} plan runs ${plan.concurrentJobs} job${plan.concurrentJobs === 1 ? "" : "s"} at a time. Wait for the current one to finish, or cancel it.`);
  }
  if (job.charge === "video") {
    const reserved = await reserveVideo(env, userId, id, plan, job.kind);
    if (!reserved) {
      await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
      const usage = await usageSummary(env, userId, plan);
      throw new HttpError(402, "quota_exceeded", `You've used all ${plan.videosPerMonth} videos included in the ${plan.name} plan this month.`, { usage });
    }
  }
  try {
    await enqueue(env, id);
  } catch (error) {
    // Could not queue: undo, so the user is neither charged nor left with a stuck job.
    const { failJob, loadJob } = await import("../pipeline/jobs");
    const row = await loadJob(env, id);
    if (row) await failJob(env, row, "internal", "The job could not be queued. Your quota was not charged — try again.");
    throw new HttpError(503, "internal", "The job could not be queued. Try again.");
  }
  return (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>())!;
}

const GenerateInput = z.object({
  /** true: straight to a finished video (Simple Mode). false: stop at an editable scene (Advanced Mode). */
  render: z.boolean().default(true),
});

projects.post("/:id/generate", async (c) => {
  const user = c.get("user");
  const plan = c.get("plan");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const input = await body(c, GenerateInput);
  await rateLimit(c.env, `generate:${user.id}`, 10, 60);
  if (project.prompt.trim().length < 3) throw new HttpError(400, "invalid_prompt");

  // Plan limits are applied here, on the server, to whatever the client asked for.
  const duration = Math.min(project.duration, plan.maxDurationSec);
  const fps = Math.min(project.fps, plan.maxFps);
  const resolution = (resolutionRank(project.resolution as Resolution) > resolutionRank(plan.maxResolution) ? plan.maxResolution : project.resolution) as Resolution;

  const job = await startJob(c.env, user.id, plan, project, {
    kind: "generate",
    stage: "understanding_prompt",
    params: { prompt: project.prompt, style: project.style, duration, fps, aspect: project.aspect, resolution, render: input.render },
    charge: "video",
  });
  await c.env.DB.prepare("UPDATE projects SET status = 'generating', updated_at = ? WHERE id = ?").bind(now(), project.id).run();
  return c.json({ job: jobDto(job), usage: await usageSummary(c.env, user.id, plan) }, 202);
});

const RenderInput = z.object({ resolution: z.enum(RESOLUTIONS).optional() });

projects.post("/:id/render", async (c) => {
  const user = c.get("user");
  const plan = c.get("plan");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const input = await body(c, RenderInput);
  await rateLimit(c.env, `generate:${user.id}`, 10, 60);
  if (!project.scene_id) throw new HttpError(400, "invalid_scene", "This project has no scene yet. Generate one first.");

  // A scene-only generation already paid for this project's first render.
  const credit = await c.env.DB.prepare("UPDATE projects SET render_credits = render_credits - 1 WHERE id = ? AND render_credits > 0").bind(project.id).run();
  const usedRenderCredit = credit.meta.changes > 0;
  try {
    const job = await startJob(c.env, user.id, plan, project, {
      kind: "render",
      stage: "preparing_rendering",
      params: { sceneId: project.scene_id, resolution: input.resolution ?? project.resolution, usedRenderCredit },
      charge: usedRenderCredit ? "none" : "video",
    });
    return c.json({ job: jobDto(job), usage: await usageSummary(c.env, user.id, plan) }, 202);
  } catch (error) {
    if (usedRenderCredit) await c.env.DB.prepare("UPDATE projects SET render_credits = render_credits + 1 WHERE id = ?").bind(project.id).run();
    throw error;
  }
});

// ───────────── scene ─────────────

async function projectAssets(env: Env, projectId: string): Promise<{ alias: string; row: AssetRow }[]> {
  const { results } = await env.DB.prepare("SELECT pa.alias AS __alias, a.* FROM project_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.project_id = ?")
    .bind(projectId)
    .all<AssetRow & { __alias: string }>();
  return results.map((r) => ({ alias: r.__alias, row: r }));
}

async function sceneResponse(env: Env, project: ProjectRow) {
  const scene = project.scene_id ? await loadScene(env, project.scene_id) : null;
  const assets = await projectAssets(env, project.id);
  const files: Record<string, unknown> = {};
  for (const { alias, row } of assets) files[alias] = await assetDto(env, row, true);
  return { sceneId: scene?.id ?? null, version: scene?.version ?? 0, spec: scene?.spec ?? null, assets: files };
}

projects.get("/:id/scene", async (c) => {
  const project = await ownProject(c.env, c.get("user").id, c.req.param("id"));
  return c.json(await sceneResponse(c.env, project));
});

const SceneInput = z.object({ spec: z.unknown(), note: z.string().max(200).optional() });

projects.put("/:id/scene", async (c) => {
  const user = c.get("user");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const input = await body(c, SceneInput);
  await rateLimit(c.env, `scene:${user.id}`, 120, 60);
  const assets = await projectAssets(c.env, project.id);
  let normalized;
  try {
    // Editing is unrestricted on every plan: only structural validity is enforced here, never plan limits.
    normalized = normalizeScene(input.spec, { availableClips: Object.fromEntries(assets.map((a) => [a.alias, clipNames(a.row)])) });
  } catch (error) {
    if (error instanceof SceneValidationError) throw new HttpError(422, "invalid_scene", `The scene could not be saved: ${error.issues[0]}`, { issues: error.issues });
    throw error;
  }
  // A scene may only reference models that belong to this project.
  const known = new Set(assets.map((a) => a.alias));
  const unknown = normalized.spec.assets.filter((a) => !known.has(a.id)).map((a) => a.id);
  if (unknown.length) throw new HttpError(422, "invalid_scene", `The scene references models that are not part of this project: ${unknown.join(", ")}.`);

  const sceneId = await saveScene(c.env, project.id, user.id, normalized.spec, "user", input.note ?? null);
  await c.env.DB.prepare("UPDATE projects SET duration = ?, fps = ?, aspect = ?, status = CASE WHEN status = 'draft' THEN 'scene_ready' ELSE status END, updated_at = ? WHERE id = ?")
    .bind(normalized.spec.output.duration, normalized.spec.output.fps, normalized.spec.output.aspect, now(), project.id)
    .run();
  const scene = await loadScene(c.env, sceneId);
  return c.json({ sceneId, version: scene?.version ?? 0, spec: normalized.spec, warnings: normalized.warnings });
});

projects.get("/:id/scenes", async (c) => {
  const project = await ownProject(c.env, c.get("user").id, c.req.param("id"));
  const { results } = await c.env.DB.prepare("SELECT id, version, source, note, created_at FROM scenes WHERE project_id = ? ORDER BY version DESC LIMIT 40").bind(project.id).all();
  return c.json({ current: project.scene_id, versions: results });
});

projects.post("/:id/scenes/:sceneId/restore", async (c) => {
  const user = c.get("user");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const scene = await loadScene(c.env, c.req.param("sceneId"));
  if (!scene || scene.project_id !== project.id) throw new HttpError(404, "internal", "Scene version not found.");
  await saveScene(c.env, project.id, user.id, scene.spec, "user", `Restored version ${scene.version}`);
  return c.json(await sceneResponse(c.env, (await loadProject(c.env, project.id))!));
});

// ───────────── AI Director ─────────────

const DirectorInput = z.object({ instruction: z.string().trim().min(3).max(800) });

projects.post("/:id/director", async (c) => {
  const user = c.get("user");
  const plan = c.get("plan");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const input = await body(c, DirectorInput);
  await rateLimit(c.env, `director:${user.id}`, 12, 60);
  await rateLimit(c.env, `director-day:${user.id}`, 300, 86400);
  if (!project.scene_id) throw new HttpError(400, "invalid_scene", "Generate a scene first, then direct it.");
  const scene = await loadScene(c.env, project.scene_id);
  if (!scene) throw new HttpError(404, "internal", "Scene not found.");

  const assets = await projectAssets(c.env, project.id);
  const clips = Object.fromEntries(assets.map((a) => [a.alias, clipNames(a.row)]));
  const rigged = Object.fromEntries(Object.entries(clips).filter(([, list]) => list.length > 0));

  let reply;
  let library;
  try {
    library = await animationLibrary(c.env).catch(() => []);
    reply = await directScene(c.env, scene.spec, input.instruction, rigged, plan, library);
  } catch (error) {
    if (error instanceof PipelineError) throw new HttpError(error.retryable ? 503 : 422, error.code, error.code === "prompt_rejected" ? error.message : errorMessage(error.code));
    throw error;
  }
  await recordCost(c.env, user.id, null, "gemini", reply.tokens, `director (${reply.model})`);

  const { data } = reply;
  if (data.operations.length === 0) {
    return c.json({ changed: false, summary: data.summary, cannotDo: data.cannotDo || "The director did not find a change to make. Try rephrasing the request.", applied: [], skipped: [] });
  }
  const result = applyDirectorOps(scene.spec, data.operations, { limits: plan, library });
  if (result.applied.length === 0) {
    return c.json({ changed: false, summary: data.summary, cannotDo: data.cannotDo || "None of the requested changes could be applied.", applied: [], skipped: result.skipped });
  }

  if (result.newAssets.length > 0) {
    await requireStorageRoom(c.env);
    // New models are needed. Only those are generated — existing models are untouched.
    let provisioned;
    try {
      provisioned = await provisionAssets(c.env, user.id, project.id, plan, result.newAssets);
    } catch (error) {
      if (error instanceof PipelineError) throw new HttpError(error.code === "meshy_unavailable" ? 503 : 402, error.code, error.message);
      throw error;
    }
    const job = await startJob(c.env, user.id, plan, project, {
      kind: "director",
      stage: "generating_models",
      params: { instruction: input.instruction },
      state: { assetIds: provisioned.ids, pendingSpec: result.spec, pendingNote: input.instruction.slice(0, 200) },
      charge: "none",
    });
    return c.json(
      { changed: true, pending: true, summary: data.summary, cannotDo: data.cannotDo, applied: result.applied, skipped: result.skipped, newModels: result.newAssets.map((a) => a.name), job: jobDto(job) },
      202,
    );
  }

  let normalized;
  try {
    normalized = normalizeScene(result.spec, { availableClips: clips });
  } catch (error) {
    if (error instanceof SceneValidationError) {
      return c.json({ changed: false, summary: "", cannotDo: `The director's change produced an invalid scene (${error.issues[0]}), so nothing was changed. Try rephrasing.`, applied: [], skipped: result.skipped });
    }
    throw error;
  }
  const sceneId = await saveScene(c.env, project.id, user.id, normalized.spec, "director", input.instruction.slice(0, 200));
  await c.env.DB.prepare("UPDATE projects SET duration = ?, updated_at = ? WHERE id = ?").bind(normalized.spec.output.duration, now(), project.id).run();
  const saved = await loadScene(c.env, sceneId);
  return c.json({
    changed: true,
    pending: false,
    summary: data.summary,
    cannotDo: data.cannotDo,
    applied: result.applied,
    skipped: result.skipped,
    warnings: normalized.warnings,
    sceneId,
    version: saved?.version ?? 0,
    spec: normalized.spec,
  });
});

// ───────────── render history ─────────────

projects.get("/:id/videos", async (c) => {
  const user = c.get("user");
  const project = await ownProject(c.env, user.id, c.req.param("id"));
  const { results } = await c.env.DB.prepare("SELECT * FROM videos WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100").bind(project.id, user.id).all<VideoRow>();
  return c.json({ videos: await Promise.all(results.map((v) => videoDto(c.env, v, project.title))) });
});

export type { SceneSpec };
