import { normalizeScene, type SceneSpec, type StageId } from "@kivo/shared";
import type { Env } from "../env";
import { pruneRateLimits } from "../ratelimit";
import { recordCost } from "../usage";
import { HttpError, log, newId, now, parseJson } from "../util";
import type { ClipMap } from "./assets";
import { addWarnings, completeJob, failJob, loadJob, loadScene, patchJob } from "./jobs";
import { enqueue } from "./run";

/**
 * Render-service protocol.
 *
 * Blender does not run on Workers. External render workers PULL jobs from here:
 * they claim the highest-priority queued job, report real frame counts while
 * rendering, upload the MP4, and report completion. A claim is a lease that
 * progress reports keep alive; if a worker dies the lease expires and the job
 * is requeued (or failed and refunded once it has used its attempts).
 */

export interface RenderJobRow {
  id: string;
  job_id: string;
  project_id: string;
  user_id: string;
  scene_id: string;
  status: string;
  priority: number;
  pixels: number;
  settings: string;
  worker_id: string | null;
  lease_expires_at: number | null;
  attempts: number;
  frames_total: number;
  frames_done: number;
  engine: string | null;
  notes: string;
  video_key: string | null;
  thumbnail_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  claimed_at: number | null;
  deadline_at: number | null;
  finished_at: number | null;
}

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  duration: number;
  watermark: boolean;
  quality: string;
  maxRenderSeconds: number;
  resolution: string;
}

const LEASE_MS = 120_000;
const MAX_RENDER_ATTEMPTS = 2;
const ACTIVE = ["claimed", "rendering", "encoding", "uploading"];
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

export function videoKey(userId: string, renderId: string): string {
  return `users/${userId}/videos/${renderId}.mp4`;
}
export function thumbnailKey(userId: string, renderId: string): string {
  return `users/${userId}/videos/${renderId}.jpg`;
}

export async function loadRenderJob(env: Env, id: string): Promise<RenderJobRow | null> {
  return env.DB.prepare("SELECT * FROM render_jobs WHERE id = ?").bind(id).first<RenderJobRow>();
}

async function setJobStage(env: Env, jobId: string, stage: StageId, progress: number | null, detail: string | null): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET stage = ?, progress = ?, detail = ?, updated_at = ? WHERE id = ? AND status = 'running'").bind(stage, progress, detail, now(), jobId).run();
}

/** Hand the best queued job to a worker: highest plan priority first, then oldest. */
export async function claimRenderJob(env: Env, workerId: string, maxPixels: number): Promise<Record<string, unknown> | null> {
  const { results } = await env.DB.prepare("SELECT id FROM render_jobs WHERE status = 'queued' AND pixels <= ? ORDER BY priority DESC, created_at ASC LIMIT 5")
    .bind(maxPixels)
    .all<{ id: string }>();
  for (const candidate of results) {
    const t = now();
    const row = await loadRenderJob(env, candidate.id);
    if (!row) continue;
    const settings = parseJson<RenderSettings>(row.settings, {} as RenderSettings);
    const claimed = await env.DB.prepare(
      "UPDATE render_jobs SET status = 'claimed', worker_id = ?, claimed_at = ?, lease_expires_at = ?, deadline_at = ?, attempts = attempts + 1, frames_done = 0 WHERE id = ? AND status = 'queued'",
    )
      .bind(workerId, t, t + LEASE_MS, t + settings.maxRenderSeconds * 1000 + 10 * 60_000, row.id)
      .run();
    if (claimed.meta.changes === 0) continue; // another worker won the race

    try {
      const payload = await buildPayload(env, row, settings);
      await setJobStage(env, row.job_id, "preparing_rendering", null, "A render worker is loading the scene");
      log("render_claimed", { render: row.id, worker: workerId, priority: row.priority });
      return payload;
    } catch (error) {
      log("render_payload_failed", { render: row.id, error: String(error) });
      await env.DB.prepare("UPDATE render_jobs SET status = 'failed', error_code = 'invalid_scene', error_message = ?, finished_at = ? WHERE id = ?")
        .bind(String(error).slice(0, 300), now(), row.id)
        .run();
      const job = await loadJob(env, row.job_id);
      if (job) await failJob(env, job, "invalid_scene", error instanceof Error ? error.message : undefined);
    }
  }
  return null;
}

