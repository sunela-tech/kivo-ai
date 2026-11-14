import {
  MESHY_CREDITS,
  SceneValidationError,
  animationToScene,
  assembleScene,
  cinematographyToScene,
  clampRenderToPlan,
  matchClipsToMotion,
  normalizeScene,
  planToAssets,
  toId,
  type Aspect,
  type ImageBrief,
  type Interpretation,
  type PlanLimits,
  type Resolution,
  type SceneAsset,
  type SceneObject,
  type ScenePlan,
  type SceneSpec,
  type StageId,
  type Track,
  type World,
} from "@kivo/shared";
import { animateScene, interpretPrompt, motionSummary, planScene, shootScene, type AssetBrief, type GenerationSettings } from "../director";
import type { Env } from "../env";
import { Meshy, animationLibrary } from "../meshy";
import { getPlans } from "../plans";
import { globalMeshyCeiling, meshySpend, recordCost } from "../usage";
import { toBase64 } from "../images";
import { storage } from "../storage";
import { PipelineError, log, newId, now, parseJson } from "../util";
import { assetCacheKey, cancelPendingTasks, clipNames, loadAssets, tickAssets, type AssetRow } from "./assets";
import { addWarnings, cancelJob, completeJob, failJob, loadJob, loadProject, loadScene, patchJob, saveScene, type JobRow, type ProjectRow } from "./jobs";

/**
 * The generation pipeline, driven by Cloudflare Queues.
 *
 * A queue message is "advance job X". Each delivery takes a short lock, runs
 * the handler for the job's current stage, persists the result, and either
 * moves on, schedules itself again (polling Meshy), or parks (waiting for the
 * render service). All state lives in D1, so any delivery can resume a job
 * after a crash, a redeploy or a retry.
 */

export interface GenerateParams {
  prompt: string;
  style: string;
  duration: number;
  fps: number;
  aspect: Aspect;
  resolution: Resolution;
  /** false = stop when the scene is ready (Advanced Mode draft). */
  render: boolean;
  /** Reference images attached when the job started, in order: image 1, image 2, ... */
  images?: JobImage[];
}

/** One uploaded image as a job sees it. */
export interface JobImage {
  id: string;
  key: string;
  type: string;
  sha256: string;
  name: string;
}

export interface RenderParams {
  sceneId: string;
  resolution: Resolution;
}

export interface JobState {
  interpretation?: Interpretation;
  beats?: ScenePlan["beats"];
  world?: World;
  assets?: SceneAsset[];
  /** scene asset id -> assets row id */
  assetIds?: Record<string, string>;
  objects?: SceneObject[];
  tracks?: Track[];
  sceneId?: string;
  /** AI Director: the edited scene waiting for its new models. */
  pendingSpec?: SceneSpec;
  pendingNote?: string;
}

type Outcome =
  | { kind: "next"; stage: StageId; detail?: string }
  | { kind: "wait"; seconds: number; stage?: StageId; progress?: number | null; detail?: string }
  | { kind: "hold" }
  | { kind: "done"; result: "video" | "scene" };

const LOCK_MS = 150_000;
const TICK_BUDGET_MS = 20_000;
const MAX_ATTEMPTS = 6;
const ASSET_POLL_SECONDS = 4;

interface Ctx {
  env: Env;
  job: JobRow;
  project: ProjectRow;
  plan: PlanLimits;
  params: GenerateParams & RenderParams;
  state: JobState;
}

async function saveState(ctx: Ctx): Promise<void> {
  await patchJob(ctx.env, ctx.job, { state: JSON.stringify(ctx.state) });
}

function settingsOf(ctx: Ctx): GenerationSettings {
  return { duration: ctx.params.duration, fps: ctx.params.fps, aspect: ctx.params.aspect, style: ctx.params.style };
}

// ───────────── stage handlers ─────────────

/** Gemini's notes about the uploaded images, tidied: exactly one entry per image, in order. */
export function alignImageBriefs(briefs: ImageBrief[], count: number): ImageBrief[] {
  const out: ImageBrief[] = [];
  for (let index = 1; index <= count; index++) {
    const brief = briefs.find((b) => b.index === index);
    out.push(
      brief
        ? { ...brief, subject: brief.subject.trim().slice(0, 80), description: brief.description.trim().slice(0, 600), reason: brief.reason.trim().slice(0, 240) }
        : { index, subject: "", usable: false, reason: "Kivo could not tell what it shows.", kind: "prop", humanoid: false, description: "" },
    );
  }
  return out;
}

