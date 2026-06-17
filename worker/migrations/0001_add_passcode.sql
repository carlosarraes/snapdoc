-- Adds passcode protection columns to an already-deployed artifacts table.
-- Fresh installs get these from schema.sql; run this once against the remote DB:
--   wrangler d1 execute snapdoc --remote --file=migrations/0001_add_passcode.sql
ALTER TABLE artifacts ADD COLUMN passcode_hash TEXT;
ALTER TABLE artifacts ADD COLUMN passcode_salt TEXT;
