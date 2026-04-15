-- ============================================================
-- OrderBuddy / TapMyFood — Complete DB Migration v11
-- Run on: restaurant_ai (PostgreSQL) — Server: 34.229.159.51
-- March 2026
--
-- ALREADY DONE (do not re-run):
--   Step 1: orders table columns (otp, payment, token, refund)
--   Step 2: sessions table columns (initiated_by, staff, rider)
--   Step 3: refunds + staff_sessions tables
--
-- THIS FILE: Steps 4 onwards — run all at once
-- If any step fails, share the error — each step is labelled
-- ============================================================

-- ============================================================
-- STEP 4A: complaints table
-- ============================================================

CREATE TABLE IF NOT EXISTS complaints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      UUID REFERENCES restaurants(id),
  complaint_ref      VARCHAR(20) NOT NULL,
  order_id           UUID REFERENCES orders(id),
  customer_phone     VARCHAR(20),
  customer_name      VARCHAR(100) NULL,
  complaint_type     VARCHAR(30) NOT NULL,
  -- WRONG_ITEM | NOT_DELIVERED | FOOD_QUALITY | LATE_DELIVERY
  -- PACKAGING | OVERCHARGED | HYGIENE | OTHER
  description        TEXT NOT NULL,
  photo_urls         TEXT[] DEFAULT '{}',
  status             VARCHAR(20) DEFAULT 'open',
  -- open | in_progress | resolved | overdue | rejected
  owner_response     TEXT NULL,
  resolution_type    VARCHAR(30) NULL,
  -- full_refund | partial_refund | replacement | discount | acknowledge | rejected
  refund_id          UUID NULL REFERENCES refunds(id),
  resolved_at        TIMESTAMP NULL,
  reminder_sent_at   TIMESTAMP NULL,
  created_at         TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- STEP 4B: bookings table
-- ============================================================

CREATE TABLE IF NOT EXISTS bookings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      UUID REFERENCES restaurants(id),
  booking_ref        VARCHAR(20) NOT NULL,
  customer_name      VARCHAR(100) NOT NULL,
  customer_phone     VARCHAR(20) NOT NULL,
  booking_date       DATE NOT NULL,
  booking_time       TIME NOT NULL,
  covers             INT NOT NULL DEFAULT 1,
  special_request    TEXT NULL,
  status             VARCHAR(20) DEFAULT 'confirmed',
  -- confirmed | arrived | completed | cancelled | no_show
  session_id         UUID NULL REFERENCES sessions(id),
  reminder_sent      BOOLEAN DEFAULT false,
  cancelled_by       VARCHAR(20) NULL,
  -- customer | owner
  cancel_reason      TEXT NULL,
  created_at         TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- STEP 4C: restaurant_slots table (for table booking config)
-- ============================================================

CREATE TABLE IF NOT EXISTS restaurant_slots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         UUID REFERENCES restaurants(id),
  day_of_week           INT NOT NULL,
  -- 0=Sunday, 1=Monday ... 6=Saturday
  open_time             TIME NOT NULL,
  close_time            TIME NOT NULL,
  slot_duration_mins    INT DEFAULT 60,
  buffer_mins           INT DEFAULT 15,
  max_covers_per_slot   INT DEFAULT 20,
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMP DEFAULT NOW(),
  UNIQUE(restaurant_id, day_of_week)
);

-- ============================================================
-- STEP 5A: raw_materials table (inventory)
-- ============================================================

CREATE TABLE IF NOT EXISTS raw_materials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         UUID REFERENCES restaurants(id),
  name                  VARCHAR(100) NOT NULL,
  category              VARCHAR(50) NULL,
  -- Produce | Dairy | Meat | Dry Goods | Beverages | Packaging
  unit                  VARCHAR(20) NOT NULL,
  -- kg | g | litre | ml | pcs
  current_stock         DECIMAL(10,3) DEFAULT 0,
  low_stock_threshold   DECIMAL(10,3) DEFAULT 0,
  reorder_quantity      DECIMAL(10,3) DEFAULT 0,
  cost_per_unit         DECIMAL(10,2) DEFAULT 0,
  material_type         VARCHAR(20) DEFAULT 'fresh',
  -- fresh | packed | bottled | dry | frozen
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- STEP 5B: recipes table (maps menu items to raw materials)
-- ============================================================

CREATE TABLE IF NOT EXISTS recipes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id          UUID REFERENCES menu_items(id),
  raw_material_id       UUID REFERENCES raw_materials(id),
  quantity              DECIMAL(10,3) NOT NULL,
  -- quantity of raw material per ONE portion
  unit                  VARCHAR(20) NOT NULL,
  tracking_type         VARCHAR(20) DEFAULT 'precise',
  -- precise | bulk | ignore
  status                VARCHAR(20) DEFAULT 'pending',
  -- unmapped | pending | approved | skipped
  ai_generated          BOOLEAN DEFAULT false,
  created_at            TIMESTAMP DEFAULT NOW(),
  UNIQUE(menu_item_id, raw_material_id)
);

