-- Adds the comments table to an already-deployed database.
-- Fresh installs get this from schema.sql; run once against the remote DB:
--   wrangler d1 execute snapdoc --remote --file=migrations/0002_add_comments.sql
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_artifact ON comments(artifact_id, created_at);
