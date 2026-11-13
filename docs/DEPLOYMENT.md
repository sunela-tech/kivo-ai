# Deploying Kivo

Kivo has three deployable parts:

1. **The Worker** (`apps/api`) — API, pipeline orchestrator, and host of the built web app. Cloudflare Workers + D1 + R2 + Queues.
2. **Clerk** — sign-in, account management and the four billing plans.
3. **Render workers** (`services/renderer`) — Blender. They run on your own compute and pull jobs from the Worker.

## 1. Cloudflare

### Requirements

- **Workers Paid plan.** The pipeline's stage handlers (scene validation, model downloads into R2, several Meshy calls per tick) need more than the Free plan's 10 ms CPU and 50 subrequests per invocation. Queues and R2 are also metered there.
- **R2 enabled** on the account. This is a one-time switch in the dashboard (R2 → enable) and cannot be done through the API.
- An API token for wrangler with **Workers Scripts, D1, Queues and R2: Edit**.

### Deploy

`apps/api/wrangler.jsonc` already names the resources: D1 database `kivo`, bucket `kivo-media`, queues `kivo-pipeline` and `kivo-pipeline-dlq`, and a once-a-minute cron for recovery. If your D1 database has a different id, put it in `d1_databases[0].database_id`.

```bash
scripts/setup-cloudflare.sh
```

That script creates the bucket and queues if they are missing, applies the D1 migrations, builds the web app, deploys the Worker, and uploads the secrets from `apps/api/.dev.vars`.

To do only one of those later:

```bash
npm run db:migrate:remote
```

```bash
npm run deploy
```

```bash
scripts/push-secrets.sh
```

### Secrets

Stored as Worker secrets (never in the repository, never sent to the browser):

| Secret | Used for |
|---|---|
| `GEMINI_API_KEY` | Gemini director calls |
| `MESHY_API_KEY` | Meshy model, rig and animation tasks |
| `CLERK_SECRET_KEY` | Deleting the Clerk user on account deletion |
| `CLERK_WEBHOOK_SECRET` | Verifying Clerk webhook signatures |
| `RENDER_SERVICE_TOKEN` | Authenticating render workers (use a long random string) |
| `SIGNING_SECRET` | Signing media URLs (use a long random string) |

`GET /api/health` reports which of them are configured (true/false only).

### Variables (`wrangler.jsonc` → `vars`)

