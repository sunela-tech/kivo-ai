# Kivo architecture

## The scene is the contract

Everything revolves around one validated document, the **SceneSpec** (`packages/shared/src/scene.ts`): the models a scene needs, where each instance stands, movement keyframes, skeletal clips, procedural motion, cameras, shots, lights and the sky. Gemini writes it, the editor edits it, Blender renders it.

- It is **data, not code.** Gemini answers through constrained JSON output; the Worker parses that again with zod and repairs or rejects it (`normalizeScene`). The render service validates the scene a third time, independently, and maps it onto fixed Blender operations. Nothing Gemini produces is ever executed.
- **Preview equals render.** What a scene means at time *t* is defined once, in `packages/shared/src/interp.ts`. The browser preview calls it directly; `services/renderer/kivo_renderer/sampling.py` is a line-for-line port, and a shared fixture test fails if they ever disagree. Motion, framing and the edit therefore match exactly. Lighting is approximate in the preview (a real-time rasteriser against Cycles path tracing); both meter exposure automatically to the same brightness targets.
- Conventions: Y-up, metres, degrees, seconds; characters face +Z at zero rotation; the ground is y = 0. Each model is normalised to the real-world size the scene asks for, so Gemini never needs to know a mesh's raw dimensions.

## The pipeline

A generation is a row in `jobs` advanced by queue messages. Each delivery takes a short lock, runs the handler for the job's current stage, saves the result into `jobs.state`, and either continues, schedules itself again, or parks. Any delivery can resume a job after a crash or redeploy.

| # | Stage shown to the user | What actually happens |
|---|---|---|
| 1 | Understanding prompt | Gemini reads the idea — and looks at any uploaded images — and returns a brief (or a polite rejection) |
| 2 | Planning 3D scene | Gemini chooses the models and the world; cost ceilings are checked; asset rows are created or reused |
| 3 | Generating models with Meshy | Text to 3D *preview* tasks, and one *Image to 3D* task per model built from an uploaded image; progress is the mean of Meshy's own task progress |
| 4 | Preparing textures | Text to 3D *refine* tasks; GLBs and thumbnails are copied into file storage (R2, or Workers KV when R2 is off) |
| 5 | Rigging characters | Meshy rigging for humanoids, then library clips (and optional Text to Motion) |
| 6 | Creating animations | Gemini places objects and choreographs them, knowing which clips really exist |
| 7 | Adjusting cameras | Gemini designs cameras, the edit and lighting against the sampled motion; then code moves cameras out of models and above ground, and matches walk/run clips and their speed to how fast each character really travels |
| 8 | Preparing rendering | The export is clamped to the plan; a render job is queued with the plan's priority |
| 9 | Rendering video | A render worker reports frames rendered — the only percentage shown |
| 10 | Encoding MP4 | ffmpeg → H.264, yuv420p, faststart |
| 11 | Saving video | Upload to file storage through the Worker |
| 12 | Completed | Set only after the stored file passes verification |

Stages 9–11 are driven by the render service's reports (`/api/render/*`), not by the queue.

### Meshy assets

`apps/api/src/pipeline/assets.ts` is a small state machine per model. Every "create a Meshy task" step first moves the row into a `*_creating` state with a compare-and-swap, so duplicate queue deliveries — or two jobs sharing a model — cannot create and pay for the same task twice. Meshy has no idempotency key, so if a create response is lost the row waits a minute, lists Meshy's newest tasks, and adopts the orphan instead of creating another.

Models are reused per user when the prompt, plan model and rig request are identical; a reused model costs nothing. Assets are stored under `users/<userId>/assets/<assetId>/`.

### Models from uploaded images

A project can carry up to four reference images (three on Free: one model slot is always kept for the ground). They are uploaded as the request body of `POST /api/projects/:id/images`, checked by their bytes (JPEG, PNG or WebP only; real pixel size read from the header; at most 4 MB after the browser has scaled them to 1536 px), stored privately under `users/<user>/uploads/<project>/`, and listed in `project_images`.

When a generation starts, the project's images are snapshotted into the job:

