-- Index for the fallback file store (see apps/api/src/storage.ts).
-- Used only when the deployment keeps files in Workers KV because R2 is not enabled:
-- the bytes live in KV under files/<gen>/<part>, and this table records what each file is.
CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  parts INTEGER NOT NULL,
  part_bytes INTEGER NOT NULL,
  gen TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
