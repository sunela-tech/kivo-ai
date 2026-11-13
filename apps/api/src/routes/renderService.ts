import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { assetKey } from "../pipeline/assets";
import { claimRenderJob, completeRender, failRender, loadRenderJob, reportProgress, storeUpload } from "../pipeline/render";
import { storage } from "../storage";
import { HttpError, timingSafeEqual } from "../util";

/**
 * API for the external Blender render service. Authenticated with a shared
 * bearer secret (RENDER_SERVICE_TOKEN) — never with user sessions.
 */
export const renderService = new Hono<AppBindings>();

const requireRenderToken: MiddlewareHandler<AppBindings> = async (c, next) => {
  const expected = c.env.RENDER_SERVICE_TOKEN;
  if (!expected || expected.length < 24) throw new HttpError(503, "internal", "The render service is not configured (RENDER_SERVICE_TOKEN secret is missing).");
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !timingSafeEqual(token, expected)) throw new HttpError(401, "internal", "Invalid render service token.");
  await next();
};
renderService.use("*", requireRenderToken);

async function json<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "internal", `Invalid request: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

const WorkerId = z.string().min(1).max(120);

renderService.post("/claim", async (c) => {
  const input = await json(c, z.object({ workerId: WorkerId, maxPixels: z.number().int().positive().max(3840 * 2160).default(3840 * 2160) }));
  const job = await claimRenderJob(c.env, input.workerId, input.maxPixels);
  if (!job) return new Response(null, { status: 204 });
  return c.json(job);
});

renderService.get("/jobs/:id/files/:assetId/:file", async (c) => {
  const row = await loadRenderJob(c.env, c.req.param("id"));
  if (!row || !["claimed", "rendering", "encoding", "uploading"].includes(row.status)) throw new HttpError(404, "internal", "This render job is not active.");
  const file = c.req.param("file");
  if (!/^[a-z0-9][a-z0-9_.-]{0,80}\.glb$/.test(file)) throw new HttpError(400, "internal", "Invalid file name.");
  // The model must belong to this render's project and owner.
  const link = await c.env.DB.prepare("SELECT a.id FROM project_assets pa JOIN assets a ON a.id = pa.asset_id WHERE pa.project_id = ? AND a.id = ? AND a.user_id = ?")
    .bind(row.project_id, c.req.param("assetId"), row.user_id)
    .first<{ id: string }>();
  if (!link) throw new HttpError(404, "internal", "This model is not part of the render.");
  const object = await storage(c.env).get(assetKey(row.user_id, link.id, file));
  if (!object) throw new HttpError(404, "storage_error", "The model file is missing from storage.");
  return new Response(object.body, { headers: { "content-type": "model/gltf-binary", "content-length": String(object.size) } });
});

renderService.post("/jobs/:id/progress", async (c) => {
  const input = await json(
    c,
    z.object({
      workerId: WorkerId,
      phase: z.enum(["preparing", "rendering", "encoding", "uploading"]),
      framesDone: z.number().int().min(0).optional(),
      framesTotal: z.number().int().min(0).optional(),
      engine: z.string().max(40).optional(),
    }),
  );
  return c.json(await reportProgress(c.env, c.req.param("id"), input));
});

renderService.put("/jobs/:id/:kind{video|thumbnail}", async (c) => {
  const workerId = c.req.header("x-kivo-worker") ?? "";
  if (!workerId) throw new HttpError(400, "internal", "Missing X-Kivo-Worker header.");
  await storeUpload(c.env, c.req.param("id"), workerId, c.req.param("kind") as "video" | "thumbnail", c.req.raw);
  return c.json({ stored: true });
});

renderService.post("/jobs/:id/complete", async (c) => {
  const input = await json(
    c,
    z.object({
      workerId: WorkerId,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().positive(),
      frames: z.number().int().positive(),
      durationSeconds: z.number().positive(),
      bytes: z.number().int().positive(),
      codec: z.string().max(20),
      engine: z.string().max(40).optional(),
      notes: z.array(z.string().max(400)).max(20).optional(),
    }),
  );
  return c.json(await completeRender(c.env, c.req.param("id"), input));
});

renderService.post("/jobs/:id/fail", async (c) => {
  const input = await json(c, z.object({ workerId: WorkerId, code: z.string().max(40), message: z.string().max(600), retryable: z.boolean().default(true) }));
  await failRender(c.env, c.req.param("id"), input);
  return c.json({ ok: true });
});
