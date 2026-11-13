import { Hono } from "hono";
import { z } from "zod";
import { PLAN_IDS, STAGES, VISUAL_STYLES } from "@kivo/shared";
import { requireUser } from "../auth";
import { assetDto, jobDto, planDto, videoDto, type VideoRow } from "../dto";
import type { AppBindings, Env } from "../env";
import type { AssetRow } from "../pipeline/assets";
import type { JobRow } from "../pipeline/jobs";
import { getPlans } from "../plans";
import { rateLimit } from "../ratelimit";
import { usageSummary } from "../usage";
import { HttpError, fetchWithTimeout, log, now } from "../util";

/** Public, non-secret configuration the web app needs before sign-in. */
export const config = new Hono<AppBindings>();
config.get("/", (c) => {
  const plans = getPlans(c.env);
  return c.json({
    clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    plans: PLAN_IDS.map((id) => planDto(plans[id])),
    // False when the deployment has no file storage: the app then explains that generation is not available yet.
    storageReady: !!c.env.BUCKET,
    stages: STAGES,
    styles: VISUAL_STYLES,
  });
});

export const account = new Hono<AppBindings>();
account.use("*", requireUser);

interface UserRow {
  id: string;
  preferred_mode: "simple" | "advanced";
  onboarded_at: number | null;
  created_at: number;
}

account.get("/me", async (c) => {
  const user = c.get("user");
  const plan = c.get("plan");
  const [row, usage, active, counts] = await Promise.all([
    c.env.DB.prepare("SELECT id, preferred_mode, onboarded_at, created_at FROM users WHERE id = ?").bind(user.id).first<UserRow>(),
    usageSummary(c.env, user.id, plan),
    c.env.DB.prepare("SELECT * FROM jobs WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC").bind(user.id).all<JobRow>(),
    c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM projects WHERE user_id = ?1) AS projects, (SELECT COUNT(*) FROM videos WHERE user_id = ?1) AS videos").bind(user.id).first<{ projects: number; videos: number }>(),
  ]);
  return c.json({
    user: { id: user.id, preferredMode: row?.preferred_mode ?? "simple", onboarded: !!row?.onboarded_at, createdAt: row?.created_at ?? now() },
    plan: planDto(plan),
    usage,
    activeJobs: active.results.map(jobDto),
    counts: { projects: counts?.projects ?? 0, videos: counts?.videos ?? 0 },
  });
});

const MePatch = z.object({ preferredMode: z.enum(["simple", "advanced"]).optional(), onboarded: z.boolean().optional() });

account.patch("/me", async (c) => {
  const user = c.get("user");
  const parsed = MePatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "internal", "Invalid settings.");
  // Mode is a preference only. It is available on every plan and changes nothing about a user's projects.
  if (parsed.data.preferredMode) await c.env.DB.prepare("UPDATE users SET preferred_mode = ?, updated_at = ? WHERE id = ?").bind(parsed.data.preferredMode, now(), user.id).run();
  if (parsed.data.onboarded) await c.env.DB.prepare("UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?").bind(now(), now(), user.id).run();
  return c.json({ ok: true });
});

account.get("/usage", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT u.id, u.kind, u.units, u.period, u.reason, u.created_at, u.job_id, j.kind AS job_kind, p.title AS project_title FROM usage_events u LEFT JOIN jobs j ON j.id = u.job_id LEFT JOIN projects p ON p.id = j.project_id WHERE u.user_id = ? ORDER BY u.created_at DESC LIMIT 100",
  )
    .bind(user.id)
    .all();
  return c.json({ summary: await usageSummary(c.env, user.id, c.get("plan")), events: results });
});

account.get("/jobs", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT j.*, p.title AS project_title FROM jobs j LEFT JOIN projects p ON p.id = j.project_id WHERE j.user_id = ? ORDER BY j.created_at DESC LIMIT 50",
  )
    .bind(user.id)
    .all<JobRow & { project_title: string | null }>();
  return c.json({ jobs: results.map((j) => ({ ...jobDto(j), projectTitle: j.project_title ?? "Deleted project" })) });
});

account.get("/jobs/:id", async (c) => {
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).first<JobRow>();
  if (!job) throw new HttpError(404, "internal", "Job not found.");
  let queue: { position: number } | null = null;
  if (job.render_job_id && job.stage === "preparing_rendering" && job.status === "running") {
    const ahead = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM render_jobs q, render_jobs me WHERE me.id = ? AND q.status = 'queued' AND me.status = 'queued' AND (q.priority > me.priority OR (q.priority = me.priority AND q.created_at < me.created_at))",
    )
      .bind(job.render_job_id)
      .first<{ n: number }>();
    queue = { position: (ahead?.n ?? 0) + 1 };
  }
  return c.json({ job: jobDto(job), queue });
});

account.post("/jobs/:id/cancel", async (c) => {
  const user = c.get("user");
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first<JobRow>();
  if (!job) throw new HttpError(404, "internal", "Job not found.");
  if (job.status !== "queued" && job.status !== "running") return c.json({ job: jobDto(job) });
  await c.env.DB.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?").bind(now(), job.id).run();
  const { cancelJob } = await import("../pipeline/jobs");
  const { enqueue } = await import("../pipeline/run");
  if (job.render_job_id) {
    // Waiting on (or inside) a render: cancel now; the render worker stops at its next progress report.
    await cancelJob(c.env, { ...job, cancel_requested: 1 });
  } else {
    await enqueue(c.env, job.id).catch(() => undefined);
  }
  const fresh = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first<JobRow>();
  return c.json({ job: jobDto(fresh ?? job) });
});

