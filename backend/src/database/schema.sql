-- ============================================
-- AI RESTAURANT PLATFORM — DATABASE SCHEMA
-- Run this once on your PostgreSQL instance
-- ============================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- 1. RESTAURANTS
-- ─────────────────────────────────────────────
CREATE TABLE restaurants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(100) UNIQUE NOT NULL,  -- used in QR URL e.g. "burger-barn"
  phone           VARCHAR(20),
  address         TEXT,
  gstin           VARCHAR(15),
  fssai           VARCHAR(20),

  -- Type affects GST rate
  restaurant_type VARCHAR(30) DEFAULT 'non_ac',
  -- non_ac | ac_without_liquor | ac_with_liquor

  state_code      VARCHAR(5) DEFAULT 'MH',       -- for alcohol VAT
  bill_prefix     VARCHAR(10) DEFAULT 'REST',     -- bill number prefix
  bill_sequence   INTEGER DEFAULT 0,             -- auto-increments

  -- Discount settings (owner configures)
  zomato_discount  INTEGER DEFAULT 15,           -- % discount for Zomato dine-in
  swiggy_discount  INTEGER DEFAULT 12,           -- % discount for Swiggy dine-in
  zomato_active    BOOLEAN DEFAULT true,
  swiggy_active    BOOLEAN DEFAULT true,

  -- Delivery settings
  delivery_radius_km  INTEGER DEFAULT 5,
  delivery_fee        INTEGER DEFAULT 50,        -- in rupees
  delivery_active     BOOLEAN DEFAULT true,
  min_order_delivery  INTEGER DEFAULT 200,       -- min order for delivery

  -- Bot personality
  bot_name        VARCHAR(100) DEFAULT 'your AI waiter',
  welcome_message TEXT DEFAULT 'Welcome! I am your AI waiter. How can I help you today?',

  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 2. MENU CATEGORIES
-- ─────────────────────────────────────────────
CREATE TABLE menu_categories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,   -- "Starters", "Mains", "Bar", "Desserts"
  sort_order      INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT true
);

-- ─────────────────────────────────────────────
-- 3. MENU ITEMS
-- ─────────────────────────────────────────────
CREATE TABLE menu_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id     UUID REFERENCES menu_categories(id),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  price           INTEGER NOT NULL,        -- in paise (₹150 = 15000) OR just rupees — your choice
  -- NOTE: We store in RUPEES (INTEGER) for simplicity

  -- KOT routing
  kot_type        VARCHAR(10) NOT NULL DEFAULT 'kitchen',
  -- kitchen | bar

  -- Tax
  tax_category    VARCHAR(20) DEFAULT 'food',
  -- food | soft_drink | alcohol | packaged_water

  -- Dietary
  is_veg          BOOLEAN DEFAULT true,
  is_available    BOOLEAN DEFAULT true,

  image_url       TEXT,
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 4. BLOCKED ITEMS (per restaurant)
-- ─────────────────────────────────────────────
CREATE TABLE blocked_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_name       VARCHAR(100) NOT NULL    -- "beef", "pork", "alcohol" etc
);

-- ─────────────────────────────────────────────
-- 5. SESSIONS (one per customer visit)
-- ─────────────────────────────────────────────
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  customer_phone  VARCHAR(20) NOT NULL,
  customer_name   VARCHAR(100),

  -- Order context
  table_number    VARCHAR(20),             -- "4", "T-12", null for delivery
  mode            VARCHAR(20) NOT NULL,
  -- zomato_dine | swiggy_dine | direct_dine | takeaway | delivery

  discount_pct    INTEGER DEFAULT 0,      -- discount applied (from popup)
  discount_source VARCHAR(20),            -- 'zomato' | 'swiggy' | null

  -- Delivery address (if mode = delivery)
  delivery_address TEXT,
  delivery_lat    DECIMAL(10, 8),
  delivery_lng    DECIMAL(11, 8),

  -- Conversation history stored as JSONB
  -- Format: [{role: 'user'|'assistant', content: '...'}]
  chat_history    JSONB DEFAULT '[]',

  status          VARCHAR(20) DEFAULT 'active',
  -- active | ordered | paid | closed

  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 6. ORDERS