async function understandPrompt(ctx: Ctx): Promise<Outcome> {
  const prompt = ctx.params.prompt.trim();
  const attached = ctx.params.images ?? [];
  if (prompt.length < 3 && attached.length === 0) throw new PipelineError("invalid_prompt", "The prompt is empty. Describe who or what is in the scene and what happens.", false);

  // Gemini looks at the uploaded images themselves, once, here; later passes work from its notes.
  const images: { mimeType: string; data: string }[] = [];
  for (const image of attached) {
    let bytes: ArrayBuffer | null;
    try {
      bytes = (await (await storage(ctx.env).get(image.key))?.arrayBuffer()) ?? null;
    } catch {
      throw new PipelineError("storage_error", "An uploaded image could not be read.", true);
    }
    if (!bytes) throw new PipelineError("invalid_prompt", `The uploaded image "${image.name || "image"}" is no longer available. Upload it again and retry.`, false);
    images.push({ mimeType: image.type, data: toBase64(bytes) });
  }

  const reply = await interpretPrompt(ctx.env, prompt, settingsOf(ctx), images);
  await recordCost(ctx.env, ctx.job.user_id, ctx.job.id, "gemini", reply.tokens, `interpret (${reply.model})`);
  if (!reply.data.accepted) {
    throw new PipelineError("prompt_rejected", reply.data.rejectionReason.trim() || "That prompt can't be turned into a scene. Try describing a different one.", false);
  }
  reply.data.images = alignImageBriefs(reply.data.images, attached.length);
  if (attached.length > 0 && prompt.length < 3 && !reply.data.images.some((i) => i.usable)) {
    const why = reply.data.images.map((i) => `image ${i.index}: ${i.reason || "not one clear object"}`).join("; ");
    throw new PipelineError(
      "invalid_prompt",
      `None of the uploaded images shows one clear object or character that can become a 3D model (${why}). Upload a picture of a single thing on a plain background, or describe the scene in words.`,
      false,
    );
  }
  ctx.state.interpretation = reply.data;
  await saveState(ctx);
  const title = reply.data.title.trim().slice(0, 120);
  if (title) await ctx.env.DB.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?").bind(title, now(), ctx.project.id).run();
  return { kind: "next", stage: "planning_scene" };
}

/** Credits a fresh generation of this asset will cost on Meshy. */
export function estimateCredits(asset: SceneAsset, model: PlanLimits["meshyModel"], fromImage = false): number {
  let credits = fromImage ? MESHY_CREDITS.imageTo3d[model] : MESHY_CREDITS.preview[model] + MESHY_CREDITS.refine;
  if (asset.rig === "humanoid") {
    credits += MESHY_CREDITS.rig + asset.actions.length * MESHY_CREDITS.animationAction;
    credits += asset.motions.length ? MESHY_CREDITS.textToMotionPrime + MESHY_CREDITS.animationAction : 0;
  }
  return credits;
}

/**
 * Create (or reuse) the asset rows for a list of scene assets, enforcing the
 * cost ceilings before a single Meshy credit is spent.
 */
