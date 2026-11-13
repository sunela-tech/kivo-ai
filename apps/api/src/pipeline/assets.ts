import { BUILTIN_CLIPS, type PlanLimits, type SceneAsset } from "@kivo/shared";
import type { Env } from "../env";
import { Meshy, MeshyHttpError, type MeshyTask, type TaskKind } from "../meshy";
import { recordCost } from "../usage";
import { PipelineError, fetchWithTimeout, log, now, parseJson, sha256Hex } from "../util";

/**
 * The life of one Meshy-generated model.
 *
 *   pending ─▶ preview ─▶ previewed ─▶ refine ─▶ stored ─┬─▶ ready            (rig: none)
 *                                                         └─▶ rigging ─▶ rigged ─▶ animating ─▶ animated
 *                                                               ─▶ motion ─▶ motioned ─▶ manimating ─▶ ready
 *
 * Each "create a Meshy task" step first moves the row into a `*_creating` state
 * with a compare-and-swap, so two queue deliveries (or two jobs sharing the
 * model) can never create — and pay for — the same task twice. If the create
 * response is lost, the row stays in `*_creating`; after a minute the newest
 * Meshy tasks are listed and the orphan is adopted instead of re-created.
 *
 * Rigging is best-effort by design: Meshy only rigs clear bipeds. When it
 * declines, the model is kept, marked `unsupported`, and animated as a rigid
 * body. It is never reported as rigged when it is not.
 */

export interface AssetRow {
  id: string;
  user_id: string;
  cache_key: string;
  name: string;
  kind: string;
  prompt: string;
  rig_mode: string;
  ai_model: string;
  spec: string;
  status: string;
  progress: number;
  rig_status: string;
  rig_note: string | null;
  preview_task_id: string | null;
  refine_task_id: string | null;
  rig_task_id: string | null;
  anim_task_id: string | null;
  motion_task_id: string | null;
  motion_anim_task_id: string | null;
  marker_at: number | null;
  retries: number;
  model_key: string | null;
  rigged_key: string | null;
  thumbnail_key: string | null;
  clips: string;
  bytes: number;
  credits: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
}

export type ClipMap = Record<string, { file: string; animation?: string }>;

export const MODEL_STATES = ["pending", "preview_creating", "preview"];
export const TEXTURE_STATES = ["previewed", "refine_creating", "refine"];
export const RIG_STATES = [
  "stored",
  "rig_creating",
  "rigging",
  "rigged",
  "anim_creating",
  "animating",
  "animated",
  "motion_creating",
  "motion",
  "motioned",
  "manim_creating",
  "manimating",
];

export interface AssetContext {
  env: Env;
  meshy: Meshy;
  plan: Pick<PlanLimits, "targetPolycount" | "texturePbr" | "meshyModel">;
  jobId: string | null;
  /** External requests this tick may still make (Workers cap subrequests per invocation). */
  budget: { left: number };
}

const RECOVERY_DELAY_MS = 60_000;
const TRANSIENT = new Set(["timeout", "service_unavailable", "server_error"]);

export function assetKey(userId: string, assetId: string, file: string): string {
  return `users/${userId}/assets/${assetId}/${file}`;
}

/** Assets are reused per user when the prompt, model tier and rig request are identical. */
export async function assetCacheKey(asset: SceneAsset, model: string, polycount: number): Promise<string> {
  const actions = asset.actions.map((a) => a.actionId).sort((a, b) => a - b);
  const motions = asset.motions.map((m) => `${m.prompt}|${m.duration}`);
  const normalized = asset.prompt.toLowerCase().replace(/\s+/g, " ").trim();
  return sha256Hex(JSON.stringify([normalized, asset.texturePrompt ?? "", asset.kind, asset.rig, model, polycount, actions, motions]));
}

export function clipNames(row: AssetRow): string[] {
  return row.rig_status === "rigged" ? Object.keys(parseJson<ClipMap>(row.clips, {})) : [];
}

