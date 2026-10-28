-- 014: Paid "Sponsored" listings. Safe to run more than once.
-- This is separate from the existing "promotions" table (discount codes), which is not touched.
BEGIN;

CREATE TABLE IF NOT EXISTS sponsored_listings (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_days INTEGER NOT NULL CHECK (plan_days IN (7, 14, 30)),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(255) NOT NULL UNIQUE,
    -- pending = payment started but not confirmed (the seller never sees these as promotions).
    -- active = paid. Whether it is running right now depends on starts_at / ends_at.
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'paused', 'removed')),
    paid_at TIMESTAMPTZ,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sponsored_product ON sponsored_listings(product_id, status);
CREATE INDEX IF NOT EXISTS idx_sponsored_seller ON sponsored_listings(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sponsored_live ON sponsored_listings(status, starts_at, ends_at);

COMMIT;
