import type { PlanId, Resolution, SceneSpec, StageId } from "@kivo/shared";

/**
 * Typed client for the Kivo API. Every request carries the user's Clerk session
 * token; the server decides what the user may do. Nothing here is trusted by it.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let tokenGetter: (() => Promise<string | null>) | null = null;
let waiting: (() => void)[] = [];

/** Called by the signed-in shell with Clerk's getToken. Requests made before that wait for it. */
export function setTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn;
  if (fn) {
    for (const resume of waiting) resume();
    waiting = [];
  }
}

async function sessionToken(): Promise<string | null> {
  if (!tokenGetter) {
    // A component asked for data before the session was wired up (possible on a hard reload). Wait briefly rather than send an unauthenticated request.
    await Promise.race([new Promise<void>((resolve) => waiting.push(resolve)), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  }
  return tokenGetter ? tokenGetter() : null;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; public?: boolean } = {}): Promise<T> {
  const token = init.public ? null : await sessionToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "network", "Can't reach Kivo. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } & Record<string, unknown> } | null;
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "internal", err?.message ?? "Something went wrong. Try again.", err ?? {});
  }
  return data as T;
}

/** Upload a file as the request body (used for reference images). */
export async function apiUpload<T>(path: string, blob: Blob, filename: string): Promise<T> {
  const token = await sessionToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": blob.type || "application/octet-stream", "x-kivo-filename": encodeURIComponent(filename.slice(0, 80)) },
      body: blob,
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach Kivo. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } & Record<string, unknown> } | null;
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "internal", err?.message ?? "The upload failed. Try again.", err ?? {});
  }
  return data as T;
}

// ───────── shapes returned by the API ─────────

export interface Plan {
  id: PlanId;
  name: string;
  priceCents: number;
  videosPerMonth: number;
  maxDurationSec: number;
  maxResolution: Resolution;
  maxFps: number;
  concurrentJobs: number;
  watermark: boolean;
  renderPriorityLabel: string;
  meshyModel: string;
  maxAssetsPerScene: number;
  simpleMode: boolean;
  advancedMode: boolean;
}

export interface Usage {
  period: string;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

export interface Job {
  id: string;
  projectId: string;
  projectTitle?: string;
  kind: "generate" | "render" | "director";
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  stage: StageId;
  stages: StageId[];
  progress: number | null;
  detail: string | null;
  result: "video" | "scene" | null;
  willRender: boolean;
  warnings: string[];
  error: { code: string; message: string } | null;
  cancelRequested: boolean;
  videoId: string | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
}

export interface Me {
  user: { id: string; preferredMode: "simple" | "advanced"; onboarded: boolean; createdAt: number };
  plan: Plan;
  usage: Usage;
  activeJobs: Job[];
  counts: { projects: number; videos: number };
}

export interface Project {
  id: string;
  title: string;
  prompt: string;
  mode: "simple" | "advanced";
  style: string;
  duration: number;
  fps: number;
  aspect: "16:9" | "9:16" | "1:1" | "4:3" | "21:9";
  resolution: Resolution;
  status: "draft" | "generating" | "scene_ready" | "rendering" | "ready" | "failed";
  hasScene: boolean;
  sceneId: string | null;
  latestVideoId: string | null;
  prepaidRenders: number;
  thumbnailUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A reference image attached to a project. Each usable one becomes a 3D model in the scene. */
export interface ProjectImage {
  id: string;
  name: string;
  url: string | null;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
}

export interface Video {
  id: string;
  projectId: string;
  projectTitle?: string;
  url: string | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  bytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  watermark: boolean;
  createdAt: number;
}

export interface Asset {
  id: string;
  name: string;
  kind: string;
  prompt: string;
  /** Built by Meshy from an image the user uploaded, rather than from a text prompt. */
  fromImage?: boolean;
  meshyModel: string;
  status: "ready" | "failed" | "generating";
  statusLabel: string;
  progress: number;
  rigRequested: boolean;
  rigStatus: "none" | "pending" | "rigged" | "unsupported" | "failed";
  rigNote: string | null;
  clipNames: string[];
  note: string | null;
  bytes: number;
  thumbnailUrl: string | null;
  createdAt: number;
  lastUsedAt: number;
  projectCount?: number;
  modelUrl?: string | null;
  riggedUrl?: string | null;
  clips?: Record<string, { url: string | null; animation?: string }>;
}

export interface SceneResponse {
  sceneId: string | null;
  version: number;
  spec: SceneSpec | null;
  assets: Record<string, Asset>;
}

export interface DirectorResult {
  changed: boolean;
  pending?: boolean;
  summary: string;
  cannotDo?: string;
  applied: string[];
  skipped: string[];
  warnings?: string[];
  newModels?: string[];
  job?: Job;
  sceneId?: string;
  version?: number;
  spec?: SceneSpec;
}

export interface RenderEntry {
  id: string;
  jobId: string;
  projectId: string;
  projectTitle: string;
  status: string;
  jobStage: StageId | null;
  jobStatus: string | null;
  framesTotal: number;
  framesDone: number;
  engine: string | null;
  width: number;
  height: number;
  fps: number;
  duration: number;
  watermark: boolean;
  error: { code: string; message: string } | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AppConfig {
  clerkPublishableKey: string;
  plans: Plan[];
  stages: { id: StageId; label: string; detail: string }[];
  styles: { id: string; label: string; promptHint: string }[];
  storageReady: boolean;
}

export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}
