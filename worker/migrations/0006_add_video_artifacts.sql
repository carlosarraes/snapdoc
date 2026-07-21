-- Adds the artifact-kind discriminator and video metadata tables to an
-- already-deployed database. Fresh installs get this from schema.sql; run once
-- against the remote DB:
--   wrangler d1 execute snapdoc --remote --file=migrations/0006_add_video_artifacts.sql

-- Existing (document) artifacts default to 'document', so this backfills cleanly.
ALTER TABLE artifacts
ADD COLUMN kind TEXT NOT NULL DEFAULT 'document'
CHECK (kind IN ('document', 'video'));

-- Per-version video metadata, keyed alongside the shared `versions` row it
-- describes. Only populated for `kind = 'video'` artifacts (later tasks).
CREATE TABLE video_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  video_codec TEXT NOT NULL,
  audio_codec TEXT,
  poster_r2_key TEXT,
  poster_content_type TEXT,
  poster_size_bytes INTEGER,
  PRIMARY KEY (artifact_id, version),
  FOREIGN KEY (artifact_id, version)
    REFERENCES versions(artifact_id, version)
);

-- Generic cursor storage for cron-driven background sweeps (e.g. the orphan
-- audit added in a later task), keyed by sweep name.
CREATE TABLE cleanup_state (
  name TEXT PRIMARY KEY,
  cursor TEXT
);