account.get("/render-queue", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.job_id, r.project_id, r.status, r.priority, r.settings, r.frames_total, r.frames_done, r.engine, r.error_code, r.error_message, r.created_at, r.claimed_at, r.finished_at,
            p.title AS project_title, j.stage AS job_stage, j.status AS job_status
     FROM render_jobs r LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN jobs j ON j.id = r.job_id
     WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`,
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  return c.json({
    renders: results.map((r) => {
      const settings = JSON.parse(String(r.settings)) as { width: number; height: number; fps: number; duration: number; watermark: boolean; resolution: string };
      return {
        id: r.id,
        jobId: r.job_id,
        projectId: r.project_id,
        projectTitle: r.project_title ?? "Deleted project",
        status: r.status,
        jobStage: r.job_stage,
        jobStatus: r.job_status,
        framesTotal: r.frames_total,
        framesDone: r.frames_done,
        engine: r.engine,
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        duration: settings.duration,
        watermark: settings.watermark,
        error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
        createdAt: r.created_at,
        startedAt: r.claimed_at,
        finishedAt: r.finished_at,
      };
    }),
  });
});

account.get("/assets", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT a.*, (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_id = a.id) AS __uses FROM assets a WHERE a.user_id = ? ORDER BY a.updated_at DESC LIMIT 300",
  )
    .bind(user.id)
    .all<AssetRow & { __uses: number }>();
  return c.json({ assets: await Promise.all(results.map(async (a) => ({ ...(await assetDto(c.env, a, true)), projectCount: a.__uses }))) });
});

account.delete("/assets/:id", async (c) => {
  const user = c.get("user");
  const asset = await c.env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first<AssetRow>();
  if (!asset) throw new HttpError(404, "internal", "Model not found.");
  const uses = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM project_assets WHERE asset_id = ?").bind(asset.id).first<{ n: number }>();
  if ((uses?.n ?? 0) > 0) throw new HttpError(409, "internal", "This model is used by a project. Delete the project, or remove the model from its scene, first.");
  if (c.env.BUCKET) {
    const listed = await c.env.BUCKET.list({ prefix: `users/${user.id}/assets/${asset.id}/` });
    if (listed.objects.length) await c.env.BUCKET.delete(listed.objects.map((o) => o.key));
  }
  await c.env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(asset.id).run();
  return c.json({ deleted: true });
});

account.get("/videos", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT v.*, p.title AS __title FROM videos v LEFT JOIN projects p ON p.id = v.project_id WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 100",
  )
    .bind(user.id)
    .all<VideoRow & { __title: string | null }>();
  return c.json({ videos: await Promise.all(results.map(async (v) => ({ ...(await videoDto(c.env, v, v.__title ?? "kivo-video")), projectTitle: v.__title ?? "Deleted project" }))) });
});

account.delete("/videos/:id", async (c) => {
  const user = c.get("user");
  const video = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first<VideoRow>();
  if (!video) throw new HttpError(404, "internal", "Video not found.");
  await c.env.BUCKET?.delete([video.r2_key, video.thumbnail_key].filter((k): k is string => !!k));
  const next = await c.env.DB.prepare("SELECT id, thumbnail_key FROM videos WHERE project_id = ? AND id != ? ORDER BY created_at DESC LIMIT 1").bind(video.project_id, video.id).first<{ id: string; thumbnail_key: string | null }>();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM videos WHERE id = ?").bind(video.id),
    c.env.DB.prepare("UPDATE projects SET latest_video_id = ?, thumbnail_key = ?, status = CASE WHEN ? IS NULL THEN 'scene_ready' ELSE status END, updated_at = ? WHERE id = ? AND latest_video_id = ?").bind(
      next?.id ?? null,
      next?.thumbnail_key ?? null,
      next?.id ?? null,
      now(),
      video.project_id,
      video.id,
    ),
  ]);
  return c.json({ deleted: true });
});

/** Remove everything Kivo stores for a user: files in R2 and every row in D1. */
export async function deleteUserData(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET cancel_requested = 1 WHERE user_id = ? AND status IN ('queued', 'running')").bind(userId).run();
  let cursor: string | undefined;
  do {
    if (!env.BUCKET) break;
    const page = await env.BUCKET.list({ prefix: `users/${userId}/`, cursor, limit: 500 });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM project_assets WHERE project_id IN (SELECT id FROM projects WHERE user_id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM videos WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM render_jobs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM scenes WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM jobs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM assets WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM projects WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM usage_events WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM cost_events WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM billing_events WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  log("user_data_deleted", { user: userId });
}

account.delete("/account", async (c) => {
  const user = c.get("user");
  await rateLimit(c.env, `delete-account:${user.id}`, 3, 3600);
  await deleteUserData(c.env, user.id);
  let clerkDeleted = false;
  if (c.env.CLERK_SECRET_KEY) {
    try {
      const res = await fetchWithTimeout(`https://api.clerk.com/v1/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
        timeoutMs: 15_000,
      });
      clerkDeleted = res.ok || res.status === 404;
      if (!clerkDeleted) log("clerk_delete_failed", { status: res.status });
    } catch (error) {
      log("clerk_delete_failed", { error: String(error) });
    }
  }
  // If the Clerk account could not be removed here, the web app finishes the job with the user's own session.
  return c.json({ deleted: true, clerkDeleted });
});
