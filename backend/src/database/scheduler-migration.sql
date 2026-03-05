-- ═══════════════════════════════════════════
-- Migration: Abandoned Cart + Broadcasts
-- Run once on your DB
-- ═══════════════════════════════════════════

-- 1. Add recovery_sent_at to sessions
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS recovery_sent_at TIMESTAMP;

-- 2. Broadcasts table
CREATE TABLE IF NOT EXISTS broadcasts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title          VARCHAR(200) NOT NULL,
  message        TEXT NOT NULL,         -- supports {{name}}, {{order_count}}, {{last_order}}
  audience       VARCHAR(20) NOT NULL DEFAULT 'all',
    -- 'all' | 'recent' | 'inactive' | 'vip'
  scheduled_at   TIMESTAMP NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    -- 'scheduled' | 'sending' | 'sent' | 'failed'
  sent_at        TIMESTAMP,
  sent_count     INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  error          TEXT,
  repeat_type    VARCHAR(20) DEFAULT 'once',
    -- 'once' | 'daily' | 'weekly'
  repeat_day     INTEGER,               -- 0=Sun..6=Sat for weekly
  repeat_time    TIME,                  -- HH:MM for daily/weekly
  created_at     TIMESTAMP DEFAULT NOW()
);

-- 3. Opt-out table (customers who reply STOP)
CREATE TABLE IF NOT EXISTS opt_outs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone         VARCHAR(20) NOT NULL,
  opted_out_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(restaurant_id, phone)
);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_broadcasts_status_scheduled
  ON broadcasts(status, scheduled_at)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_opt_outs_restaurant_phone
  ON opt_outs(restaurant_id, phone);


