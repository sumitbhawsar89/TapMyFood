-- ══════════════════════════════════════════════════
-- Migration: Fix missing columns causing worker crashes
-- Run this on your PostgreSQL instance NOW
-- ══════════════════════════════════════════════════

-- ── Sessions table: missing columns used by worker.js ──
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS platform          VARCHAR(20),
  -- 'swiggy' | 'zomato' | null

  ADD COLUMN IF NOT EXISTS pickup_token      VARCHAR(20),
  -- e.g. "MDB-047" shown to customer for takeaway pickup

  ADD COLUMN IF NOT EXISTS pickup_token_num  INTEGER;
  -- numeric part for auto-increment logic

-- ── Verify ──
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'sessions'
ORDER BY ordinal_position;