export async function provisionAssets(
  env: Env,
  userId: string,
  projectId: string,
  plan: PlanLimits,
  assets: SceneAsset[],
  /** scene asset id -> the uploaded image that model is built from */
  sources: Record<string, JobImage> = {},
): Promise<{ ids: Record<string, string>; estimate: number; reused: number }> {
  const keyed = await Promise.all(
    assets.map(async (a) => ({ asset: a, source: sources[a.id] ?? null, cacheKey: await assetCacheKey(a, plan.meshyModel, plan.targetPolycount, sources[a.id]?.sha256) })),
  );
  const existing = new Map<string, AssetRow>();
  if (keyed.length) {
    const { results } = await env.DB.prepare(`SELECT * FROM assets WHERE user_id = ? AND cache_key IN (${keyed.map(() => "?").join(",")})`)
      .bind(userId, ...keyed.map((k) => k.cacheKey))
      .all<AssetRow>();
    for (const row of results) existing.set(row.cache_key, row);
  }

  let estimate = 0;
  let reused = 0;
  for (const { asset, cacheKey, source } of keyed) {
    const row = existing.get(cacheKey);
    if (row && row.status === "ready") reused++;
    else if (!row || row.status === "failed" || row.status === "pending") estimate += estimateCredits(asset, plan.meshyModel, !!source);
    // rows already in flight were paid for by the job that started them
  }

  if (estimate > plan.meshyCreditsPerJob) {
    throw new PipelineError("cost_ceiling", `This scene needs about ${estimate} Meshy credits, above the ${plan.name} plan's limit of ${plan.meshyCreditsPerJob} per job. Use fewer distinct objects.`, false);
  }
  if (estimate > 0) {
    const spend = await meshySpend(env, userId);
    if (spend.userToday + estimate > plan.meshyCreditsPerDay) {
      throw new PipelineError("daily_ceiling", `Today's 3D generation budget on the ${plan.name} plan is used up. Try again tomorrow, or reuse models you already have.`, false);
    }
    if (spend.globalToday + estimate > globalMeshyCeiling(env)) {
      throw new PipelineError("daily_ceiling", "Kivo has reached today's overall 3D generation budget. Try again tomorrow.", false);
    }
    let balance: number;
    try {
      balance = await new Meshy(env).balance();
    } catch (error) {
      throw Meshy.toPipelineError(error, "the credit balance check");
    }
    if (balance < estimate) {
      log("meshy_balance_low", { balance, estimate });
      throw new PipelineError("meshy_credits", "3D generation is paused because the service's Meshy credits are exhausted. Your quota was not charged.", false);
    }
  }

  const ids: Record<string, string> = {};
  const t = now();
  for (const { asset, cacheKey, source } of keyed) {
    // The same picture uploaded again points the model at the newest copy of the file.
    const row = await env.DB.prepare(
      `INSERT INTO assets (id, user_id, cache_key, name, kind, prompt, rig_mode, ai_model, spec, status, source_image_key, source_image_type, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, cache_key) DO UPDATE SET last_used_at = excluded.last_used_at,
         source_image_key = COALESCE(excluded.source_image_key, assets.source_image_key),
         source_image_type = COALESCE(excluded.source_image_type, assets.source_image_type)
       RETURNING id, status`,
    )
      .bind(newId("ast"), userId, cacheKey, asset.name, asset.kind, asset.prompt, asset.rig, plan.meshyModel, JSON.stringify(asset), source?.key ?? null, source?.type ?? null, t, t, t)
      .first<{ id: string; status: string }>();
    if (!row) throw new PipelineError("internal", "Could not record a model.", true);
    if (row.status === "failed") {
      // A new job may try a previously failed model again.
      await env.DB.prepare(
        "UPDATE assets SET status = 'pending', error = NULL, retries = 0, progress = 0, preview_task_id = NULL, refine_task_id = NULL, rig_task_id = NULL, anim_task_id = NULL, motion_task_id = NULL, motion_anim_task_id = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
      )
        .bind(t, row.id)
        .run();
    }
    ids[asset.id] = row.id;
    await env.DB.prepare("INSERT INTO project_assets (project_id, alias, asset_id) VALUES (?, ?, ?) ON CONFLICT (project_id, alias) DO UPDATE SET asset_id = excluded.asset_id")
      .bind(projectId, asset.id, row.id)
      .run();
  }
  return { ids, estimate, reused };
}

