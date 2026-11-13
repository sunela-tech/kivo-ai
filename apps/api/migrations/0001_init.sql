-- Kivo database schema (Cloudflare D1 / SQLite). Timestamps are Unix milliseconds.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                         -- Clerk user id
  email TEXT,
  display_name TEXT,
  preferred_mode TEXT NOT NULL DEFAULT 'simple' CHECK (preferred_mode IN ('simple', 'advanced')),
  onboarded_at INTEGER,                        -- set when the first-video welcome screen is completed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'ultra', 'studio')),
  status TEXT NOT NULL DEFAULT 'active',
  clerk_plan_slug TEXT,
  clerk_subscription_id TEXT,
  period_end INTEGER,
  source TEXT NOT NULL DEFAULT 'default',      -- 'session' (signed Clerk token) | 'webhook' | 'default'
  updated_at INTEGER NOT NULL
);

CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,                         -- svix-id: makes webhook handling idempotent
  type TEXT NOT NULL,
  user_id TEXT,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX billing_events_user ON billing_events (user_id, received_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'simple' CHECK (mode IN ('simple', 'advanced')),
  style TEXT NOT NULL DEFAULT 'cinematic',
  duration REAL NOT NULL,
  fps INTEGER NOT NULL,
  aspect TEXT NOT NULL,
  resolution TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | generating | scene_ready | rendering | ready | failed
  scene_id TEXT,                               -- current scene version
  latest_video_id TEXT,
  thumbnail_key TEXT,
  render_credits INTEGER NOT NULL DEFAULT 0,   -- renders already paid for by a scene-only generation
  share_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_user ON projects (user_id, updated_at);

-- Scene configurations: every save, generation and AI Director edit is a new version.
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,                        -- gemini | user | director
  note TEXT,
  spec TEXT NOT NULL,                          -- validated SceneSpec JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX scenes_project ON scenes (project_id, version);

-- Meshy-generated 3D models. One row per distinct (user, prompt, model, rig) so they are reused.
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  rig_mode TEXT NOT NULL DEFAULT 'none',
  ai_model TEXT NOT NULL,
  spec TEXT NOT NULL,                          -- the SceneAsset that requested it (actions, motions, size)
  status TEXT NOT NULL DEFAULT 'pending',      -- see apps/api/src/pipeline/assets.ts
  progress INTEGER NOT NULL DEFAULT 0,         -- Meshy's reported progress for the current task
  rig_status TEXT NOT NULL DEFAULT 'none',     -- none | pending | rigged | unsupported | failed
  rig_note TEXT,
  preview_task_id TEXT,
  refine_task_id TEXT,
  rig_task_id TEXT,
  anim_task_id TEXT,
  motion_task_id TEXT,
  motion_anim_task_id TEXT,
  marker_at INTEGER,                           -- when the in-flight "create task" request started
  retries INTEGER NOT NULL DEFAULT 0,
  model_key TEXT,
  rigged_key TEXT,
  thumbnail_key TEXT,
  clips TEXT NOT NULL DEFAULT '{}',            -- { clipName: { key, file, animation? } }
  bytes INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,          -- Meshy credits spent on this asset
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  UNIQUE (user_id, cache_key)
);
CREATE INDEX assets_user ON assets (user_id, updated_at);

CREATE TABLE project_assets (
  project_id TEXT NOT NULL,
  alias TEXT NOT NULL,                         -- the asset id used inside the project's scene
  asset_id TEXT NOT NULL,
  PRIMARY KEY (project_id, alias)
);
CREATE INDEX project_assets_asset ON project_assets (asset_id);

-- Generation tasks: one row per Generate / Render / AI Director run.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('generate', 'render', 'director')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  stage TEXT NOT NULL,
  progress REAL,                               -- 0..1, only when the underlying system reports a real number
  detail TEXT,
  plan TEXT NOT NULL,                          -- plan snapshot at creation (limits are enforced against this)
  params TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',            -- persisted working state so every stage can resume
  result TEXT,                                 -- 'video' | 'scene'
  warnings TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  render_job_id TEXT,
  video_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX jobs_user ON jobs (user_id, created_at);
CREATE INDEX jobs_status ON jobs (status, updated_at);
CREATE INDEX jobs_project ON jobs (project_id, created_at);

CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | claimed | rendering | encoding | uploading | succeeded | failed | canceled
  priority INTEGER NOT NULL DEFAULT 0,
  pixels INTEGER NOT NULL,
  settings TEXT NOT NULL,
  worker_id TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  frames_total INTEGER NOT NULL,
  frames_done INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  notes TEXT NOT NULL DEFAULT '[]',
  video_key TEXT,
  thumbnail_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  deadline_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX render_jobs_queue ON render_jobs (status, priority, created_at);
CREATE INDEX render_jobs_project ON render_jobs (project_id, created_at);

-- Completed videos. A row exists only after the MP4 is stored and verified.
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  render_job_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  thumbnail_key TEXT,
  bytes INTEGER NOT NULL,
  duration REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fps INTEGER NOT NULL,
  codec TEXT NOT NULL,
  watermark INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX videos_project ON videos (project_id, created_at);
CREATE INDEX videos_user ON videos (user_id, created_at);

-- Usage history: an append-only ledger. A job reserves one video when it starts and is
-- refunded if it fails or is canceled. UNIQUE (job_id, kind) makes both idempotent, so a
-- job can never be charged twice or refunded twice.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reserve', 'refund')),
  units INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,                        -- 'YYYY-MM' (UTC)
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (job_id, kind)
);
CREATE INDEX usage_user_period ON usage_events (user_id, period);

-- Provider spend, for cost ceilings (Meshy credits, Gemini calls, render seconds).
CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT,
  provider TEXT NOT NULL,                      -- meshy | gemini | render
  units INTEGER NOT NULL,
  detail TEXT,
  day TEXT NOT NULL,                           -- 'YYYY-MM-DD' (UTC)
  created_at INTEGER NOT NULL
);
CREATE INDEX cost_provider_day ON cost_events (provider, day);
CREATE INDEX cost_user_day ON cost_events (user_id, provider, day);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);

CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
