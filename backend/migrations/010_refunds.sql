-- Task G: record refunds on payments. Safe to run more than once.
-- Paste this whole file into Neon's SQL Editor and run it.
-- RUN THIS BEFORE you deploy the backend that goes with it.

DO $$
BEGIN
  IF to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'The payments table is missing. Run schema.sql and the earlier migrations first.';
  END IF;
END $$;

BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS refund_note VARCHAR(300),
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- The same refund reference can never be recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_refund_reference ON payments(refund_reference) WHERE refund_reference IS NOT NULL;

-- A payment marked refunded must carry its reference and date.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_refund_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_refund_check
      CHECK (status <> 'refunded' OR (refund_reference IS NOT NULL AND refunded_at IS NOT NULL));
  END IF;
END $$;

COMMIT;
