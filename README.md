# Kivo

**Imagine it. Animate it.** Kivo turns a written idea into a real animated 3D video.

> Write an idea → **Meshy** creates the 3D models → **Gemini** directs the animation → **Blender** renders the scene → Kivo delivers an **MP4**.

Simple Mode does all of that from one prompt. Advanced Mode opens a full 3D editor — viewport, timeline, cameras, lights, materials, shots and an AI Director — so you can change anything before you render. Both modes are available on every plan, including Free.

## How it works

```
 Browser (React + R3F)                Cloudflare Worker (Hono)                     Outside Cloudflare
 ─────────────────────                ────────────────────────                     ──────────────────
 Clerk sign-in ───── session JWT ───▶ verify JWT (JWKS) · plan from signed claim
 Create / Editor ─── /api ──────────▶ quota + concurrency (atomic, D1) ──┐
                                                                         ▼
                                      Queue "kivo-pipeline"  ──▶ stage handlers:
                                        1 understand prompt  ──────────────────▶  Gemini (structured JSON)
                                        2 plan scene         ──────────────────▶  Gemini
                                        3 models  4 textures 5 rig + clips ────▶  Meshy  ──▶ GLBs cached in storage
                                        6 animation  7 cameras/lights ─────────▶  Gemini ──▶ validated SceneSpec (D1)
                                        8 render job queued (priority by plan)
                                                                         ▲
                                      /api/render/* (token) ◀── claim · progress · upload · complete ── Blender render
                                        9 rendering (frames)  10 encoding  11 saving                    workers (pull)
                                       12 completed — only after the MP4 is stored and verified
 <video> / download ◀─ signed URL ─── /api/media/o/… (HMAC, expiring, Range)
```

| Part | Where | What it does |
|---|---|---|
| Web app | `apps/web` | React 19, TypeScript, Tailwind 4, Clerk, React Three Fiber editor |
| API + orchestrator | `apps/api` | Cloudflare Worker: Hono routes, D1, R2 (or Workers KV when R2 is not enabled), Queues, cron sweeper |
| Shared contracts | `packages/shared` | Plans, the 12 stages, the validated `SceneSpec`, the scene sampler, Gemini contracts, AI Director operations |
| Render service | `services/renderer` | Python + Blender 5.2 LTS + ffmpeg; pulls jobs, renders, encodes, verifies, uploads |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Deploying: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Plans

Defined in [`packages/shared/src/plans.ts`](packages/shared/src/plans.ts) and overridable at deploy time with the `KIVO_PLAN_OVERRIDES` variable (JSON, same shape, partial).

| | Free | Pro | Ultra | Studio |
|---|---|---|---|---|
| Monthly price | $0 | $9 | $25 | $69 |
| Videos / month | 3 | 30 | 100 | 300 |
| Maximum duration | 5 s | 20 s | 60 s | 180 s |
| Maximum resolution | 480p | 720p | 1080p | 4K |
| FPS | 24 | 30 | 60 | 60 |
| Concurrent jobs | 1 | 2 | 4 | 8 |
| Meshy model | Meshy 6 Lite | Meshy 6 | Meshy 7 | Meshy 7.1 |
| Simple Mode · Advanced Mode · 3D editor · animation, camera and lighting editors · AI Director | ✓ | ✓ | ✓ | ✓ |
| Watermark | Yes | No | No | No |
| Render priority | Standard | High | Higher | Highest |

Plans limit **exports and quotas only**. A Free user can build a 60-second, multi-camera scene; the render is trimmed to Free's 5 s / 480p / 24 fps and watermarked, and the scene keeps everything.

Limits are enforced on the server: the plan comes from the `pla` claim inside the Clerk-signed session token (never from the browser), quota and concurrency are single atomic SQL statements, and failed or canceled jobs are refunded exactly once.

## Run it locally

Requirements: Node 20+, Python 3.13 with ffmpeg (for the render worker).

```bash
npm install
```

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Fill in `apps/api/.dev.vars` (Gemini, Meshy and Clerk keys; any long random strings for `RENDER_SERVICE_TOKEN` and `SIGNING_SECRET`). The file is gitignored. Then, in three terminals:

```bash
npm run db:migrate:local && npm run dev:api
```

```bash
npm run dev:web
```

```bash
cd services/renderer && pip install -r requirements.txt && KIVO_API_URL=http://localhost:8787 KIVO_RENDER_TOKEN=<RENDER_SERVICE_TOKEN> python -m kivo_renderer.worker
```

Open http://localhost:5173.

If your network forces outbound traffic through an HTTPS proxy (cloud dev containers), `wrangler dev` cannot reach Clerk, Gemini or Meshy because the local Workers runtime ignores `HTTPS_PROXY`. Use the proxied runner instead of `npm run dev:api`:

```bash
node scripts/dev-sandbox.mjs
```

## Tests

```bash
npm test
```

```bash
cd services/renderer && pip install -r requirements-dev.txt && python -m pytest -q
```

- `packages/shared` — plans, stage list, scene validation and repair, sampler, Gemini contracts, AI Director operations.
- `apps/api` — the real Worker code against local D1, R2 and KV (Miniflare) with Clerk, Gemini and Meshy scripted: authentication, plan enforcement, quota and refunds, privacy, the render-service protocol, the whole pipeline, the AI Director, webhooks.
- `services/renderer` — sampler parity with the TypeScript sampler, job validation, H.264 encoding and verification, and a real Blender render.

## What Kivo does not pretend

- **Rigging** uses Meshy's auto-rigger, which only handles clear two-legged humanoids. Everything else — and any humanoid Meshy declines — is kept, labelled "rigid body" in the UI, and animated with keyframes and procedural motion (hover, hop, sway, spin…). It is never shown as rigged.
- **Progress bars** appear only where a real number exists: Meshy's task progress and Blender's frame count. Other stages show that they are running, without a percentage.
- **"Completed"** is set only after the MP4 is in file storage and passes verification (decodes as H.264 with the expected frame count and size on the render worker; container and codec checked again by the Worker).
- **Blender never runs on Workers.** Rendering needs a separate machine running `services/renderer`. Without one, jobs wait in the queue and then fail with a refund and a clear message.
- **Sky and atmosphere** are world lighting in Blender, not Meshy models. Every visible object, including the ground, is a Meshy model.
- **Audio** is not generated; videos are silent.
