-- Phase 9A: seller earnings, bank details and withdrawal requests.
-- Safe to run more than once. Paste this whole file into Neon's SQL Editor and run it.
-- RUN THIS BEFORE you deploy the backend that goes with it.

DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL
     OR to_regclass('public.payments') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'The orders, payments or users table is missing. Run schema.sql and the earlier migrations first.';
  END IF;
END $$;

BEGIN;

-- Where a seller wants to be paid (one account per seller).
CREATE TABLE IF NOT EXISTS seller_bank_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_name VARCHAR(80) NOT NULL,
  bank_code VARCHAR(10),
  account_number VARCHAR(10) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seller_bank_number_check CHECK (account_number ~ '^[0-9]{10}$')
);

-- What each paid order is worth to its seller. The fee rate used is saved with the row,
-- so changing the rate later never changes old earnings.
CREATE TABLE IF NOT EXISTS order_earnings (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  gross NUMERIC(12, 2) NOT NULL,
  fee_percent NUMERIC(5, 2) NOT NULL,
  fee NUMERIC(12, 2) NOT NULL,
  net NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_earnings_amounts_check CHECK (gross >= 0 AND fee >= 0 AND net >= 0),
  CONSTRAINT order_earnings_percent_check CHECK (fee_percent >= 0 AND fee_percent <= 100)
);
CREATE INDEX IF NOT EXISTS idx_order_earnings_seller ON order_earnings(seller_id);

-- Every withdrawal request and what happened to it. The bank details are copied onto the
-- request, so the record stays correct even if the seller changes their bank later.
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  bank_name VARCHAR(80) NOT NULL,
  bank_code VARCHAR(10),
  account_number VARCHAR(10) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  admin_note VARCHAR(300),
  payment_reference VARCHAR(120),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT withdrawals_amount_check CHECK (amount > 0),
  CONSTRAINT withdrawals_status_check CHECK (status IN ('pending', 'approved', 'processing', 'paid', 'rejected', 'failed')),
  CONSTRAINT withdrawals_paid_check CHECK (status <> 'paid' OR (payment_reference IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_seller ON withdrawals(seller_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
-- The database itself allows only ONE open request per seller.
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_one_open ON withdrawals(seller_id) WHERE status IN ('pending', 'approved', 'processing');
-- The same transfer reference can never be recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_reference ON withdrawals(payment_reference) WHERE payment_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS withdrawal_events (
  id BIGSERIAL PRIMARY KEY,
  withdrawal_id BIGINT NOT NULL REFERENCES withdrawals(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  note VARCHAR(300),
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_withdrawal_events_withdrawal ON withdrawal_events(withdrawal_id);

-- Earnings for orders that were already paid before this migration (10% platform fee).
INSERT INTO order_earnings (order_id, seller_id, gross, fee_percent, fee, net)
SELECT o.id, o.seller_id, o.total, 10,
       ROUND(o.subtotal * 10 / 100, 2),
       GREATEST(o.total - ROUND(o.subtotal * 10 / 100, 2), 0)
FROM orders o
JOIN payments p ON p.order_id = o.id AND p.status = 'successful'
WHERE o.seller_id IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;

COMMIT;
