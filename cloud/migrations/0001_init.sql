-- INKOS Cloud storage. Users are Clerk user ids; nothing else about them is kept.

-- images generated per user per UTC day, for the plans' daily limits
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  images  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- projects besides the implicit "default" one
CREATE TABLE IF NOT EXISTS projects (
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

-- the gallery: every saved PNG with its generation settings
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  project    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta       TEXT NOT NULL,
  png        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS images_by_user ON images (user_id, project, created_at);
