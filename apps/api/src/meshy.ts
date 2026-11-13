import { MESHY_MODEL_SUCCESSOR, type LibraryAction, type MeshyModel } from "@kivo/shared";
import type { Env } from "./env";
import { PipelineError, fetchWithTimeout, log, now } from "./util";

/**
 * Meshy API client (docs.meshy.ai).
 *
 * Meshy is asynchronous: create returns a task id, the task is polled until it
 * is SUCCEEDED / FAILED / CANCELED. Credits are charged at creation and refunded
 * by Meshy if the task fails. Create requests are never blindly re-sent after a
 * timeout or 5xx (there is no idempotency key) — see pipeline/assets.ts for the
 * marker + list-recent recovery.
 */

const BASE = "https://api.meshy.ai/openapi";

export type MeshyStatus = "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";

export interface MeshyTask {
  id: string;
  type?: string;
  status: MeshyStatus;
  progress?: number;
  prompt?: string;
  created_at?: number;
  consumed_credits?: number;
  model_urls?: Record<string, string>;
  thumbnail_url?: string;
  texture_urls?: Record<string, string>[];
  task_error?: { type?: string; code?: string; message?: string } | null;
  result?: {
    rigged_character_glb_url?: string;
    basic_animations?: { walking_glb_url?: string; running_glb_url?: string } | null;
    animation_glb_url?: string;
    motion_url?: string;
  };
}