-- ─────────────────────────────────────────────
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),

  status          VARCHAR(20) DEFAULT 'pending',
  -- pending | confirmed | preparing | ready | out_for_delivery | completed | cancelled

  special_notes   TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 7. ORDER ITEMS
-- ─────────────────────────────────────────────
CREATE TABLE order_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id),

  name            VARCHAR(255) NOT NULL,   -- snapshot at time of order
  price           INTEGER NOT NULL,        -- snapshot at time of order
  quantity        INTEGER NOT NULL DEFAULT 1,
  subtotal        INTEGER NOT NULL,        -- price * quantity

  kot_type        VARCHAR(10) NOT NULL,    -- kitchen | bar
  tax_category    VARCHAR(20) NOT NULL,
  notes           TEXT                     -- "extra spicy", "no onions" etc
);

-- ─────────────────────────────────────────────
-- 8. KOTs (Kitchen Order Tickets)
-- ─────────────────────────────────────────────
CREATE TABLE kots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),

  kot_type        VARCHAR(10) NOT NULL,    -- kitchen | bar
  items           JSONB NOT NULL,          -- snapshot of items for this KOT
  table_number    VARCHAR(20),

  printed_at      TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 9. BILLS
-- ─────────────────────────────────────────────
CREATE TABLE bills (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),

  bill_number     VARCHAR(30) UNIQUE,      -- LT-2425-00842

  -- Amounts (all in rupees)
  food_subtotal   INTEGER DEFAULT 0,
  bar_subtotal    INTEGER DEFAULT 0,
  soft_drink_subtotal INTEGER DEFAULT 0,
  subtotal        INTEGER NOT NULL,

  -- Tax
  cgst            INTEGER DEFAULT 0,
  sgst            INTEGER DEFAULT 0,
  vat             INTEGER DEFAULT 0,       -- alcohol state VAT
  total_tax       INTEGER DEFAULT 0,

  -- Discount
  discount_pct    INTEGER DEFAULT 0,
  discount_amount INTEGER DEFAULT 0,

  grand_total     INTEGER NOT NULL,

  -- Payment
  status          VARCHAR(20) DEFAULT 'unpaid',
  -- unpaid | paid | refunded

  razorpay_order_id   VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  payment_method      VARCHAR(30),         -- upi | card | cash

  paid_at         TIMESTAMP,
  receipt_url     TEXT,                    -- S3 URL of PDF receipt

  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 10. CART (temporary, per session)
-- ─────────────────────────────────────────────
CREATE TABLE cart_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id),

  name            VARCHAR(255) NOT NULL,
  price           INTEGER NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  kot_type        VARCHAR(10) NOT NULL,
  tax_category    VARCHAR(20) NOT NULL,
  notes           TEXT,

  added_at        TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES for performance
-- ─────────────────────────────────────────────
CREATE INDEX idx_sessions_phone      ON sessions(customer_phone);
CREATE INDEX idx_sessions_restaurant ON sessions(restaurant_id);
CREATE INDEX idx_orders_session      ON orders(session_id);
CREATE INDEX idx_order_items_order   ON order_items(order_id);
CREATE INDEX idx_cart_session        ON cart_items(session_id);
CREATE INDEX idx_menu_restaurant     ON menu_items(restaurant_id);
CREATE INDEX idx_kots_order          ON kots(order_id);

-- ─────────────────────────────────────────────
-- SEED DATA — Burger Shop (your test restaurant)
-- ─────────────────────────────────────────────
INSERT INTO restaurants (
  id, name, slug, phone, gstin, fssai,
  restaurant_type, state_code, bill_prefix,
  zomato_discount, swiggy_discount,
  bot_name, welcome_message
) VALUES (
  uuid_generate_v4(),
  'Burger Barn',
  'burger-barn',
  '+919876543210',
  '27AABCU9603R1ZX',
  '10012345678901',
  'non_ac',
  'MH',
  'BB',
  15,
  12,
  'Benny',
  'Hey! Welcome to Burger Barn 🍔 I am Benny, your AI waiter. What are you in the mood for today?'
);