-- ============================================================
-- STEP 5C: stock_transactions table (every stock movement)
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_material_id       UUID REFERENCES raw_materials(id),
  restaurant_id         UUID REFERENCES restaurants(id),
  type                  VARCHAR(20) NOT NULL,
  -- deduct | return | purchase | wastage | adjustment
  quantity              DECIMAL(10,3) NOT NULL,
  stock_before          DECIMAL(10,3) NULL,
  stock_after           DECIMAL(10,3) NULL,
  reference_id          UUID NULL,
  -- order_id or refund_id or purchase_order_id
  reason                VARCHAR(50) NULL,
  -- order | refund_return | manual | wastage | opening_stock
  notes                 TEXT NULL,
  created_by            UUID NULL REFERENCES staff(id),
  created_at            TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- STEP 5D: low_stock_alerts table (dedup alert tracking)
-- ============================================================

CREATE TABLE IF NOT EXISTS low_stock_alerts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_material_id       UUID REFERENCES raw_materials(id),
  restaurant_id         UUID REFERENCES restaurants(id),
  alerted_at            TIMESTAMP DEFAULT NOW(),
  -- used to prevent duplicate alerts within 2 hours
  UNIQUE(raw_material_id, DATE(alerted_at))
);

-- ============================================================
-- STEP 6: Indexes for performance
-- ============================================================

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_restaurant_status
  ON sessions(restaurant_id, status);

CREATE INDEX IF NOT EXISTS idx_sessions_customer_phone
  ON sessions(customer_phone, status);

CREATE INDEX IF NOT EXISTS idx_sessions_staff_id
  ON sessions(staff_id) WHERE staff_id IS NOT NULL;

-- Orders
CREATE INDEX IF NOT EXISTS idx_orders_session_id
  ON orders(session_id);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_created
  ON orders(restaurant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_token
  ON orders(restaurant_id, token_number) WHERE token_number IS NOT NULL;

-- Complaints
CREATE INDEX IF NOT EXISTS idx_complaints_restaurant_status
  ON complaints(restaurant_id, status);

CREATE INDEX IF NOT EXISTS idx_complaints_order_id
  ON complaints(order_id);

-- Bookings
CREATE INDEX IF NOT EXISTS idx_bookings_restaurant_date
  ON bookings(restaurant_id, booking_date);

CREATE INDEX IF NOT EXISTS idx_bookings_phone
  ON bookings(customer_phone, booking_date);

-- Inventory
CREATE INDEX IF NOT EXISTS idx_raw_materials_restaurant
  ON raw_materials(restaurant_id, is_active);

CREATE INDEX IF NOT EXISTS idx_recipes_menu_item
  ON recipes(menu_item_id, status);

CREATE INDEX IF NOT EXISTS idx_stock_transactions_material
  ON stock_transactions(raw_material_id, created_at);

-- Staff sessions
CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff
  ON staff_sessions(staff_id, is_active);

-- ============================================================
-- STEP 7: Verification — check all tables exist
-- ============================================================

SELECT
  table_name,
  'EXISTS' AS status
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'orders', 'sessions', 'refunds', 'staff_sessions',
    'complaints', 'bookings', 'restaurant_slots',
    'raw_materials', 'recipes', 'stock_transactions',
    'low_stock_alerts'
  )
ORDER BY table_name;

-- ============================================================
-- STEP 8: Verify new columns on orders table
-- ============================================================

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'orders'
  AND column_name IN (
    'delivery_otp', 'otp_generated_at', 'otp_verified_at',
    'otp_attempts', 'otp_locked', 'payment_mode_selected',
    'payment_method_actual', 'cod_amount', 'token_number',
    'refund_status', 'refunded_amount'
  )
ORDER BY column_name;

-- ============================================================
-- STEP 9: Verify new columns on sessions table
-- ============================================================

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'sessions'
  AND column_name IN (
    'initiated_by', 'staff_id', 'started_by_staff_name',
    'rider_phone', 'rider_accepted_at', 'rider_arrived_at',
    'delivered_at'
  )
ORDER BY column_name;

-- ============================================================
-- ALL DONE
-- Expected output:
--   Steps 4-5: CREATE TABLE (x7)
--   Step 6:    CREATE INDEX (x11)
--   Step 7:    11 rows showing all tables as EXISTS
--   Steps 8-9: columns listed correctly
-- ============================================================
