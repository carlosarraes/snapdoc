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
  passcode_salt TEXT
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
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_artifact ON comments(artifact_id, created_at);

CREATE INDEX IF NOT EXISTS idx_publish_events_token_time ON publish_events(token_id, created_at);

CREATE INDEX IF NOT EXISTS idx_artifacts_status_expires ON artifacts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_token ON artifacts(token_id);
