-- ══════════════════════════════════════════════════════════
-- Migration: Intelligence layer tables
-- ══════════════════════════════════════════════════════════

-- Cost price on menu items for margin analysis
ALTER TABLE menu_items 
  ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2) DEFAULT 0;

-- Customer events for proactive messaging tracking
CREATE TABLE IF NOT EXISTS customer_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone  VARCHAR(20) NOT NULL,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  event_type      VARCHAR(50) NOT NULL,
  -- 'reengagement_sent' | 'upsell_shown' | 'upsell_accepted' | 'upsell_rejected'
  metadata        JSONB,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_events_phone ON customer_events(customer_phone, restaurant_id);
CREATE INDEX IF NOT EXISTS idx_customer_events_type  ON customer_events(event_type, created_at);

-- Prevent duplicate reengagement messages (one per 7 days per customer)
CREATE UNIQUE INDEX IF NOT EXISTS idx_reengagement_dedup
  ON customer_events(customer_phone, restaurant_id, event_type, DATE(created_at))
  WHERE event_type = 'reengagement_sent';

SELECT 'intelligence tables ready' AS status;