async function update(env: Env, row: AssetRow, fields: Partial<AssetRow>, whereStatus?: string): Promise<boolean> {
  const entries = Object.entries({ ...fields, updated_at: now() });
  const sql = `UPDATE assets SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?${whereStatus ? " AND status = ?" : ""}`;
  const args = [...entries.map(([, v]) => v as unknown), row.id, ...(whereStatus ? [whereStatus] : [])];
  const res = await env.DB.prepare(sql)
    .bind(...args)
    .run();
  if (res.meta.changes > 0) Object.assign(row, fields);
  return res.meta.changes > 0;
}

function specOf(row: AssetRow): SceneAsset {
  return JSON.parse(row.spec) as SceneAsset;
}

/** Inspect a GLB: is it a real binary glTF, and does it carry textures? */
export function inspectGlb(buffer: ArrayBuffer): { valid: boolean; images: number; meshes: number; animations: string[] } {
  const bad = { valid: false, images: 0, meshes: 0, animations: [] as string[] };
  if (buffer.byteLength < 20) return bad;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) return bad; // "glTF"
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > buffer.byteLength) return bad; // "JSON"
  try {
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
      images?: unknown[];
      meshes?: unknown[];
      animations?: { name?: string }[];
    };
    return {
      valid: (json.meshes?.length ?? 0) > 0,
      images: json.images?.length ?? 0,
      meshes: json.meshes?.length ?? 0,
      animations: (json.animations ?? []).map((a) => a.name ?? ""),
    };
  } catch {
    return bad;
  }
}

async function download(ctx: AssetContext, url: string, what: string): Promise<ArrayBuffer> {
  ctx.budget.left--;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { timeoutMs: 120_000 });
  } catch {
    throw new PipelineError("meshy_unavailable", `Downloading ${what} from Meshy timed out.`, true);
  }
  if (!res.ok) throw new PipelineError("meshy_unavailable", `Downloading ${what} from Meshy failed (${res.status}).`, true);
  return res.arrayBuffer();
}

async function store(ctx: AssetContext, key: string, data: ArrayBuffer, contentType: string): Promise<void> {
  try {
    await ctx.env.BUCKET.put(key, data, { httpMetadata: { contentType } });
  } catch (error) {
    log("r2_put_failed", { key, error: String(error) });
    throw new PipelineError("storage_error", "Storing a generated model failed.", true);
  }
}

async function storeGlb(ctx: AssetContext, row: AssetRow, url: string, file: string): Promise<{ key: string; bytes: number; info: ReturnType<typeof inspectGlb> }> {
  const data = await download(ctx, url, `"${row.name}"`);
  const info = inspectGlb(data);
  if (!info.valid) throw new PipelineError("meshy_failed", `Meshy returned an unreadable file for "${row.name}".`, true);
  const key = assetKey(row.user_id, row.id, file);
  await store(ctx, key, data, "model/gltf-binary");
  return { key, bytes: data.byteLength, info };
}

async function charge(ctx: AssetContext, row: AssetRow, task: MeshyTask, what: string): Promise<void> {
  const credits = task.consumed_credits ?? 0;
  if (credits <= 0) return;
  await recordCost(ctx.env, row.user_id, ctx.jobId, "meshy", credits, `${what}: ${row.name}`);
  await ctx.env.DB.prepare("UPDATE assets SET credits = credits + ? WHERE id = ?").bind(credits, row.id).run();
  row.credits += credits;
}

async function poll(ctx: AssetContext, kind: TaskKind, id: string): Promise<MeshyTask | null> {
  ctx.budget.left--;
  try {
    return await ctx.meshy.getTask(kind, id);
  } catch (error) {
    if (error instanceof MeshyHttpError && error.status === 404) return null; // expired or deleted
    if (error instanceof MeshyHttpError && error.status === 401) throw Meshy.toPipelineError(error, "a task");
    throw new PipelineError("meshy_unavailable", "Meshy did not answer a status check.", true);
  }
}

/**
 * Run a "create task" step exactly once.
 * `from` must be the ready-to-create state; on success the row is in `to` with the task id stored.
 */