| Variable | Default | Meaning |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | Kivo dev instance | The Clerk instance whose sessions the Worker accepts |
| `GEMINI_MODELS` | `gemini-flash-latest,gemini-3.5-flash,gemini-2.5-flash,gemini-flash-lite-latest` | Tried in order; an overloaded model is skipped for 10 minutes |
| `KIVO_PLAN_OVERRIDES` | empty | JSON overrides for plan limits, e.g. `{"free":{"videosPerMonth":5},"ultra":{"meshyModel":"meshy-7.1"}}`. Invalid JSON or values are ignored as a whole (and logged) |
| `MESHY_DAILY_CREDIT_CEILING` | `3000` | Hard cap on Meshy credits per UTC day across all users |
| `RENDER_QUEUE_TIMEOUT_MINUTES` | `30` | How long a render may wait for a worker before failing with a refund |
| `RENDER_QUALITY` | `standard` | `draft`, `standard` or `high` (Cycles samples: 12 / 32 / 96) |
| `ALLOWED_ORIGINS` | empty | Extra origins whose Clerk sessions are accepted (the Worker's own origin always is) |

### Cost ceilings

Each plan carries its own limits (`packages/shared/src/plans.ts`): distinct models per scene, Meshy credits per job, Meshy credits per user per day, and render minutes per job. A generation is checked against all of them, the global daily ceiling, and the live Meshy balance **before** any credit is spent; if it would exceed one, the job fails with a refund and a message saying which limit it hit. Real spend (Meshy's `consumed_credits`) is recorded per job in `cost_events`.

## 2. Clerk

The Kivo application's development instance is already configured through Clerk's API:

- sign-in with email code or email link (passwordless), password optional, passkeys, Google;
- Billing for users with four plans whose slugs the Worker maps to Kivo plans: `free_user` (Free, the default), `pro` ($9), `ultra` ($25), `studio` ($69).

Still to do in the Clerk Dashboard (the dashboard is the only place for these):

1. **Webhook.** Webhooks → Add endpoint → `https://<your-worker-host>/api/webhooks/clerk`. Subscribe to `user.created`, `user.updated`, `user.deleted`, and all `subscription.*`, `subscriptionItem.*` and `paymentAttempt.*` events. Copy the endpoint's signing secret into `CLERK_WEBHOOK_SECRET` and run `scripts/push-secrets.sh`.
2. **Production instance** when you go live: create it, point your domain at it, connect a Stripe account under Billing (development instances use Clerk's test gateway), recreate the same four plan slugs, and put the production publishable key in `CLERK_PUBLISHABLE_KEY` and the production secret key in `CLERK_SECRET_KEY`.

How entitlements are verified: Clerk puts the active plan in the session token (`pla: "u:pro"`). The Worker verifies the token's signature against the instance's JWKS and reads the plan from it, so the browser cannot claim a plan. Webhooks keep a `subscriptions` row as the fallback and audit trail.

## 3. Render workers

Blender cannot run on Workers. Run one or more copies of the render service anywhere that can make outbound HTTPS requests to your Worker — no inbound access is needed.

```bash
docker build -t kivo-renderer services/renderer
```

```bash
docker run -d --restart unless-stopped -e KIVO_API_URL=https://<your-worker-host> -e KIVO_RENDER_TOKEN=<RENDER_SERVICE_TOKEN> kivo-renderer
```

On an NVIDIA host add `--gpus all`; Cycles switches to OptiX/CUDA automatically. See `services/renderer/README.md` for all settings.

Sizing, measured on a 4-core CPU with Cycles: a 480p frame of a four-model scene takes about 3 s at `draft` and 9 s at `standard`, so a Free 5-second video (120 frames) renders in 6–18 minutes on CPU. Use GPUs for paid tiers; 1080p60 and 4K on CPU will exceed the plan render-time limits.

Workers claim the highest-priority queued job first (Studio > Ultra > Pro > Free), so paid users are served first whenever there is a backlog. Set `KIVO_MAX_PIXELS` on small workers so they leave 4K jobs for bigger ones.

## 4. Check the deployment

1. `curl https://<host>/api/health` — every integration `true`.
2. Sign up, create a video in Simple Mode, and watch the stages advance. With no render worker running, the job waits at "Preparing rendering" and fails with a refund after `RENDER_QUEUE_TIMEOUT_MINUTES`.
3. Start a render worker; the next job reaches "Completed" with a playable, downloadable MP4.
4. Subscribe to Pro with a Stripe test card on the Subscription page; `/api/me` then reports the Pro limits and new renders have no watermark.

## Operations

- **Logs:** `npx wrangler tail kivo`. Entries are JSON (`job_failed`, `render_claimed`, `gemini_attempt_failed`, …); secrets are redacted before logging.
- **Stuck jobs:** the cron sweeper requeues renders whose worker stopped reporting, fails and refunds renders that exceed their time limit or were never claimed, and re-sends lost pipeline messages. Messages that exhaust their retries land in `kivo-pipeline-dlq`, whose consumer fails the job with a refund.
- **Meshy's `meshy-7`** (the Ultra plan's model) is deprecated and retires on 2026-12-31. Kivo falls forward to `meshy-7.1` automatically if Meshy rejects it; set `{"ultra":{"meshyModel":"meshy-7.1"}}` in `KIVO_PLAN_OVERRIDES` to switch on your own schedule.
- **Gemini quota:** a free-tier Gemini key has no quota for the Pro models and its Flash models are sometimes overloaded. Enable billing on the key's project for production.
