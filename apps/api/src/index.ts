import { Hono } from "hono";
import { errorMessage } from "@kivo/shared";
import type { AppBindings, Env, PipelineMessage } from "./env";
import { sweep } from "./pipeline/render";
import { advanceJob, enqueue } from "./pipeline/run";
import { loadJob, failJob } from "./pipeline/jobs";
import { account, config } from "./routes/account";
import { media } from "./routes/media";
import { projects } from "./routes/projects";
import { renderService } from "./routes/renderService";
import { webhooks } from "./routes/webhooks";
import { findStorage } from "./storage";
import { HttpError, log } from "./util";

const app = new Hono<AppBindings>();

app.use("/api/*", async (c, next) => {
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (!c.req.path.startsWith("/api/media/")) c.res.headers.set("cache-control", "no-store");
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "kivo",
    // Which integrations are configured (booleans only — never values).
    configured: {
      gemini: !!c.env.GEMINI_API_KEY,
      meshy: !!c.env.MESHY_API_KEY,
      clerk: !!c.env.CLERK_PUBLISHABLE_KEY,
      clerkBackend: !!c.env.CLERK_SECRET_KEY,
      clerkWebhooks: !!c.env.CLERK_WEBHOOK_SECRET,
      renderService: !!c.env.RENDER_SERVICE_TOKEN,
      mediaSigning: !!c.env.SIGNING_SECRET,
      storage: !!findStorage(c.env),
    },
    // "r2", "kv" (the fallback for accounts without R2), "r2+kv", or null when there is none.
    storageBackend: findStorage(c.env)?.kind ?? null,
  }),
);

app.route("/api/config", config);
app.route("/api/webhooks", webhooks);
app.route("/api/media", media);
app.route("/api/render", renderService);
app.route("/api/projects", projects);
app.route("/api", account);

app.all("/api/*", () => {
  throw new HttpError(404, "internal", "Unknown API route.");
});

app.onError((error, c) => {
  if (error instanceof HttpError) {
    if (error.status === 429 && error.extra?.retryAfter) c.header("retry-after", String(error.extra.retryAfter));
    return c.json({ error: { code: error.code, message: error.message, ...(error.extra ?? {}) } }, error.status as 400);
  }
  log("unhandled_error", { path: c.req.path, error: error instanceof Error ? error.message : String(error) });
  return c.json({ error: { code: "internal", message: errorMessage("internal") } }, 500);
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    // Everything else is the web app (static assets, with SPA fallback).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Kivo API", { status: 200 });
  },

  /** Pipeline queue: each message advances one job by one or more stages. */
  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const jobId = message.body?.jobId;
      if (typeof jobId !== "string") {
        message.ack();
        continue;
      }
      if (batch.queue.endsWith("-dlq")) {
        // A message that exhausted its retries: fail the job cleanly (and refund) instead of leaving it stuck.
        const job = await loadJob(env, jobId);
        if (job) await failJob(env, job, "interrupted");
        message.ack();
        continue;
      }
      try {
        const again = await advanceJob(env, jobId);
        if (again !== null) await enqueue(env, jobId, again);
        message.ack();
      } catch (error) {
        log("queue_delivery_failed", { job: jobId, error: error instanceof Error ? error.message : String(error) });
        message.retry({ delaySeconds: 20 });
      }
    }
  },

  /** Cron: recover interrupted work (expired render leases, lost queue messages, timeouts). */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await sweep(env);
  },
} satisfies ExportedHandler<Env, PipelineMessage>;
