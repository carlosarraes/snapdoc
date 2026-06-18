-- Adds one-level threading (parent_id) and per-thread resolution to comments.
-- Fresh installs get these from schema.sql; run once against the remote DB:
--   wrangler d1 execute snapdoc --remote --file=migrations/0003_add_comment_threads.sql
ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id);
ALTER TABLE comments ADD COLUMN resolved_at TEXT;
ALTER TABLE comments ADD COLUMN resolved_by TEXT;
