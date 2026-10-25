-- Phase 9: "Request a product" (customers ask for items that are not on TM Market yet).
-- Safe to run more than once.
BEGIN;

CREATE TABLE IF NOT EXISTS product_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    budget NUMERIC(12,2),
    location VARCHAR(150),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'fulfilled')),
    admin_note VARCHAR(500),
    reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_request_images (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT NOT NULL REFERENCES product_requests(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_product_requests_status ON product_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_requests_user ON product_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_request_images_req ON product_request_images(request_id);

COMMIT;
