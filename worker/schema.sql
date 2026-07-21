CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'deleted')),
  token_id TEXT NOT NULL REFERENCES tokens(id),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  blobs_purged_at TEXT,
  passcode_hash TEXT,
  passcode_salt TEXT,
  comments_enabled INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('document', 'video'))
);

CREATE TABLE IF NOT EXISTS versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

-- Per-version video metadata, keyed alongside the shared `versions` row it
-- describes. Only populated for `kind = 'video'` artifacts (later tasks).
CREATE TABLE IF NOT EXISTS video_versions (
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

-- Content-addressed images hosted with an artifact. Keyed by (artifact_id,
-- sha256) so the same image across versions is stored once. The rewritten
-- hosted URL is baked into the stored HTML, so serving needs only id and hash.
CREATE TABLE IF NOT EXISTS assets (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, hash)
);

CREATE TABLE IF NOT EXISTS publish_events (
  token_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  parent_id TEXT REFERENCES comments(id),
  resolved_at TEXT,
  resolved_by TEXT,
  author_kind TEXT NOT NULL DEFAULT 'access' CHECK (author_kind IN ('access', 'anon')),
  author_email TEXT,
  viewer_id TEXT,
  anchor_exact TEXT,
  anchor_prefix TEXT,
  anchor_suffix TEXT,
  anchor_start INTEGER,
  anchor_end INTEGER
);

-- Reader (anonymous) comment write throttle: sliding window keyed by hashed IP
-- and by artifact. ip_hash = SHA-256(ip + COMMENT_IP_SALT).
CREATE TABLE IF NOT EXISTS comment_events (
  ip_hash TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Generic cursor storage for cron-driven background sweeps (e.g. the orphan
-- audit added in a later task), keyed by sweep name.
CREATE TABLE IF NOT EXISTS cleanup_state (
  name TEXT PRIMARY KEY,
  cursor TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_artifact ON comments(artifact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_artifact_kind ON comments(artifact_id, author_kind, created_at);

CREATE INDEX IF NOT EXISTS idx_comment_events_ip_time ON comment_events(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_events_artifact_time ON comment_events(artifact_id, created_at);

CREATE INDEX IF NOT EXISTS idx_publish_events_token_time ON publish_events(token_id, created_at);

CREATE INDEX IF NOT EXISTS idx_artifacts_status_expires ON artifacts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_token ON artifacts(token_id);
