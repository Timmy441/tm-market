-- Phase 3: sellers + real seller-owned product listings. Safe to run more than once.
BEGIN;

-- Roles: customer, seller, admin
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer', 'seller', 'admin'));

-- Profile fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS location VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- One store per seller account
CREATE TABLE IF NOT EXISTS seller_profiles (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_name VARCHAR(150) NOT NULL,
    description TEXT,
    location VARCHAR(150) NOT NULL,
    whatsapp VARCHAR(20),
    logo_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listings: owner, location, status (VARCHAR + CHECK so adding a status later is a one-line change)
ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS location VARCHAR(150);
ALTER TABLE products ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('active', 'pending', 'sold', 'removed'));
UPDATE products SET status = 'removed' WHERE is_active = FALSE AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- The four categories the storefront already shows
INSERT INTO categories (name, slug) VALUES
  ('Electronics', 'electronics'),
  ('Fashion', 'fashion'),
  ('Accessories', 'accessories'),
  ('Home', 'home')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
