-- ══════════════════════════════════════════════════════════
-- Migration: Delivery claim system + Multi-outlet support
-- ══════════════════════════════════════════════════════════

-- ── 1. Delivery assignments table ──
CREATE TABLE IF NOT EXISTS delivery_assignments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id),
  bill_number      VARCHAR(50) NOT NULL,
  customer_phone   VARCHAR(20) NOT NULL,
  delivery_address TEXT,
  delivery_lat     DECIMAL(10,7),
  delivery_lng     DECIMAL(10,7),
  cod_amount       DECIMAL(10,2) DEFAULT 0,

  -- Claim tracking
  status           VARCHAR(20) DEFAULT 'pending',
  -- pending | claimed | delivered | cancelled

  notified_phones  TEXT,       -- comma-separated, all boys who were notified
  claimed_by       VARCHAR(20),-- phone of boy who claimed it
  claimed_at       TIMESTAMP,
  delivered_at     TIMESTAMP,

  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_assignments_order     ON delivery_assignments(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_bill      ON delivery_assignments(bill_number);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_claimed   ON delivery_assignments(claimed_by);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_status    ON delivery_assignments(status);

-- ── 2. Orders table: track assigned delivery boy ──
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_boy      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMP;

-- ── 3. Bills table: delivery status ──
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS delivery_status   VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMP;

-- ── 4. Multi-outlet: parent-child restaurant relationship ──
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS parent_restaurant_id  UUID REFERENCES restaurants(id),
  ADD COLUMN IF NOT EXISTS outlet_name           VARCHAR(100),
  -- e.g. "Koregaon Park", "Viman Nagar"
  ADD COLUMN IF NOT EXISTS outlet_address        TEXT;

-- ── 5. All pending columns from previous migrations ──
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS open_time        TIME,
  ADD COLUMN IF NOT EXISTS close_time       TIME,
  ADD COLUMN IF NOT EXISTS delivery_phones  TEXT;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS delivery_lat     DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS delivery_lng     DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS platform         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pickup_token     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pickup_token_num INTEGER;

-- ── 6. Verify ──
SELECT 'delivery_assignments table' AS check,
       COUNT(*) AS rows FROM delivery_assignments;

SELECT 'restaurants new columns' AS check,
       column_name
FROM information_schema.columns
WHERE table_name = 'restaurants'
  AND column_name IN ('parent_restaurant_id','outlet_name','open_time','close_time','delivery_phones')
ORDER BY column_name;