async function buildPayload(env: Env, row: RenderJobRow, settings: RenderSettings): Promise<Record<string, unknown>> {
  const scene = await loadScene(env, row.scene_id);
  if (!scene) throw new Error("The scene for this render no longer exists.");
  // The scene may be longer than the plan allows; the export is trimmed to the plan's limits here.
  const raw: SceneSpec = { ...scene.spec, output: { ...scene.spec.output, duration: settings.duration, fps: settings.fps } };
  const { spec } = normalizeScene(raw, { maxDurationSec: settings.duration, maxFps: settings.fps });

  const { results: links } = await env.DB.prepare(
    "SELECT pa.alias, a.id, a.status, a.model_key, a.rigged_key, a.rig_status, a.clips FROM project_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.project_id = ?",
  )
    .bind(row.project_id)
    .all<{ alias: string; id: string; status: string; model_key: string | null; rigged_key: string | null; rig_status: string; clips: string }>();
  const byAlias = new Map(links.map((l) => [l.alias, l]));
  const assets: Record<string, unknown> = {};
  const base = `/api/render/jobs/${row.id}/files`;
  for (const alias of new Set(spec.objects.filter((o) => o.visible).map((o) => o.assetId))) {
    const link = byAlias.get(alias);
    if (!link || link.status !== "ready" || !link.model_key) throw new Error(`The model "${alias}" is not ready.`);
    const files: Record<string, { url: string }> = { "model.glb": { url: `${base}/${link.id}/model.glb` } };
    let rigged: string | null = null;
    let clips: ClipMap = {};
    if (link.rig_status === "rigged" && link.rigged_key) {
      rigged = "rigged.glb";
      files["rigged.glb"] = { url: `${base}/${link.id}/rigged.glb` };
      clips = parseJson<ClipMap>(link.clips, {});
      for (const clip of Object.values(clips)) files[clip.file] = { url: `${base}/${link.id}/${clip.file}` };
    }
    assets[alias] = { model: "model.glb", rigged, clips, files };
  }
  return {
    renderJobId: row.id,
    leaseSeconds: LEASE_MS / 1000,
    settings: {
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      duration: settings.duration,
      watermark: settings.watermark,
      quality: settings.quality,
      maxRenderSeconds: settings.maxRenderSeconds,
    },
    scene: spec,
    assets,
  };
}

async function activeJobFor(env: Env, id: string, workerId: string): Promise<RenderJobRow> {
  const row = await loadRenderJob(env, id);
  if (!row) throw new HttpError(404, "internal", "Unknown render job.");
  if (!ACTIVE.includes(row.status) || row.worker_id !== workerId) throw new HttpError(409, "canceled", "This render job is no longer assigned to this worker.");
  return row;
}

/** A worker's progress report. Extends its lease and returns whether the job was canceled. */
export async function reportProgress(
  env: Env,
  id: string,
  body: { workerId: string; phase: string; framesDone?: number; framesTotal?: number; engine?: string },
): Promise<{ cancel: boolean }> {
  const row = await loadRenderJob(env, id);
  if (!row) throw new HttpError(404, "internal", "Unknown render job.");
  if (!ACTIVE.includes(row.status) || row.worker_id !== body.workerId) return { cancel: true };
  const job = await loadJob(env, row.job_id);
  if (!job || job.status !== "running" || job.cancel_requested) return { cancel: true };

  const status = body.phase === "rendering" ? "rendering" : body.phase === "encoding" ? "encoding" : body.phase === "uploading" ? "uploading" : "claimed";
  const done = Math.max(0, Math.min(row.frames_total, Math.floor(body.framesDone ?? row.frames_done)));
  await env.DB.prepare("UPDATE render_jobs SET status = ?, frames_done = ?, engine = COALESCE(?, engine), lease_expires_at = ? WHERE id = ?")
    .bind(status, done, body.engine?.slice(0, 40) ?? null, now() + LEASE_MS, id)
    .run();

  if (status === "rendering") {
    // The only percentage Kivo shows here is frames actually rendered.
    await setJobStage(env, job.id, "rendering_video", row.frames_total ? done / row.frames_total : null, `Frame ${done} of ${row.frames_total}`);
  } else if (status === "encoding") {
    await setJobStage(env, job.id, "encoding_mp4", null, "Encoding H.264");
  } else if (status === "uploading") {
    await setJobStage(env, job.id, "saving_video", null, "Uploading to storage");
  }
  return { cancel: false };
}

export async function storeUpload(env: Env, id: string, workerId: string, kind: "video" | "thumbnail", request: Request): Promise<void> {
  const row = await activeJobFor(env, id, workerId);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!request.body || !Number.isFinite(length) || length <= 0) throw new HttpError(411, "internal", "Uploads must declare their length.");
  if (length > (kind === "video" ? MAX_VIDEO_BYTES : 5 * 1024 * 1024)) throw new HttpError(413, "storage_error", "The uploaded file is too large.");
  const key = kind === "video" ? videoKey(row.user_id, row.id) : thumbnailKey(row.user_id, row.id);
  try {
    await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: kind === "video" ? "video/mp4" : "image/jpeg" } });
  } catch (error) {
    log("r2_upload_failed", { render: id, kind, error: String(error) });
    throw new HttpError(507, "storage_error");
  }
  await env.DB.prepare(`UPDATE render_jobs SET ${kind === "video" ? "video_key" : "thumbnail_key"} = ?, lease_expires_at = ? WHERE id = ?`).bind(key, now() + LEASE_MS, id).run();
}

