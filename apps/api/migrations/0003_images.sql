-- Reference images a user uploads to a project. Each usable image becomes one 3D model
-- through Meshy's Image to 3D; the file itself lives in file storage under
-- users/<user>/uploads/<project>/<image>.<ext>.
CREATE TABLE project_images (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX project_images_project ON project_images (project_id, created_at);
CREATE INDEX project_images_user ON project_images (user_id);

-- A model built from an uploaded image remembers which file it came from.
ALTER TABLE assets ADD COLUMN source_image_key TEXT;
ALTER TABLE assets ADD COLUMN source_image_type TEXT;