export class MeshyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** The request was definitely not accepted, so no task exists and nothing was charged. */
  get definitelyNotCreated(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export const TASK_PATHS = {
  text: "/v2/text-to-3d",
  rig: "/v1/rigging",
  animation: "/v1/animations",
  motion: "/v1/text-to-motion",
} as const;
export type TaskKind = keyof typeof TASK_PATHS;

export class Meshy {
  constructor(private readonly env: Env) {}

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 45_000): Promise<T> {
    if (!this.env.MESHY_API_KEY) {
      throw new PipelineError("meshy_unavailable", "The Meshy API key is not configured (MESHY_API_KEY secret is missing).", false);
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.env.MESHY_API_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs,
      });
    } catch (error) {
      throw new MeshyHttpError(0, `Meshy did not respond (${error instanceof Error ? error.name : "network error"})`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const message = (json as { message?: string } | null)?.message ?? text.slice(0, 200) ?? res.statusText;
      throw new MeshyHttpError(res.status, message);
    }
    return json as T;
  }

  /** Translate an HTTP failure into a pipeline failure with the right retry behaviour. */
  static toPipelineError(error: unknown, what: string): PipelineError {
    if (error instanceof PipelineError) return error;
    if (error instanceof MeshyHttpError) {
      if (error.status === 401) return new PipelineError("meshy_unavailable", "Meshy rejected the configured API key. Check the MESHY_API_KEY secret.", false);
      if (error.status === 402) return new PipelineError("meshy_credits", `Meshy could not start ${what}: ${error.message}`, false);
      if (error.status === 403) return new PipelineError("meshy_failed", `Meshy's content moderation blocked ${what}. Rephrase that part of the prompt.`, false);
      if (error.status === 400 || error.status === 404 || error.status === 422) return new PipelineError("meshy_failed", `Meshy rejected ${what}: ${error.message}`, false);
      return new PipelineError("meshy_unavailable", `Meshy is temporarily unavailable (${error.status || "no response"}) while handling ${what}.`, true);
    }
    return new PipelineError("meshy_unavailable", `Unexpected error talking to Meshy about ${what}.`, true);
  }

  async createPreview(opts: { prompt: string; model: MeshyModel; polycount: number; humanoid: boolean }): Promise<{ id: string; model: MeshyModel }> {
    const body = (model: MeshyModel) => ({
      mode: "preview",
      prompt: opts.prompt.slice(0, 800),
      ai_model: model,
      should_remesh: true,
      topology: "triangle",
      target_polycount: opts.polycount,
      target_formats: ["glb"],
      ...(opts.humanoid ? { pose_mode: "a-pose" } : {}),
    });
    try {
      const res = await this.request<{ result: string }>("POST", TASK_PATHS.text, body(opts.model));
      return { id: res.result, model: opts.model };
    } catch (error) {
      // A retired model id is a 400 that names the model: fall forward to its documented successor.
      const successor = MESHY_MODEL_SUCCESSOR[opts.model];
      if (successor && error instanceof MeshyHttpError && error.status === 400 && /retire|deprecat|ai_model|not (supported|available)/i.test(error.message)) {
        log("meshy_model_fallback", { from: opts.model, to: successor, reason: error.message });
        const res = await this.request<{ result: string }>("POST", TASK_PATHS.text, body(successor));
        return { id: res.result, model: successor };
      }
      throw error;
    }
  }

  async createRefine(previewTaskId: string, opts: { pbr: boolean; texturePrompt?: string }): Promise<string> {
    const res = await this.request<{ result: string }>("POST", TASK_PATHS.text, {
      mode: "refine",
      preview_task_id: previewTaskId,
      enable_pbr: opts.pbr,
      target_formats: ["glb"],
      ...(opts.texturePrompt ? { texture_prompt: opts.texturePrompt.slice(0, 800) } : {}),
    });
    return res.result;
  }

  async createRig(inputTaskId: string, heightMeters: number): Promise<string> {
    const res = await this.request<{ result: string }>("POST", TASK_PATHS.rig, {
      input_task_id: inputTaskId,
      height_meters: Math.min(20, Math.max(0.2, heightMeters)),
    });
    return res.result;
  }

  async createAnimation(rigTaskId: string, source: { actionIds: number[] } | { motionTaskId: string }): Promise<string> {
    const body =
      "actionIds" in source
        ? source.actionIds.length === 1
          ? { rig_task_id: rigTaskId, action_id: source.actionIds[0] }
          : { rig_task_id: rigTaskId, action_ids: source.actionIds.slice(0, 10) }
        : { rig_task_id: rigTaskId, motion_task_id: source.motionTaskId };
    const res = await this.request<{ result: string }>("POST", TASK_PATHS.animation, body);
    return res.result;
  }

  async createMotion(prompt: string, duration: number): Promise<string> {
    const res = await this.request<{ result: string }>("POST", TASK_PATHS.motion, {
      prompt: prompt.slice(0, 400),
      mode: "prime",
      duration: Math.min(10, Math.max(2, Math.round(duration * 2) / 2)),
    });
    return res.result;
  }

  getTask(kind: TaskKind, id: string): Promise<MeshyTask> {
    return this.request<MeshyTask>("GET", `${TASK_PATHS[kind]}/${encodeURIComponent(id)}`);
  }

  /** Newest tasks of a kind, used to find a task whose create response was lost. */
  async listRecent(kind: TaskKind): Promise<MeshyTask[]> {
    const res = await this.request<MeshyTask[] | { result?: MeshyTask[] }>("GET", `${TASK_PATHS[kind]}?page_size=30&sort_by=-created_at`);
    return Array.isArray(res) ? res : (res.result ?? []);
  }

  /** Cancels a PENDING task (refunded by Meshy). Running tasks cannot be canceled (409) and are left alone. */
  async cancelIfPending(kind: TaskKind, id: string): Promise<boolean> {
    try {
      await this.request("DELETE", `${TASK_PATHS[kind]}/${encodeURIComponent(id)}`);
      return true;
    } catch {
      return false;
    }
  }

  async balance(): Promise<number> {
    const res = await this.request<{ balance: number }>("GET", "/v1/balance");
    return res.balance;
  }

  async fetchLibrary(): Promise<LibraryAction[]> {
    const res = await this.request<LibraryAction[] | { result?: LibraryAction[] }>("GET", "/v1/animations/library");
    const list = Array.isArray(res) ? res : (res.result ?? []);
    return list
      .filter((a) => Number.isInteger(a.action_id) && typeof a.name === "string")
      .map((a) => ({ action_id: a.action_id, name: a.name, category: a.category, sub_category: a.sub_category }));
  }
}

const LIBRARY_KEY = "meshy:animation-library:v1";

/** Meshy's animation catalogue, cached in D1 for a day (the pipeline needs it on every generation). */
export async function animationLibrary(env: Env): Promise<LibraryAction[]> {
  const row = await env.DB.prepare("SELECT value, expires_at FROM kv_cache WHERE key = ?").bind(LIBRARY_KEY).first<{ value: string; expires_at: number }>();
  if (row && row.expires_at > now()) {
    try {
      return JSON.parse(row.value) as LibraryAction[];
    } catch {
      /* refetch */
    }
  }
  try {
    const library = await new Meshy(env).fetchLibrary();
    if (library.length === 0) throw new Error("empty library");
    await env.DB.prepare("INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .bind(LIBRARY_KEY, JSON.stringify(library), now() + 24 * 3600_000)
      .run();
    return library;
  } catch (error) {
    if (row) {
      try {
        return JSON.parse(row.value) as LibraryAction[]; // stale is better than none
      } catch {
        /* fall through */
      }
    }
    throw Meshy.toPipelineError(error, "the animation library");
  }
}
