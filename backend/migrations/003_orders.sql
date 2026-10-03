-- Phase 8A: orders (one order per seller). Safe to run more than once.
-- Paste this whole file into Neon's SQL Editor and run it.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'The orders, order_items or payments table is missing. Run schema.sql first, then run this file again.';
  END IF;
END $$;

BEGIN;

-- Which seller an order belongs to (needed to pay the right seller later).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);

COMMIT;