async function create(
  ctx: AssetContext,
  row: AssetRow,
  from: string,
  creating: string,
  to: string,
  field: keyof AssetRow,
  what: string,
  run: () => Promise<string | { id: string; fields: Partial<AssetRow> }>,
): Promise<"created" | "skipped" | { rejected: MeshyHttpError }> {
  if (!(await update(ctx.env, row, { status: creating, marker_at: now() }, from))) return "skipped"; // someone else is doing it
  ctx.budget.left--;
  try {
    const result = await run();
    const id = typeof result === "string" ? result : result.id;
    const extra = typeof result === "string" ? {} : result.fields;
    await update(ctx.env, row, { status: to, [field]: id, progress: 0, marker_at: null, ...extra } as Partial<AssetRow>);
    return "created";
  } catch (error) {
    if (error instanceof MeshyHttpError && error.definitelyNotCreated) {
      // 4xx: no task exists and nothing was charged. Put the row back and let the caller decide.
      await update(ctx.env, row, { status: from, marker_at: null });
      if (error.status === 429) throw Meshy.toPipelineError(error, what);
      return { rejected: error };
    }
    // Timeout / 5xx: the task may or may not exist. Stay in `creating`; recover() resolves it.
    throw Meshy.toPipelineError(error, what);
  }
}

/** Resolve a row stuck in a `*_creating` state after a lost create response. */
async function recover(
  ctx: AssetContext,
  row: AssetRow,
  kind: TaskKind,
  from: string,
  to: string,
  field: keyof AssetRow,
  matches: (task: MeshyTask) => boolean,
): Promise<boolean> {
  const marker = row.marker_at ?? 0;
  if (now() - marker < RECOVERY_DELAY_MS) return false; // give Meshy a minute before looking
  ctx.budget.left--;
  let recent: MeshyTask[];
  try {
    recent = await ctx.meshy.listRecent(kind);
  } catch {
    return false;
  }
  for (const task of recent) {
    if ((task.created_at ?? 0) < marker - 5_000 || !matches(task)) continue;
    const taken = await ctx.env.DB.prepare(`SELECT 1 AS x FROM assets WHERE ${String(field)} = ? AND id != ?`).bind(task.id, row.id).first();
    if (taken) continue;
    log("meshy_task_recovered", { asset: row.id, kind, task: task.id });
    return update(ctx.env, row, { status: to, [field]: task.id, marker_at: null } as Partial<AssetRow>, row.status);
  }
  // Not there: the create never happened. Safe to try again.
  return update(ctx.env, row, { status: from, marker_at: null }, row.status);
}

function failureMessage(task: MeshyTask): string {
  return task.task_error?.message?.slice(0, 240) || `Meshy task ${task.status.toLowerCase()}`;
}

async function failAsset(ctx: AssetContext, row: AssetRow, message: string): Promise<never> {
  await update(ctx.env, row, { status: "failed", error: message });
  throw new PipelineError("meshy_failed", `Meshy could not generate "${row.name}": ${message}`, false);
}

async function note(ctx: AssetContext, row: AssetRow, text: string): Promise<string> {
  return [row.rig_note, text].filter(Boolean).join(" ");
}

/**
 * Advance one asset by one step. Returns true if it moved (so the caller may
 * step again immediately) and false if it is waiting on Meshy.
 */
