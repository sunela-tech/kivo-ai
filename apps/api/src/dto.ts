import { STAGES, errorMessage, stageIndex, type PlanLimits } from "@kivo/shared";
import type { Env } from "./env";
import type { ProjectImageRow } from "./images";
import type { AssetRow, ClipMap } from "./pipeline/assets";
import { assetKey } from "./pipeline/assets";
import type { JobRow, ProjectRow } from "./pipeline/jobs";
import { signPath } from "./signing";
import { parseJson } from "./util";

/** Signed, expiring URL for one object in the private bucket. */
export async function mediaUrl(env: Env, key: string | null | undefined, download?: string): Promise<string | null> {
  if (!key) return null;
  const encoded = btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return signPath(env, `/api/media/o/${encoded}`, undefined, download ? { dl: download } : {});
}

export function planDto(plan: PlanLimits) {
  return {
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    videosPerMonth: plan.videosPerMonth,
    maxDurationSec: plan.maxDurationSec,
    maxResolution: plan.maxResolution,
    maxFps: plan.maxFps,
    concurrentJobs: plan.concurrentJobs,
    watermark: plan.watermark,
    renderPriorityLabel: plan.renderPriorityLabel,
    meshyModel: plan.meshyModel,
    maxAssetsPerScene: plan.maxAssetsPerScene,
    // Creative tools are never plan-gated. These are stated explicitly so the UI can say so.
    simpleMode: true,
    advancedMode: true,
    editor: true,
    animationEditor: true,
    cameraEditor: true,
    aiDirector: true,
  };
}

export function jobDto(job: JobRow) {
  const params = parseJson<{ render?: boolean; prompt?: string; instruction?: string }>(job.params, {});
  const willRender = job.kind === "render" || (job.kind === "generate" && params.render !== false);
  const stages = STAGES.filter((s) => {
    if (job.kind === "render") return stageIndex(s.id) >= stageIndex("preparing_rendering");
    if (job.kind === "director") return ["generating_models", "preparing_textures", "rigging_characters"].includes(s.id);
    return willRender || stageIndex(s.id) <= stageIndex("adjusting_cameras");
  }).map((s) => s.id);
  return {
    id: job.id,
    projectId: job.project_id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    stages,
    progress: job.status === "running" ? job.progress : null,
    detail: job.status === "running" ? job.detail : null,
    result: job.result,
    willRender,
    warnings: parseJson<string[]>(job.warnings, []),
    error: job.error_code ? { code: job.error_code, message: job.error_message ?? errorMessage(job.error_code) } : null,
    cancelRequested: !!job.cancel_requested,
    videoId: job.video_id,
    createdAt: job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    finishedAt: job.finished_at,
  };
}

export async function projectDto(env: Env, p: ProjectRow) {
  return {
    id: p.id,
    title: p.title,
    prompt: p.prompt,
    mode: p.mode,
    style: p.style,
    duration: p.duration,
    fps: p.fps,
    aspect: p.aspect,
    resolution: p.resolution,
    status: p.status,
    hasScene: !!p.scene_id,
    sceneId: p.scene_id,
    latestVideoId: p.latest_video_id,
    prepaidRenders: p.render_credits,
    thumbnailUrl: await mediaUrl(env, p.thumbnail_key),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export interface VideoRow {
  id: string;
  project_id: string;
  user_id: string;
  render_job_id: string;
  scene_id: string;
  r2_key: string;
  thumbnail_key: string | null;
  bytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  watermark: number;
  created_at: number;
}

export async function videoDto(env: Env, v: VideoRow, title = "kivo-video") {
  const safe = title.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").slice(0, 60) || "kivo-video";
  return {
    id: v.id,
    projectId: v.project_id,
    sceneId: v.scene_id,
    url: await mediaUrl(env, v.r2_key),
    downloadUrl: await mediaUrl(env, v.r2_key, `${safe}.mp4`),
    thumbnailUrl: await mediaUrl(env, v.thumbnail_key),
    bytes: v.bytes,
    duration: v.duration,
    width: v.width,
    height: v.height,
    fps: v.fps,
    codec: v.codec,
    watermark: !!v.watermark,
    createdAt: v.created_at,
  };
}

/** A reference image the user uploaded to a project. */
export async function imageDto(env: Env, row: ProjectImageRow) {
  return {
    id: row.id,
    name: row.name,
    url: await mediaUrl(env, row.storage_key),
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

const IN_FLIGHT_LABEL: Record<string, string> = {
  pending: "Queued",
  image_creating: "Building from your image",
  image: "Building from your image",
  preview_creating: "Building geometry",
  preview: "Building geometry",
  previewed: "Texturing",
  refine_creating: "Texturing",
  refine: "Texturing",
  stored: "Rigging",
  rig_creating: "Rigging",
  rigging: "Rigging",
  rigged: "Creating clips",
  anim_creating: "Creating clips",
  animating: "Creating clips",
  animated: "Creating clips",
  motion_creating: "Creating custom motion",
  motion: "Creating custom motion",
  motioned: "Creating custom motion",
  manim_creating: "Creating custom motion",
  manimating: "Creating custom motion",
  ready: "Ready",
  failed: "Failed",
};

export async function assetDto(env: Env, row: AssetRow, withFiles = false) {
  const clips = parseJson<ClipMap>(row.clips, {});
  const rigged = row.rig_status === "rigged" && !!row.rigged_key;
  const files: Record<string, unknown> = {};
  if (withFiles && row.status === "ready") {
    files.modelUrl = await mediaUrl(env, row.model_key);
    files.riggedUrl = rigged ? await mediaUrl(env, row.rigged_key) : null;
    const clipUrls: Record<string, { url: string | null; animation?: string }> = {};
    if (rigged) {
      for (const [name, clip] of Object.entries(clips)) {
        clipUrls[name] = { url: await mediaUrl(env, assetKey(row.user_id, row.id, clip.file)), animation: clip.animation };
      }
    }
    files.clips = clipUrls;
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    prompt: row.prompt,
    /** true when Meshy built this model from an image the user uploaded, not from a text prompt. */
    fromImage: !!row.source_image_key,
    meshyModel: row.ai_model,
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "generating",
    statusLabel: IN_FLIGHT_LABEL[row.status] ?? row.status,
    progress: row.status === "ready" ? 100 : row.progress,
    rigRequested: row.rig_mode === "humanoid",
    rigStatus: row.rig_status,
    rigNote: row.rig_note,
    clipNames: rigged ? Object.keys(clips) : [],
    note: row.status === "failed" ? row.error : row.error,
    bytes: row.bytes,
    thumbnailUrl: await mediaUrl(env, row.thumbnail_key),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...files,
  };
}
