-- TapMyFood — AI Chatbot Migration
-- Run on server: psql $DATABASE_URL -f migrate.sql

-- 1. Sessions — platform lock + upsell tracking
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS platform_locked  boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS upsell_shown     boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bill_status      varchar(20) DEFAULT 'none';
-- bill_status: none | draft | payment_pending | paid

-- 2. Bills — draft flag for dine-in live bill
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS is_draft         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_type     varchar(20) DEFAULT 'direct';
-- payment_type: direct | platform (zomato/swiggy)

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('sessions','bills')
  AND column_name IN (
    'platform_locked','upsell_shown','bill_status',
    'is_draft','payment_type'
  )
ORDER BY table_name, column_name;
