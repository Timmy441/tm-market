-- 012: product reviews and ratings. Safe to run more than once.
-- Uses the name product_reviews on purpose: schema.sql already has an older, unused
-- table called "reviews" with different columns, and CREATE TABLE IF NOT EXISTS would
-- silently skip a table whose name already exists.
CREATE TABLE IF NOT EXISTS product_reviews (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  seller_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment VARCHAR(1000),
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_reviews_one_per_order_item UNIQUE (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews(product_id) WHERE is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_product_reviews_seller ON product_reviews(seller_id) WHERE is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_product_reviews_buyer ON product_reviews(buyer_id);