async function planTheScene(ctx: Ctx): Promise<Outcome> {
  const interpretation = ctx.state.interpretation;
  if (!interpretation) return { kind: "next", stage: "understanding_prompt" };
  const library = await animationLibrary(ctx.env);
  const attached = ctx.params.images ?? [];
  const seen = alignImageBriefs(interpretation.images ?? [], attached.length);
  const reply = await planScene(ctx.env, interpretation, ctx.params.prompt, settingsOf(ctx), ctx.plan, library, seen);
  await recordCost(ctx.env, ctx.job.user_id, ctx.job.id, "gemini", reply.tokens, `plan (${reply.model})`);
  const { assets, world, notes, imageOf } = planToAssets(reply.data, ctx.plan, ctx.params.style, library, seen);
  if (assets.length === 0) throw new PipelineError("gemini_invalid_output", "The plan contained no models.", true);

  // Which uploaded file each image-made model comes from.
  const sources: Record<string, JobImage> = {};
  for (const [assetId, index] of Object.entries(imageOf)) {
    const image = attached[index - 1];
    if (image) sources[assetId] = image;
  }
  const provisioned = await provisionAssets(ctx.env, ctx.job.user_id, ctx.project.id, ctx.plan, assets, sources);
  ctx.state.assets = assets;
  ctx.state.assetIds = provisioned.ids;
  ctx.state.world = world;
  ctx.state.beats = reply.data.beats
    .map((b) => ({ start: Math.max(0, b.start), end: Math.min(ctx.params.duration, b.end), description: b.description.slice(0, 400) }))
    .filter((b) => b.end > b.start);
  await saveState(ctx);
  await addWarnings(ctx.env, ctx.job, notes);
  log("scene_planned", { job: ctx.job.id, assets: assets.length, fromImages: Object.keys(sources).length, reused: provisioned.reused, estimate: provisioned.estimate });
  return { kind: "next", stage: "generating_models", detail: provisioned.reused ? `Reusing ${provisioned.reused} of your existing models` : undefined };
}

async function advanceAssets(ctx: Ctx): Promise<Outcome> {
  const ids = Object.values(ctx.state.assetIds ?? {});
  if (ids.length === 0) {
    if (ctx.job.kind === "director") return finishDirector(ctx);
    return { kind: "next", stage: "planning_scene" };
  }
  const tick = await tickAssets({ env: ctx.env, meshy: new Meshy(ctx.env), plan: ctx.plan, jobId: ctx.job.id, budget: { left: 30 } }, ids);
  if (tick.phase === "done") {
    if (ctx.job.kind === "director") return finishDirector(ctx);
    return { kind: "next", stage: "creating_animations" };
  }
  const stage: StageId = tick.phase === "models" ? "generating_models" : tick.phase === "textures" ? "preparing_textures" : "rigging_characters";
  return { kind: "wait", seconds: ASSET_POLL_SECONDS, stage, progress: tick.progress, detail: tick.detail };
}

function briefs(assets: SceneAsset[], rows: AssetRow[], ids: Record<string, string>): AssetBrief[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return assets.map((a) => {
    const row = byId.get(ids[a.id]!);
    const rigged = row?.rig_status === "rigged";
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      sizeMeters: a.size.meters,
      sizeAxis: a.size.axis,
      rigged,
      clips: row ? clipNames(row) : [],
      note: !rigged && a.rig === "humanoid" ? "rigging was not possible for this model" : undefined,
    };
  });
}

async function createAnimations(ctx: Ctx): Promise<Outcome> {
  const { interpretation, assets, assetIds, beats } = ctx.state;
  if (!interpretation || !assets || !assetIds) return { kind: "next", stage: "planning_scene" };
  const rows = await loadAssets(ctx.env, Object.values(assetIds));
  const reply = await animateScene(ctx.env, interpretation, beats ?? [], briefs(assets, rows, assetIds), settingsOf(ctx));
  await recordCost(ctx.env, ctx.job.user_id, ctx.job.id, "gemini", reply.tokens, `animate (${reply.model})`);
  const { objects, tracks } = animationToScene(reply.data);
  const known = new Set(assets.map((a) => a.id));
  if (!objects.some((o) => known.has(o.assetId))) throw new PipelineError("gemini_invalid_output", "The animation placed no known models.", true);
  ctx.state.objects = objects;
  ctx.state.tracks = tracks;
  await saveState(ctx);
  return { kind: "next", stage: "adjusting_cameras" };
}