function indexOfBytes(haystack: Uint8Array, needle: string): number {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= haystack.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/** Is the stored object a streamable H.264 MP4? (ISO BMFF `ftyp`, front-loaded `moov`, `avc1` sample entry.) */
export async function looksLikeH264Mp4(env: Env, key: string, expectedBytes: number): Promise<string | null> {
  const head = await env.BUCKET.head(key);
  if (!head) return "the video file is not in storage";
  if (head.size < 1024) return "the video file is too small to be a video";
  if (expectedBytes && head.size !== expectedBytes) return `the stored file is ${head.size} bytes but the worker reported ${expectedBytes}`;
  const object = await env.BUCKET.get(key, { range: { offset: 0, length: Math.min(head.size, 256 * 1024) } });
  if (!object) return "the video file could not be read back";
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (indexOfBytes(bytes.subarray(0, 16), "ftyp") !== 4) return "the file is not an MP4 container";
  if (indexOfBytes(bytes, "moov") < 0) return "the MP4 index is not at the start of the file";
  if (indexOfBytes(bytes, "avc1") < 0) return "the video stream is not H.264";
  return null;
}

/**
 * A worker says the video is done. Nothing is trusted: the object must be in
 * R2, be the reported size, be an H.264 MP4, and match the job's frame count
 * and dimensions. Only then does a `videos` row exist and the job complete.
 */
export async function completeRender(
  env: Env,
  id: string,
  body: { workerId: string; width: number; height: number; fps: number; frames: number; durationSeconds: number; bytes: number; codec: string; engine?: string; notes?: string[] },
): Promise<{ videoId: string }> {
  const row = await activeJobFor(env, id, body.workerId);
  const settings = parseJson<RenderSettings>(row.settings, {} as RenderSettings);
  const job = await loadJob(env, row.job_id);
  if (!job) throw new HttpError(404, "internal", "The job for this render no longer exists.");

  let problem: string | null = null;
  if (!row.video_key) problem = "no video was uploaded";
  else if (body.codec !== "h264") problem = `the codec is ${body.codec}`;
  else if (body.width !== settings.width || body.height !== settings.height) problem = `the video is ${body.width}x${body.height}, expected ${settings.width}x${settings.height}`;
  else if (body.frames !== row.frames_total) problem = `the video has ${body.frames} frames, expected ${row.frames_total}`;
  else problem = await looksLikeH264Mp4(env, row.video_key, body.bytes);

  if (problem) {
    log("render_verification_failed", { render: id, problem });
    if (row.video_key) await env.BUCKET.delete(row.video_key).catch(() => undefined);
    await env.DB.prepare("UPDATE render_jobs SET status = 'failed', error_code = 'video_invalid', error_message = ?, finished_at = ? WHERE id = ?").bind(problem, now(), id).run();
    await failJob(env, job, "video_invalid", `The rendered file was rejected: ${problem}. Your quota was not charged — try again.`);
    throw new HttpError(422, "video_invalid", problem);
  }

  const videoId = newId("vid");
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO videos (id, project_id, user_id, render_job_id, scene_id, r2_key, thumbnail_key, bytes, duration, width, height, fps, codec, watermark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(videoId, row.project_id, row.user_id, row.id, row.scene_id, row.video_key, row.thumbnail_key, body.bytes, body.durationSeconds, body.width, body.height, body.fps, "h264", settings.watermark ? 1 : 0, t),
    env.DB.prepare("UPDATE render_jobs SET status = 'succeeded', frames_done = frames_total, engine = COALESCE(?, engine), notes = ?, finished_at = ? WHERE id = ?").bind(
      body.engine?.slice(0, 40) ?? null,
      JSON.stringify((body.notes ?? []).slice(0, 20)),
      t,
      id,
    ),
    env.DB.prepare("UPDATE projects SET status = 'ready', latest_video_id = ?, thumbnail_key = COALESCE(?, thumbnail_key), updated_at = ? WHERE id = ?").bind(videoId, row.thumbnail_key, t, row.project_id),
  ]);
  await addWarnings(env, job, (body.notes ?? []).map(String));
  await completeJob(env, job, "video", { video_id: videoId });
  await recordCost(env, row.user_id, job.id, "render", Math.round((t - (row.claimed_at ?? t)) / 1000), `${settings.width}x${settings.height} ${row.frames_total}f ${body.engine ?? ""}`);
  log("render_completed", { render: id, video: videoId, bytes: body.bytes });
  return { videoId };
}

