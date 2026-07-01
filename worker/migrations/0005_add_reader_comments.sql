-- Adds reader (anonymous, text-anchored) comments to an already-deployed database.
-- Fresh installs get this from schema.sql; run once against the remote DB:
--   wrangler d1 execute snapdoc --remote --file=migrations/0005_add_reader_comments.sql

-- Owner opt-in for reader comments; OFF by default. Mutually exclusive with a
-- passcode (enforced in the store/handlers, since ALTER cannot add a CHECK).
ALTER TABLE artifacts ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0;

-- Pseudonymous author + text-anchor columns on comments. All nullable / defaulted
-- so existing Access-authored comments are unaffected: author stays NOT NULL and
-- keeps holding the email for 'access' rows. (schema.sql adds the
-- CHECK (author_kind IN ('access','anon')) that ALTER TABLE cannot.)
ALTER TABLE comments ADD COLUMN author_kind   TEXT NOT NULL DEFAULT 'access';
ALTER TABLE comments ADD COLUMN author_email  TEXT;   -- anon-only, unverified
ALTER TABLE comments ADD COLUMN viewer_id     TEXT;   -- anon-only, self-delete capability
ALTER TABLE comments ADD COLUMN anchor_exact  TEXT;
ALTER TABLE comments ADD COLUMN anchor_prefix TEXT;
ALTER TABLE comments ADD COLUMN anchor_suffix TEXT;
ALTER TABLE comments ADD COLUMN anchor_start  INTEGER;
ALTER TABLE comments ADD COLUMN anchor_end    INTEGER;

-- Sliding-window throttle for the anonymous write path (per-IP and per-artifact).
-- ip_hash = SHA-256(ip + COMMENT_IP_SALT); rows are cron-trimmed hourly.
CREATE TABLE IF NOT EXISTS comment_events (
  ip_hash TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_events_ip_time       ON comment_events(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_events_artifact_time ON comment_events(artifact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_artifact_kind       ON comments(artifact_id, author_kind, created_at);