/** Clip names that really exist, per scene asset id. */
async function availableClips(env: Env, assetIds: Record<string, string>): Promise<{ clips: Record<string, string[]>; rows: Map<string, AssetRow> }> {
  const rows = await loadAssets(env, Object.values(assetIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const clips: Record<string, string[]> = {};
  const byAlias = new Map<string, AssetRow>();
  for (const [alias, id] of Object.entries(assetIds)) {
    const row = byId.get(id);
    if (!row) continue;
    byAlias.set(alias, row);
    clips[alias] = clipNames(row);
  }
  return { clips, rows: byAlias };
}

function rigWarnings(assets: SceneAsset[], rows: Map<string, AssetRow>): string[] {
  const out: string[] = [];
  for (const a of assets) {
    const row = rows.get(a.id);
    if (!row) continue;
    if (a.rig === "humanoid" && row.rig_status !== "rigged") out.push(`"${a.name}": ${row.rig_note ?? "could not be rigged, so it moves as a rigid body."}`);
    else if (row.rig_note) out.push(`"${a.name}": ${row.rig_note}`);
    if (row.error && row.status === "ready") out.push(`"${a.name}": ${row.error}`);
  }
  return out;
}

async function adjustCamerasStage(ctx: Ctx): Promise<Outcome> {
  const { interpretation, assets, assetIds, objects, tracks, world, beats } = ctx.state;
  if (!interpretation || !assets || !assetIds || !objects || !tracks || !world) return { kind: "next", stage: "creating_animations" };
  const settings = settingsOf(ctx);
  const reply = await shootScene(ctx.env, interpretation, beats ?? [], motionSummary(objects, tracks, assets, settings.duration), settings);
  await recordCost(ctx.env, ctx.job.user_id, ctx.job.id, "gemini", reply.tokens, `cinematography (${reply.model})`);
  const cine = cinematographyToScene(reply.data, (raw) => objects.find((o) => o.id === raw || o.id === toId(raw))?.id ?? null);

  const available = await availableClips(ctx.env, assetIds);
  let normalized;
  try {
    normalized = normalizeScene(
      assembleScene({
        title: interpretation.title || ctx.project.title,
        logline: interpretation.logline,
        style: ctx.params.style,
        output: { duration: settings.duration, fps: settings.fps, aspect: ctx.params.aspect },
        world,
        assets,
        objects,
        tracks: [...tracks, ...cine.tracks],
        cameras: cine.cameras,
        shots: cine.shots,
        lights: cine.lights,
      }),
      { maxDurationSec: ctx.plan.maxDurationSec, maxFps: ctx.plan.maxFps, maxAssets: ctx.plan.maxAssetsPerScene, availableClips: available.clips },
    );
  } catch (error) {
    if (error instanceof SceneValidationError) throw new PipelineError("gemini_invalid_output", `The directed scene failed validation: ${error.issues.slice(0, 3).join("; ")}`, true);
    throw error;
  }
  if (normalized.spec.objects.length === 0) throw new PipelineError("gemini_invalid_output", "The directed scene had no valid objects.", true);
  // Make stride agree with travel speed (walk ↔ run, playback speed, idle when standing).
  const gaitNotes = matchClipsToMotion(normalized.spec, available.clips);

  ctx.state.sceneId = await saveScene(ctx.env, ctx.project.id, ctx.job.user_id, normalized.spec, "gemini", "Generated from prompt");
  await saveState(ctx);
  await addWarnings(ctx.env, ctx.job, [...normalized.warnings, ...gaitNotes, ...rigWarnings(assets, available.rows)]);

  if (!ctx.params.render) {
    // The reserved video stays attached to the project: its first render is already paid for.
    await ctx.env.DB.prepare("UPDATE projects SET status = 'scene_ready', render_credits = render_credits + 1, updated_at = ? WHERE id = ?").bind(now(), ctx.project.id).run();
    return { kind: "done", result: "scene" };
  }
  return { kind: "next", stage: "preparing_rendering" };
}

/** Hand the scene to the render queue. The job then waits for the Blender service's events. */
async function prepareRendering(ctx: Ctx): Promise<Outcome> {
  if (ctx.job.render_job_id) return { kind: "hold" };
  const sceneId = ctx.state.sceneId ?? ctx.params.sceneId ?? ctx.project.scene_id;
  const scene = sceneId ? await loadScene(ctx.env, sceneId) : null;
  if (!scene || scene.project_id !== ctx.project.id) throw new PipelineError("invalid_scene", "This project has no scene to render yet.", false);

  const visibleAssets = new Set(scene.spec.objects.filter((o) => o.visible).map((o) => o.assetId));
  if (visibleAssets.size === 0) throw new PipelineError("invalid_scene", "The scene has no visible objects. Add or show at least one model.", false);
  const { results: links } = await ctx.env.DB.prepare(
    "SELECT pa.alias, a.id, a.status, a.model_key, a.name FROM project_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.project_id = ?",
  )
    .bind(ctx.project.id)
    .all<{ alias: string; id: string; status: string; model_key: string | null; name: string }>();
  const byAlias = new Map(links.map((l) => [l.alias, l]));
  for (const alias of visibleAssets) {
    const link = byAlias.get(alias);
    if (!link || link.status !== "ready" || !link.model_key) {
      throw new PipelineError("invalid_scene", `The model "${link?.name ?? alias}" has not finished generating, so the scene cannot be rendered yet.`, false);
    }
    // The file must really be in storage: a render never starts with a missing model.
    const head = await storage(ctx.env).head(link.model_key).catch(() => null);
    if (!head || head.size === 0) throw new PipelineError("storage_error", `The stored file for "${link.name}" is missing.`, false);
  }

  const clamped = clampRenderToPlan(
    { duration: scene.spec.output.duration, fps: scene.spec.output.fps, aspect: scene.spec.output.aspect, resolution: ctx.params.resolution },
    ctx.plan,
  );
  const frames = Math.max(1, Math.round(clamped.duration * clamped.fps));
  const quality = ["draft", "standard", "high"].includes(ctx.env.RENDER_QUALITY ?? "") ? ctx.env.RENDER_QUALITY! : "standard";
  const settings = {
    width: clamped.width,
    height: clamped.height,
    fps: clamped.fps,
    duration: clamped.duration,
    watermark: clamped.watermark,
    quality,
    maxRenderSeconds: ctx.plan.maxRenderMinutes * 60,
    resolution: clamped.resolution,
  };
  const renderId = newId("rnd");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "INSERT INTO render_jobs (id, job_id, project_id, user_id, scene_id, status, priority, pixels, settings, frames_total, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
    ).bind(renderId, ctx.job.id, ctx.project.id, ctx.job.user_id, scene.id, ctx.plan.renderPriority, clamped.width * clamped.height, JSON.stringify(settings), frames, now()),
    ctx.env.DB.prepare("UPDATE jobs SET render_job_id = ?, detail = ?, progress = NULL, updated_at = ? WHERE id = ?").bind(renderId, "Waiting for a render worker", now(), ctx.job.id),
    ctx.env.DB.prepare("UPDATE projects SET status = 'rendering', updated_at = ? WHERE id = ?").bind(now(), ctx.project.id),
  ]);
  ctx.job.render_job_id = renderId;
  await addWarnings(ctx.env, ctx.job, clamped.adjustments);
  log("render_queued", { job: ctx.job.id, render: renderId, priority: ctx.plan.renderPriority, frames, size: `${clamped.width}x${clamped.height}` });
  return { kind: "hold" };
}

