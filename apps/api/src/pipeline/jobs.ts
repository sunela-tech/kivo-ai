import { errorMessage, type JobKind, type JobStatus, type PlanId, type SceneSpec, type StageId } from "@kivo/shared";
import type { Env } from "../env";
import { refundVideo } from "../usage";
import { log, newId, now, parseJson } from "../util";

export interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  stage: StageId;
  progress: number | null;
  detail: string | null;
  plan: PlanId;
  params: string;
  state: string;
  result: string | null;
  warnings: string;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  cancel_requested: number;
  lock_until: number;
  render_job_id: string | null;
  video_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  mode: "simple" | "advanced";
  style: string;
  duration: number;
  fps: number;
  aspect: string;
  resolution: string;
  status: string;
  scene_id: string | null;
  latest_video_id: string | null;
  thumbnail_key: string | null;
  render_credits: number;
  created_at: number;
  updated_at: number;
}

export async function loadJob(env: Env, id: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function loadProject(env: Env, id: string): Promise<ProjectRow | null> {
  return env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
}

export async function patchJob(env: Env, job: JobRow, fields: Partial<JobRow>): Promise<void> {
  const entries = Object.entries({ ...fields, updated_at: now() });
  await env.DB.prepare(`UPDATE jobs SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v as unknown), job.id)
    .run();
  Object.assign(job, fields);
}

export async function addWarnings(env: Env, job: JobRow, warnings: string[]): Promise<void> {
  if (warnings.length === 0) return;
  const all = [...new Set([...parseJson<string[]>(job.warnings, []), ...warnings.map((w) => w.slice(0, 300))])].slice(0, 30);
  await patchJob(env, job, { warnings: JSON.stringify(all) });
}

/** Where a project lands after a job ends without a new result. */
async function restingStatus(env: Env, projectId: string): Promise<string> {
  const p = await loadProject(env, projectId);
  if (!p) return "failed";
  if (p.latest_video_id) return "ready";
  if (p.scene_id) return "scene_ready";
  return "failed";
}


/** A render that used the project's prepaid render (from a scene-only generation) gives it back when it does not finish. */
async function restoreRenderCredit(env: Env, job: JobRow): Promise<void> {
  if (job.kind !== "render") return;
  if (!parseJson<{ usedRenderCredit?: boolean }>(job.params, {}).usedRenderCredit) return;
  await env.DB.prepare("UPDATE projects SET render_credits = render_credits + 1 WHERE id = ?").bind(job.project_id).run();
}

/**
 * Fail a job once. The status compare-and-swap guarantees a single transition,
 * and the refund itself is idempotent, so a failed job is never charged and
 * never refunded twice no matter how many times this runs.
 */
export async function failJob(env: Env, job: JobRow, code: string, message?: string): Promise<void> {
  const text = (message ?? errorMessage(code)).slice(0, 600);
  const res = await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, progress = NULL, finished_at = ?, updated_at = ?, lock_until = 0 WHERE id = ? AND status IN ('queued', 'running')",
  )
    .bind(code, text, now(), now(), job.id)
    .run();
  if (res.meta.changes === 0) return;
  job.status = "failed";
  const refunded = await refundVideo(env, job.id, code);
  await restoreRenderCredit(env, job);
  if (job.render_job_id) {
    await env.DB.prepare("UPDATE render_jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'canceled')")
      .bind(code, text, now(), job.render_job_id)
      .run();
  }
  await env.DB.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").bind(await restingStatus(env, job.project_id), now(), job.project_id).run();
  log("job_failed", { job: job.id, kind: job.kind, stage: job.stage, code, refunded });
}

export async function cancelJob(env: Env, job: JobRow): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE jobs SET status = 'canceled', error_code = 'canceled', error_message = ?, progress = NULL, finished_at = ?, updated_at = ?, lock_until = 0 WHERE id = ? AND status IN ('queued', 'running')",
  )
    .bind(errorMessage("canceled"), now(), now(), job.id)
    .run();
  if (res.meta.changes === 0) return;
  job.status = "canceled";
  await refundVideo(env, job.id, "canceled");
  await restoreRenderCredit(env, job);
  if (job.render_job_id) {
    await env.DB.prepare("UPDATE render_jobs SET status = 'canceled', finished_at = ? WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'canceled')").bind(now(), job.render_job_id).run();
  }
  await env.DB.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").bind(await restingStatus(env, job.project_id), now(), job.project_id).run();
  log("job_canceled", { job: job.id, stage: job.stage });
}

export async function completeJob(env: Env, job: JobRow, result: "video" | "scene", fields: Partial<JobRow> = {}): Promise<boolean> {
  const stage: StageId = result === "video" ? "completed" : job.stage;
  const res = await env.DB.prepare(
    "UPDATE jobs SET status = 'succeeded', result = ?, stage = ?, progress = 1, detail = NULL, video_id = ?, finished_at = ?, updated_at = ?, lock_until = 0 WHERE id = ? AND status IN ('queued', 'running')",
  )
    .bind(result, stage, fields.video_id ?? job.video_id ?? null, now(), now(), job.id)
    .run();
  if (res.meta.changes === 0) return false;
  Object.assign(job, { status: "succeeded", result, stage });
  log("job_succeeded", { job: job.id, kind: job.kind, result });
  return true;
}

export async function saveScene(env: Env, projectId: string, userId: string, spec: SceneSpec, source: "gemini" | "user" | "director", note: string | null): Promise<string> {
  const id = newId("scn");
  const next = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM scenes WHERE project_id = ?").bind(projectId).first<{ v: number }>();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO scenes (id, project_id, user_id, version, source, note, spec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      id,
      projectId,
      userId,
      next?.v ?? 1,
      source,
      note?.slice(0, 300) ?? null,
      JSON.stringify(spec),
      now(),
    ),
    env.DB.prepare("UPDATE projects SET scene_id = ?, updated_at = ? WHERE id = ?").bind(id, now(), projectId),
  ]);
  // Keep history bounded: the 40 most recent versions per project.
  await env.DB.prepare("DELETE FROM scenes WHERE project_id = ? AND version <= ? AND id != ?").bind(projectId, (next?.v ?? 1) - 40, id).run();
  return id;
}

export async function loadScene(env: Env, sceneId: string): Promise<{ id: string; project_id: string; version: number; spec: SceneSpec } | null> {
  const row = await env.DB.prepare("SELECT id, project_id, version, spec FROM scenes WHERE id = ?").bind(sceneId).first<{ id: string; project_id: string; version: number; spec: string }>();
  if (!row) return null;
  return { id: row.id, project_id: row.project_id, version: row.version, spec: JSON.parse(row.spec) as SceneSpec };
}