-- Get the restaurant ID for seeding menu
DO $$
DECLARE
  r_id UUID;
  cat_burgers UUID;
  cat_sides UUID;
  cat_drinks UUID;
BEGIN
  SELECT id INTO r_id FROM restaurants WHERE slug = 'burger-barn';

  -- Categories
  INSERT INTO menu_categories (id, restaurant_id, name, sort_order)
  VALUES
    (uuid_generate_v4(), r_id, 'Burgers', 1),
    (uuid_generate_v4(), r_id, 'Sides', 2),
    (uuid_generate_v4(), r_id, 'Drinks', 3);

  SELECT id INTO cat_burgers FROM menu_categories WHERE restaurant_id = r_id AND name = 'Burgers';
  SELECT id INTO cat_sides   FROM menu_categories WHERE restaurant_id = r_id AND name = 'Sides';
  SELECT id INTO cat_drinks  FROM menu_categories WHERE restaurant_id = r_id AND name = 'Drinks';

  -- Burgers
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg)
  VALUES
    (r_id, cat_burgers, 'Classic Smash Burger', 'Double smash patty, cheddar, pickles, special sauce', 199, 'kitchen', 'food', false),
    (r_id, cat_burgers, 'BBQ Bacon Burger', 'Crispy bacon, BBQ sauce, caramelised onions, jalapenos', 249, 'kitchen', 'food', false),
    (r_id, cat_burgers, 'Crispy Chicken Burger', 'Fried chicken thigh, coleslaw, sriracha mayo', 219, 'kitchen', 'food', false),
    (r_id, cat_burgers, 'Veg Chilli Cheese Burger', 'Veg patty, chilli sauce, cheese slice, lettuce', 179, 'kitchen', 'food', true),
    (r_id, cat_burgers, 'Double Trouble', 'Two smash patties, double cheese, bacon, fried egg', 299, 'kitchen', 'food', false);

  -- Sides
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg)
  VALUES
    (r_id, cat_sides, 'Loaded Fries', 'Crispy fries, cheese sauce, jalapenos', 129, 'kitchen', 'food', true),
    (r_id, cat_sides, 'Onion Rings', 'Beer-battered onion rings, dipping sauce', 99, 'kitchen', 'food', true),
    (r_id, cat_sides, 'Chicken Wings (6pc)', 'Buffalo or BBQ, ranch dip', 199, 'kitchen', 'food', false);

  -- Drinks
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg)
  VALUES
    (r_id, cat_drinks, 'Coke', 'Chilled Coca-Cola 330ml', 60, 'bar', 'soft_drink', true),
    (r_id, cat_drinks, 'Fresh Lime Soda', 'Sweet or salted', 79, 'bar', 'soft_drink', true),
    (r_id, cat_drinks, 'Chocolate Milkshake', 'Thick, creamy, homemade', 149, 'bar', 'food', true),
    (r_id, cat_drinks, 'Mineral Water', 'Bisleri 500ml', 30, 'bar', 'packaged_water', true);

  -- Blocked items
  INSERT INTO blocked_items (restaurant_id, item_name)
  VALUES
    (r_id, 'beef'),
    (r_id, 'pork'),
    (r_id, 'alcohol'),
    (r_id, 'beer'),
    (r_id, 'wine'),
    (r_id, 'whiskey');

  RAISE NOTICE 'Burger Barn seeded successfully with ID: %', r_id;
END $$;

-- Verify
SELECT name, slug, zomato_discount, swiggy_discount FROM restaurants;
SELECT name, price, kot_type, tax_category FROM menu_items ORDER BY kot_type, tax_category;