/** AI Director: the new models are ready — validate the edited scene and save it as a new version. */
async function finishDirector(ctx: Ctx): Promise<Outcome> {
  const pending = ctx.state.pendingSpec;
  if (!pending) throw new PipelineError("internal", "The edited scene was lost.", false);
  const { results: links } = await ctx.env.DB.prepare("SELECT alias, asset_id FROM project_assets WHERE project_id = ?").bind(ctx.project.id).all<{ alias: string; asset_id: string }>();
  const available = await availableClips(ctx.env, Object.fromEntries(links.map((l) => [l.alias, l.asset_id])));
  let normalized;
  try {
    normalized = normalizeScene(pending, { maxAssets: ctx.plan.maxAssetsPerScene, availableClips: available.clips });
  } catch (error) {
    if (error instanceof SceneValidationError) throw new PipelineError("invalid_scene", `The edited scene failed validation: ${error.issues.slice(0, 3).join("; ")}`, false);
    throw error;
  }
  ctx.state.sceneId = await saveScene(ctx.env, ctx.project.id, ctx.job.user_id, normalized.spec, "director", ctx.state.pendingNote ?? "AI Director edit");
  ctx.state.pendingSpec = undefined;
  await saveState(ctx);
  await addWarnings(ctx.env, ctx.job, [...normalized.warnings, ...rigWarnings(normalized.spec.assets, available.rows)]);
  return { kind: "done", result: "scene" };
}

const GENERIC_FAILURES = new Set(["gemini_unavailable", "gemini_invalid_output", "meshy_unavailable", "meshy_credits", "storage_error", "internal", "interrupted"]);

const HANDLERS: Partial<Record<StageId, (ctx: Ctx) => Promise<Outcome>>> = {
  understanding_prompt: understandPrompt,
  planning_scene: planTheScene,
  generating_models: advanceAssets,
  preparing_textures: advanceAssets,
  rigging_characters: advanceAssets,
  creating_animations: createAnimations,
  adjusting_cameras: adjustCamerasStage,
  preparing_rendering: prepareRendering,
};