export async function stepAsset(ctx: AssetContext, row: AssetRow): Promise<boolean> {
  const spec = specOf(row);
  const label = `the model "${row.name}"`;

  switch (row.status) {
    // ── geometry ──
    case "pending": {
      const outcome = await create(ctx, row, "pending", "preview_creating", "preview", "preview_task_id", label, async () => {
        const made = await ctx.meshy.createPreview({
          prompt: row.prompt,
          model: row.ai_model as PlanLimits["meshyModel"],
          polycount: ctx.plan.targetPolycount,
          humanoid: row.rig_mode === "humanoid",
        });
        return { id: made.id, fields: { ai_model: made.model } };
      });
      if (typeof outcome === "object") throw Meshy.toPipelineError(outcome.rejected, label);
      return outcome === "created";
    }
    case "preview_creating":
      return recover(ctx, row, "text", "pending", "preview", "preview_task_id", (t) => (t.type ?? "").includes("preview") && t.prompt === row.prompt.slice(0, 800));
    case "preview": {
      const task = await poll(ctx, "text", row.preview_task_id!);
      if (!task) return update(ctx.env, row, { status: "pending", preview_task_id: null }, "preview");
      if (task.status === "SUCCEEDED") {
        await charge(ctx, row, task, "geometry");
        return update(ctx.env, row, { status: "previewed", progress: 0 }, "preview");
      }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        if (TRANSIENT.has(task.task_error?.type ?? "") && row.retries < 2) {
          return update(ctx.env, row, { status: "pending", preview_task_id: null, retries: row.retries + 1 }, "preview");
        }
        return failAsset(ctx, row, failureMessage(task));
      }
      if ((task.progress ?? 0) !== row.progress) await update(ctx.env, row, { progress: task.progress ?? 0 });
      return false;
    }

    // ── textures ──
    case "previewed": {
      const outcome = await create(ctx, row, "previewed", "refine_creating", "refine", "refine_task_id", `textures for "${row.name}"`, () =>
        ctx.meshy.createRefine(row.preview_task_id!, { pbr: ctx.plan.texturePbr, texturePrompt: spec.texturePrompt }),
      );
      if (typeof outcome === "object") throw Meshy.toPipelineError(outcome.rejected, `textures for "${row.name}"`);
      return outcome === "created";
    }
    case "refine_creating":
      return recover(ctx, row, "text", "previewed", "refine", "refine_task_id", (t) => (t.type ?? "").includes("refine") && t.prompt === row.prompt.slice(0, 800));
    case "refine": {
      const task = await poll(ctx, "text", row.refine_task_id!);
      if (!task) return update(ctx.env, row, { status: "previewed", refine_task_id: null }, "refine");
      if (task.status === "SUCCEEDED") {
        const url = task.model_urls?.glb;
        if (!url) return failAsset(ctx, row, "Meshy finished without a GLB file");
        const stored = await storeGlb(ctx, row, url, "model.glb");
        if (stored.info.images === 0 && row.retries < 1) {
          // Textures are missing: texture it once more rather than shipping a grey model.
          log("meshy_missing_textures", { asset: row.id });
          await charge(ctx, row, task, "textures");
          return update(ctx.env, row, { status: "previewed", refine_task_id: null, retries: row.retries + 1 }, "refine");
        }
        let thumbnailKey: string | null = null;
        if (task.thumbnail_url && ctx.budget.left > 0) {
          try {
            const png = await download(ctx, task.thumbnail_url, "a thumbnail");
            thumbnailKey = assetKey(row.user_id, row.id, "thumb.png");
            await store(ctx, thumbnailKey, png, "image/png");
          } catch {
            thumbnailKey = null; // a missing thumbnail never blocks a model
          }
        }
        await charge(ctx, row, task, "textures");
        return update(
          ctx.env,
          row,
          {
            status: "stored",
            model_key: stored.key,
            thumbnail_key: thumbnailKey,
            bytes: stored.bytes,
            progress: 0,
            error: stored.info.images === 0 ? "Meshy returned this model without textures." : null,
            rig_status: row.rig_mode === "humanoid" ? "pending" : "none",
          },
          "refine",
        );
      }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        if (TRANSIENT.has(task.task_error?.type ?? "") && row.retries < 2) {
          return update(ctx.env, row, { status: "previewed", refine_task_id: null, retries: row.retries + 1 }, "refine");
        }
        return failAsset(ctx, row, failureMessage(task));
      }
      if ((task.progress ?? 0) !== row.progress) await update(ctx.env, row, { progress: task.progress ?? 0 });
      return false;
    }

    // ── rigging (humanoids only; best effort) ──
    case "stored": {
      if (row.rig_mode !== "humanoid") return update(ctx.env, row, { status: "ready", rig_status: "none", progress: 100 }, "stored");
      const height = spec.size.axis === "height" ? spec.size.meters : 1.7;
      const outcome = await create(ctx, row, "stored", "rig_creating", "rigging", "rig_task_id", `the skeleton for "${row.name}"`, () =>
        ctx.meshy.createRig(row.refine_task_id!, height),
      );
      if (typeof outcome === "object") {
        const status = outcome.rejected.status;
        if (status === 401 || status === 402) throw Meshy.toPipelineError(outcome.rejected, `the skeleton for "${row.name}"`);
        // 400 / 404 / 422: Meshy cannot rig this model (not a clear biped, too many faces, …).
        return update(ctx.env, row, {
          status: "ready",
          rig_status: "unsupported",
          progress: 100,
          rig_note: `Meshy could not rig this model (${outcome.rejected.message.slice(0, 160)}). It is animated as a rigid body.`,
        });
      }
      return outcome === "created";
    }
    case "rig_creating":
      return recover(ctx, row, "rig", "stored", "rigging", "rig_task_id", () => true);
    case "rigging": {
      const task = await poll(ctx, "rig", row.rig_task_id!);
      if (!task) return update(ctx.env, row, { status: "stored", rig_task_id: null }, "rigging");
      if (task.status === "SUCCEEDED") {
        const result = task.result ?? {};
        if (!result.rigged_character_glb_url) {
          return update(ctx.env, row, { status: "ready", rig_status: "failed", progress: 100, rig_note: "Meshy finished rigging without a rigged file. It is animated as a rigid body." }, "rigging");
        }
        const rigged = await storeGlb(ctx, row, result.rigged_character_glb_url, "rigged.glb");
        const clips: ClipMap = {};
        const basics: [string, string | undefined][] = [
          ["walk", result.basic_animations?.walking_glb_url],
          ["run", result.basic_animations?.running_glb_url],
        ];
        for (const [name, url] of basics) {
          if (!url) continue;
          await storeGlb(ctx, row, url, `${name}.glb`);
          clips[name] = { file: `${name}.glb` };
        }
        await charge(ctx, row, task, "rig");
        return update(ctx.env, row, { status: "rigged", rig_status: "rigged", rigged_key: rigged.key, clips: JSON.stringify(clips), progress: 0 }, "rigging");
      }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        return update(
          ctx.env,
          row,
          { status: "ready", rig_status: "failed", progress: 100, rig_note: `Meshy could not rig this model (${failureMessage(task)}). It is animated as a rigid body.` },
          "rigging",
        );
      }
      if ((task.progress ?? 0) !== row.progress) await update(ctx.env, row, { progress: task.progress ?? 0 });
      return false;
    }

    // ── library clips ──
    case "rigged": {
      const wanted = spec.actions.filter((a) => !BUILTIN_CLIPS.includes(a.name as (typeof BUILTIN_CLIPS)[number]));
      if (wanted.length === 0) return update(ctx.env, row, { status: "animated" }, "rigged");
      const outcome = await create(ctx, row, "rigged", "anim_creating", "animating", "anim_task_id", `clips for "${row.name}"`, () =>
        ctx.meshy.createAnimation(row.rig_task_id!, { actionIds: wanted.map((a) => a.actionId) }),
      );
      if (typeof outcome === "object") {
        if (outcome.rejected.status === 401 || outcome.rejected.status === 402) throw Meshy.toPipelineError(outcome.rejected, `clips for "${row.name}"`);
        return update(ctx.env, row, { status: "animated", rig_note: await note(ctx, row, `Extra clips could not be created (${outcome.rejected.message.slice(0, 120)}).`) });
      }
      return outcome === "created";
    }
    case "anim_creating":
      return recover(ctx, row, "animation", "rigged", "animating", "anim_task_id", () => true);
    case "animating": {
      const task = await poll(ctx, "animation", row.anim_task_id!);
      if (!task) return update(ctx.env, row, { status: "rigged", anim_task_id: null }, "animating");
      if (task.status === "SUCCEEDED") {
        const clips = parseJson<ClipMap>(row.clips, {});
        const url = task.result?.animation_glb_url;
        if (url) {
          const stored = await storeGlb(ctx, row, url, "actions.glb");
          const wanted = spec.actions.filter((a) => !BUILTIN_CLIPS.includes(a.name as (typeof BUILTIN_CLIPS)[number]));
          for (const action of wanted) {
            // One merged file with one clip per action. With a single action the file holds exactly one clip.
            clips[action.name] = wanted.length === 1 || stored.info.animations.length <= 1 ? { file: "actions.glb" } : { file: "actions.glb", animation: action.name };
          }
        }
        await charge(ctx, row, task, "clips");
        return update(ctx.env, row, { status: "animated", clips: JSON.stringify(clips), progress: 0 }, "animating");
      }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        return update(ctx.env, row, { status: "animated", rig_note: await note(ctx, row, `Extra clips failed (${failureMessage(task)}).`) }, "animating");
      }
      if ((task.progress ?? 0) !== row.progress) await update(ctx.env, row, { progress: task.progress ?? 0 });
      return false;
    }

    // ── custom motion (Meshy Text to Motion, retargeted onto the rig) ──
    case "animated": {
      const motion = spec.motions[0];
      if (!motion) return update(ctx.env, row, { status: "ready", progress: 100 }, "animated");
      const outcome = await create(ctx, row, "animated", "motion_creating", "motion", "motion_task_id", `a custom motion for "${row.name}"`, () =>
        ctx.meshy.createMotion(motion.prompt, motion.duration),
      );
      if (typeof outcome === "object") {
        if (outcome.rejected.status === 401 || outcome.rejected.status === 402) throw Meshy.toPipelineError(outcome.rejected, "a custom motion");
        return update(ctx.env, row, { status: "ready", progress: 100, rig_note: await note(ctx, row, `The custom motion could not be created (${outcome.rejected.message.slice(0, 120)}).`) });
      }
      return outcome === "created";
    }
    case "motion_creating":
      return recover(ctx, row, "motion", "animated", "motion", "motion_task_id", () => true);
    case "motion": {
      const task = await poll(ctx, "motion", row.motion_task_id!);
      if (!task) return update(ctx.env, row, { status: "animated", motion_task_id: null }, "motion");
      if (task.status === "SUCCEEDED") {
        await charge(ctx, row, task, "custom motion");
        return update(ctx.env, row, { status: "motioned", progress: 0 }, "motion");
      }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        return update(ctx.env, row, { status: "ready", progress: 100, rig_note: await note(ctx, row, `The custom motion failed (${failureMessage(task)}).`) }, "motion");
      }
      return false;
    }
    case "motioned": {
      const outcome = await create(ctx, row, "motioned", "manim_creating", "manimating", "motion_anim_task_id", `a custom motion for "${row.name}"`, () =>
        ctx.meshy.createAnimation(row.rig_task_id!, { motionTaskId: row.motion_task_id! }),
      );
      if (typeof outcome === "object") {
        if (outcome.rejected.status === 401 || outcome.rejected.status === 402) throw Meshy.toPipelineError(outcome.rejected, "a custom motion");
        return update(ctx.env, row, { status: "ready", progress: 100, rig_note: await note(ctx, row, `The custom motion could not be applied (${outcome.rejected.message.slice(0, 120)}).`) });
      }
      return outcome === "created";
    }
    case "manim_creating":
      return recover(ctx, row, "animation", "motioned", "manimating", "motion_anim_task_id", () => true);
    case "manimating": {
      const task = await poll(ctx, "animation", row.motion_anim_task_id!);
      if (!task) return update(ctx.env, row, { status: "motioned", motion_anim_task_id: null }, "manimating");
      if (task.status === "SUCCEEDED") {
        const clips = parseJson<ClipMap>(row.clips, {});
        const url = task.result?.animation_glb_url;
        const motion = spec.motions[0];
        if (url && motion) {
          await storeGlb(ctx, row, url, "motion.glb");
          clips[motion.name] = { file: "motion.glb" };
        }
        await charge(ctx, row, task, "custom motion clip");
        return update(ctx.env, row, { status: "ready", clips: JSON.stringify(clips), progress: 100 }, "manimating");
      }
      if (task.status === "FAILED" || task.status === "CANCELED") {
        return update(ctx.env, row, { status: "ready", progress: 100, rig_note: await note(ctx, row, `The custom motion failed (${failureMessage(task)}).`) }, "manimating");
      }
      return false;
    }

    case "failed":
      throw new PipelineError("meshy_failed", `Meshy could not generate "${row.name}": ${row.error ?? "unknown error"}`, false);
    default:
      return false; // ready
  }
}

