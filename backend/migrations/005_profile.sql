-- Phase 8b: server-side profiles + password changes. Safe to run more than once.
-- (location, bio and avatar_url already exist from migration 002.)
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address VARCHAR(500);
-- Set whenever a password changes; tokens issued before this moment stop working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
COMMIT;