// ───────────── driver ─────────────

/**
 * Advance a job as far as it can go right now.
 * Returns the number of seconds after which it should be advanced again, or
 * null when it is finished or waiting for the render service.
 */
export async function advanceJob(env: Env, jobId: string): Promise<number | null> {
  const t = now();
  const lock = await env.DB.prepare("UPDATE jobs SET lock_until = ? WHERE id = ? AND lock_until < ? AND status IN ('queued', 'running')")
    .bind(t + LOCK_MS, jobId, t)
    .run();
  if (lock.meta.changes === 0) return null; // finished, or another delivery holds the lock (the sweeper covers a dead holder)

  let job = await loadJob(env, jobId);
  if (!job) return null;
  let again: number | null = null;
  try {
    const project = await loadProject(env, job.project_id);
    if (!project) {
      await cancelJob(env, job);
      return null;
    }
    const plan = getPlans(env)[job.plan] ?? getPlans(env).free;
    if (job.status === "queued") await patchJob(env, job, { status: "running", started_at: now() });

    const deadline = now() + TICK_BUDGET_MS;
    for (;;) {
      job = (await loadJob(env, jobId))!;
      if (job.status !== "running") return null;
      if (job.cancel_requested) {
        const state = parseJson<JobState>(job.state, {});
        await cancelPendingTasks(env, Object.values(state.assetIds ?? {})).catch(() => undefined);
        await cancelJob(env, job);
        return null;
      }
      const handler = HANDLERS[job.stage];
      if (!handler) return null; // rendering stages are driven by the render service's reports
      const ctx: Ctx = { env, job, project, plan, params: parseJson(job.params, {} as Ctx["params"]), state: parseJson<JobState>(job.state, {}) };
      const outcome = await handler(ctx);

      if (outcome.kind === "done") {
        await completeJob(env, job, outcome.result);
        return null;
      }
      if (outcome.kind === "hold") return null;
      if (outcome.kind === "next") {
        await patchJob(env, job, { stage: outcome.stage, progress: null, detail: outcome.detail ?? null, attempts: 0 });
        if (now() > deadline) return 0;
        continue;
      }
      // wait
      const stageChanged = outcome.stage && outcome.stage !== job.stage;
      await patchJob(env, job, {
        ...(outcome.stage ? { stage: outcome.stage } : {}),
        progress: outcome.progress ?? null,
        detail: outcome.detail ?? null,
        ...(stageChanged || job.attempts ? { attempts: 0 } : {}),
      });
      again = outcome.seconds;
      return again;
    }
  } catch (error) {
    const failure = error instanceof PipelineError ? error : new PipelineError("internal", error instanceof Error ? error.message : String(error), true);
    job = (await loadJob(env, jobId)) ?? job;
    if (!(error instanceof PipelineError)) log("pipeline_unexpected_error", { job: jobId, stage: job.stage, error: failure.message });
    if (failure.retryable && job.attempts + 1 < MAX_ATTEMPTS) {
      await patchJob(env, job, { attempts: job.attempts + 1, detail: "Retrying after a temporary problem" });
      log("job_retry", { job: jobId, stage: job.stage, attempt: job.attempts, code: failure.code });
      return Math.min(120, 8 * 2 ** job.attempts);
    }
    // Outages and internal faults get the plain, actionable message; the technical detail goes to the log.
    // Failures about the user's own content (a model Meshy could not build, a rejected prompt, a limit) keep their specifics.
    const generic = GENERIC_FAILURES.has(failure.code);
    if (generic) log("job_failure_detail", { job: jobId, stage: job.stage, code: failure.code, detail: failure.message });
    await failJob(env, job, failure.code, generic ? undefined : failure.message);
    return null;
  } finally {
    await env.DB.prepare("UPDATE jobs SET lock_until = 0 WHERE id = ? AND status IN ('queued', 'running')").bind(jobId).run();
  }
}

export async function enqueue(env: Env, jobId: string, delaySeconds = 0): Promise<void> {
  await env.PIPELINE.send({ jobId }, delaySeconds > 0 ? { delaySeconds: Math.min(900, Math.ceil(delaySeconds)) } : undefined);
}