export interface AssetTick {
  phase: "models" | "textures" | "rigging" | "done";
  /** 0..1 from Meshy's own task progress, or null when no task reports one. */
  progress: number | null;
  detail: string;
  rows: AssetRow[];
}

export async function loadAssets(env: Env, ids: string[]): Promise<AssetRow[]> {
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(`SELECT * FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<AssetRow>();
  return results;
}

/** Advance every asset of a job and report which pipeline stage the job is truly in. */
export async function tickAssets(ctx: AssetContext, assetIds: string[]): Promise<AssetTick> {
  const rows = await loadAssets(ctx.env, assetIds);
  if (rows.length !== new Set(assetIds).size) throw new PipelineError("internal", "A model record for this job is missing.", false);
  let firstError: PipelineError | null = null;
  for (const row of rows) {
    try {
      for (let i = 0; i < 4 && ctx.budget.left > 2; i++) {
        if (!(await stepAsset(ctx, row))) break;
      }
    } catch (error) {
      const failure = error instanceof PipelineError ? error : new PipelineError("internal", String(error), true);
      // A permanent failure of one model fails the job; transient ones are retried by the caller.
      if (!firstError || (!failure.retryable && firstError.retryable)) firstError = failure;
    }
  }
  if (firstError) throw firstError;

  const inPhase = (states: string[]) => rows.filter((r) => states.includes(r.status));
  const models = inPhase(MODEL_STATES);
  const textures = inPhase(TEXTURE_STATES);
  const rigging = inPhase(RIG_STATES);
  const mean = (list: AssetRow[], done: number) => (rows.length ? (done + list.reduce((s, r) => s + r.progress / 100, 0)) / rows.length : null);

  if (models.length) {
    const done = rows.length - models.length;
    return { phase: "models", progress: mean(models, done), detail: `${done} of ${rows.length} models built`, rows };
  }
  if (textures.length) {
    const done = rows.length - textures.length;
    return { phase: "textures", progress: mean(textures, done), detail: `${done} of ${rows.length} models textured`, rows };
  }
  if (rigging.length) {
    const humanoids = rows.filter((r) => r.rig_mode === "humanoid");
    const done = humanoids.length - rigging.length;
    return { phase: "rigging", progress: null, detail: `${Math.max(0, done)} of ${humanoids.length} characters rigged`, rows };
  }
  return { phase: "done", progress: 1, detail: `${rows.length} models ready`, rows };
}

/** Best-effort: cancel Meshy tasks that have not started yet (Meshy refunds those). Running tasks cannot be canceled. */
export async function cancelPendingTasks(env: Env, assetIds: string[]): Promise<void> {
  const meshy = new Meshy(env);
  for (const row of await loadAssets(env, assetIds)) {
    const shared = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_assets WHERE asset_id = ?").bind(row.id).first<{ n: number }>();
    if ((shared?.n ?? 0) > 1) continue; // another project is waiting on this model
    const inflight: [string, TaskKind, string | null, string][] = [
      ["preview", "text", row.preview_task_id, "pending"],
      ["refine", "text", row.refine_task_id, "previewed"],
    ];
    for (const [status, kind, taskId, back] of inflight) {
      if (row.status !== status || !taskId) continue;
      if (await meshy.cancelIfPending(kind, taskId)) {
        await update(env, row, { status: back, [status === "preview" ? "preview_task_id" : "refine_task_id"]: null } as Partial<AssetRow>, status);
      }
    }
  }
}