async function requeueOrFail(env: Env, row: RenderJobRow, code: string, message: string, retryable: boolean): Promise<void> {
  const job = await loadJob(env, row.job_id);
  if (retryable && row.attempts < MAX_RENDER_ATTEMPTS && job && job.status === "running" && !job.cancel_requested) {
    await env.DB.prepare("UPDATE render_jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, frames_done = 0, error_code = ?, error_message = ? WHERE id = ?")
      .bind(code, message.slice(0, 500), row.id)
      .run();
    await setJobStage(env, job.id, "preparing_rendering", null, "Render interrupted — queued again");
    log("render_requeued", { render: row.id, code, attempts: row.attempts });
    return;
  }
  await env.DB.prepare("UPDATE render_jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'canceled')")
    .bind(code, message.slice(0, 500), now(), row.id)
    .run();
  if (job) await failJob(env, job, code, undefined);
}

export async function failRender(env: Env, id: string, body: { workerId: string; code: string; message: string; retryable: boolean }): Promise<void> {
  const row = await loadRenderJob(env, id);
  if (!row || !ACTIVE.includes(row.status) || row.worker_id !== body.workerId) return;
  const code = ["render_failed", "render_timeout", "invalid_scene", "storage_error", "interrupted"].includes(body.code) ? body.code : "render_failed";
  log("render_failed", { render: id, code, message: body.message.slice(0, 300) });
  await requeueOrFail(env, row, code, body.message, body.retryable);
}

/**
 * Periodic recovery (cron, every minute):
 *  - renders whose worker stopped reporting → requeue, or fail and refund;
 *  - renders past their plan's time limit → fail and refund;
 *  - renders nobody claimed → fail and refund with a clear message;
 *  - pipeline jobs whose queue delivery was lost → re-enqueue; abandoned ones → fail and refund.
 */
export async function sweep(env: Env): Promise<void> {
  const t = now();
  const expired = await env.DB.prepare(`SELECT * FROM render_jobs WHERE status IN ('claimed', 'rendering', 'encoding', 'uploading') AND lease_expires_at < ? LIMIT 20`).bind(t).all<RenderJobRow>();
  for (const row of expired.results) await requeueOrFail(env, row, "interrupted", "The render worker stopped responding.", true);

  const late = await env.DB.prepare(`SELECT * FROM render_jobs WHERE status IN ('claimed', 'rendering', 'encoding', 'uploading') AND deadline_at < ? LIMIT 20`).bind(t).all<RenderJobRow>();
  for (const row of late.results) await requeueOrFail(env, row, "render_timeout", "Rendering exceeded the plan's time limit.", false);

  const queueTimeout = Math.max(1, Number(env.RENDER_QUEUE_TIMEOUT_MINUTES ?? "30")) * 60_000;
  const unclaimed = await env.DB.prepare("SELECT * FROM render_jobs WHERE status = 'queued' AND created_at < ? LIMIT 20").bind(t - queueTimeout).all<RenderJobRow>();
  for (const row of unclaimed.results) await requeueOrFail(env, row, "render_unavailable", "No render worker picked up the job.", false);

  // Orchestrated stages (everything before rendering) are advanced by queue messages. If one was lost, send another.
  const stalled = await env.DB.prepare(
    "SELECT id, created_at FROM jobs WHERE status IN ('queued', 'running') AND render_job_id IS NULL AND updated_at < ? AND lock_until < ? LIMIT 25",
  )
    .bind(t - 3 * 60_000, t)
    .all<{ id: string; created_at: number }>();
  for (const stale of stalled.results) {
    if (t - stale.created_at > 3 * 3600_000) {
      const job = await loadJob(env, stale.id);
      if (job) await failJob(env, job, "interrupted");
    } else {
      await patchJob(env, { id: stale.id } as never, {});
      await enqueue(env, stale.id);
      log("job_reenqueued", { job: stale.id });
    }
  }

  // Canceled while waiting on a render: finish the cancellation.
  const canceled = await env.DB.prepare("SELECT id FROM jobs WHERE status = 'running' AND cancel_requested = 1 AND render_job_id IS NOT NULL LIMIT 25").all<{ id: string }>();
  for (const c of canceled.results) {
    const job = await loadJob(env, c.id);
    if (job) await (await import("./jobs")).cancelJob(env, job);
  }

  await pruneRateLimits(env);
  await env.DB.prepare("DELETE FROM kv_cache WHERE expires_at < ?").bind(t - 7 * 24 * 3600_000).run();
}