1. **Understanding prompt.** Gemini is sent the images themselves, once. For each it reports the subject, whether it is *usable* (one clear object or character — not a scene, a group, or a screenshot), whether it is a humanoid, and a description. A written idea is optional when there is at least one image.
2. **Planning.** Gemini is given those notes as text. Every usable image must become exactly one model (`imageIndex` on the plan's asset). `planToAssets` enforces it: an image is never used twice or for the terrain, a usable image the plan forgot gets its model added, and image models survive the scene limit ahead of everything but the ground. Images that are not usable are reported to the user as warnings, with Gemini's reason.
3. **Models.** A model with a source image takes one Meshy **Image to 3D** task (geometry and textures together, the image sent as a data URI, `moderation` on, `pose_mode: a-pose` for humanoids) instead of the preview/refine pair. From there it is the same asset as any other: stored, rigged if humanoid, given clips. It is cached by the image's SHA-256, so the same picture is never paid for twice.

Image to 3D costs 15 Meshy credits with Meshy 6 Lite and 30 with the other models; the estimate and the cost ceilings use those figures.

### Rigging, honestly

Meshy rigs clear bipeds only. A model is `rigged`, `unsupported` (Meshy declined it), `failed`, or was never meant to be rigged. Only `rigged` models expose clips; the scene validator removes skeletal clips from anything else and tells the user why. Unrigged models still move — along keyframed paths, with procedural motion layered on top.

### Rendering

Render workers **pull** work: `claim` returns the highest-priority queued job (plan priority, then age) with the scene and URLs for its models. A claim is a lease kept alive by progress reports. The cron sweeper requeues a job whose lease expired (once), and fails-and-refunds on a second loss, a plan time-limit overrun, or a job nobody claimed.

The worker renders frame by frame in a Blender subprocess (so a crash cannot take the worker down), cross-dissolves and fades in image space, meters exposure automatically from a few probe frames, encodes with ffmpeg, and decodes the result to check codec, size and frame count before uploading. The Worker then checks the stored object again before a `videos` row exists.

## Money and limits

- **Quota** is an append-only ledger (`usage_events`). Reserving a video is one `INSERT … SELECT … WHERE used < limit`; a refund is an insert guarded by `UNIQUE (job_id, kind)`. Parallel requests cannot overshoot, and a job can be neither charged twice nor refunded twice.
- **A scene-only generation** (Advanced Mode) reserves one video and attaches a prepaid render to the project, so generating and then rendering costs one video, not two.
- **Concurrency** is enforced in the same statement that inserts the job.
- **Plan** is read from the Clerk-signed session claim on every request and snapshotted onto the job.
- **Editing is never limited by plan.** `PUT /scene` validates structure only. Limits apply when a render is queued (`clampRenderToPlan`), and the response lists what was reduced.

## Security

- Sessions: RS256 JWTs verified against the configured Clerk instance's JWKS; `azp` must be an origin Kivo serves.
- Ownership: every project, scene, asset, job and video query is scoped by `user_id`; another user's id is "not found".
- Media: the bucket is private. Authenticated responses contain HMAC-signed URLs bound to one object and expiring after an hour; `/api/media/o/…` serves them with Range support.
- Render service: a separate bearer secret; workers can only fetch models that belong to the job they hold.
- Webhooks: Svix signature (HMAC-SHA256, constant-time compare, five-minute window) and idempotency by `svix-id`.
- Rate limits: per-user fixed windows in D1 on generation, the AI Director, scene saves and project creation.

## AI Director

In the editor, an instruction is sent to Gemini with a compact copy of the scene. Gemini replies with typed operations (`packages/shared/src/ops.ts`) — `upsert_camera`, `set_move`, `set_clips`, `upsert_light`, `set_world`, `set_shots`, `update_object`, `add_asset`, … — which are applied as a pure function and validated. Untouched parts of the scene are untouched by construction. Only `add_asset` creates Meshy work, and never for a model that already exists; the scene updates when the new model is ready. Operations that reference missing things are skipped and reported, not guessed.

## Database

`apps/api/migrations/0001_init.sql`: `users`, `subscriptions`, `billing_events`, `projects`, `scenes` (versioned scene configurations), `assets`, `project_assets`, `jobs` (generation tasks), `render_jobs`, `videos`, `usage_events`, `cost_events`, `rate_limits`, `kv_cache`.
