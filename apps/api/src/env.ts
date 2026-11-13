export interface Env {
  DB: D1Database;
  /** Absent when the account has not enabled R2 yet. Everything that stores or reads files checks for it. */
  BUCKET?: R2Bucket;
  PIPELINE: Queue<PipelineMessage>;
  ASSETS?: Fetcher;

  // Non-secret configuration (wrangler.jsonc "vars")
  CLERK_PUBLISHABLE_KEY: string;
  GEMINI_MODELS?: string;
  KIVO_PLAN_OVERRIDES?: string;
  MESHY_DAILY_CREDIT_CEILING?: string;
  RENDER_QUEUE_TIMEOUT_MINUTES?: string;
  RENDER_QUALITY?: string;
  /** Extra origins allowed to present Clerk sessions (comma separated). The Worker's own origin is always allowed. */
  ALLOWED_ORIGINS?: string;

  // Secrets
  GEMINI_API_KEY?: string;
  MESHY_API_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_WEBHOOK_SECRET?: string;
  RENDER_SERVICE_TOKEN?: string;
  SIGNING_SECRET?: string;
}

export interface PipelineMessage {
  jobId: string;
}

export interface AuthUser {
  id: string;
  planClaim: string | null;
}

export type AppBindings = { Bindings: Env; Variables: { user: AuthUser; plan: import("@kivo/shared").PlanLimits } };
