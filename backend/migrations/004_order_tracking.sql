-- Phase 8D (part 1): order tracking with a delivery date range.
-- Safe to run more than once. Paste this whole file into Neon's SQL Editor and run it.
-- RUN THIS BEFORE you deploy the backend that goes with it.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'The orders table is missing. Run schema.sql first, then run this file again.';
  END IF;
END $$;

BEGIN;

-- The expected delivery window (a date range) and the real shipped / delivered times.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_window_start DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_window_end DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- The end of the window can never be before its start.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_window_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_delivery_window_check
      CHECK (
        (delivery_window_start IS NULL AND delivery_window_end IS NULL)
        OR (delivery_window_start IS NOT NULL AND delivery_window_end IS NOT NULL
            AND delivery_window_end >= delivery_window_start)
      );
  END IF;
END $$;

-- A simple history of every step an order goes through (shown to the buyer as tracking).
CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at);

COMMIT;
