-- Phase 2: ONE EMAIL = ONE ACCOUNT, ONE PHONE = ONE ACCOUNT (enforced by PostgreSQL)
-- Safe to run more than once. Aborts (changing nothing) if duplicate emails already exist.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate emails (ignoring case) exist in users. Resolve them first.';
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(20)
  CONSTRAINT users_phone_normalized_format
  CHECK (phone_normalized IS NULL OR phone_normalized ~ '^\+234[789][0-9]{9}$');

-- Case-insensitive email uniqueness (Example@x.com == example@x.com)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- Phone uniqueness on the normalised number (NULLs allowed for legacy users without a phone)
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_normalized_key
  ON users (phone_normalized) WHERE phone_normalized IS NOT NULL;

COMMIT;
