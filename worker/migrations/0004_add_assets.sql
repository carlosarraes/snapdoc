-- Adds the assets table: content-addressed images hosted alongside an artifact.
-- Fresh installs get this from schema.sql; run once against the remote DB:
--   wrangler d1 execute snapdoc --remote --file=migrations/0004_add_assets.sql
CREATE TABLE IF NOT EXISTS assets (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, hash)
);
