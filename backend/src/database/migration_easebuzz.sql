-- ══════════════════════════════════════════════════
-- Migration: Razorpay → Easebuzz + Refund support
-- Run once on your PostgreSQL instance
-- ══════════════════════════════════════════════════

-- ── 1. Bills table: add Easebuzz columns ──
ALTER TABLE bills
  -- Easebuzz replaces Razorpay
  ADD COLUMN IF NOT EXISTS easebuzz_txnid       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS easebuzz_payment_id  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS easebuzz_status      VARCHAR(30) DEFAULT 'initiated',
  -- easebuzz_status: initiated | success | failure | dropped

  -- Refund tracking
  ADD COLUMN IF NOT EXISTS refund_amount        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_reason        TEXT,
  ADD COLUMN IF NOT EXISTS refund_method        VARCHAR(20),
  -- refund_method: easebuzz | offline

  ADD COLUMN IF NOT EXISTS easebuzz_refund_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS refunded_at          TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cash_collected       BOOLEAN DEFAULT false,

  -- Update payment_status to allow partial_refund
  -- (status column already exists as: unpaid | paid | refunded)
  -- We just need to allow a new value — Postgres TEXT doesn't restrict values
  -- So no change needed on the column itself

  -- Extra columns for restaurants table
  ADD COLUMN IF NOT EXISTS free_delivery_above  INTEGER DEFAULT 0;

-- ── 2. Update payment_status values if needed ──
-- Existing bills with razorpay data stay intact, new ones use easebuzz columns

-- ── 3. Restaurants table extras ──
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS platform_fee         INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS free_delivery_above  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owner_phone          VARCHAR(20);

-- ── 4. Set owner phone for existing restaurant ──
-- Update this with your actual owner number
UPDATE restaurants
SET owner_phone = '918956664759'
WHERE slug = 'makedates-burger';

-- ── 5. Index for fast txnid lookup ──
CREATE INDEX IF NOT EXISTS idx_bills_easebuzz_txnid ON bills(easebuzz_txnid);

-- ── 6. Verify ──
SELECT
  column_name, data_type
FROM information_schema.columns
WHERE table_name = 'bills'
  AND column_name LIKE '%easebuzz%'
   OR column_name LIKE '%refund%'
ORDER BY column_name;

