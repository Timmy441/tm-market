-- 011: TM Verified sellers. Safe to run more than once.
-- Nobody is verified automatically: existing sellers start as NOT verified.
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL;