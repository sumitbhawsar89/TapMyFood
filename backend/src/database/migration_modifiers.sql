-- ════════════════════════════════════════════════
-- Menu Modifiers Migration
-- Modifiers = paid add-ons (Cheese Slice ₹15 etc)
-- Linked to categories (all burgers) or specific items
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS menu_modifiers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id        UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name                 VARCHAR(100) NOT NULL,          -- "Cheese Slice"
  price                INTEGER NOT NULL DEFAULT 0,     -- 15 (in rupees)
  applicable_categories TEXT[] DEFAULT '{}',           -- ["burger","pizza"]
  applicable_item_ids  UUID[] DEFAULT '{}',            -- specific items (empty = all in category)
  is_active            BOOLEAN DEFAULT true,
  sort_order           INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by restaurant
CREATE INDEX IF NOT EXISTS idx_modifiers_restaurant 
  ON menu_modifiers(restaurant_id) WHERE is_active = true;

-- Add modifiers column to cart_items and order_items to track selected modifiers
ALTER TABLE cart_items 
  ADD COLUMN IF NOT EXISTS modifiers JSONB DEFAULT '[]';
  -- Format: [{"id":"uuid","name":"Cheese Slice","price":15}]

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS modifiers JSONB DEFAULT '[]';

-- Update subtotal calculation to include modifiers in billing
-- (handled in application code, not DB trigger)

-- ── Sample modifiers for burger restaurant (optional seed) ──
-- INSERT INTO menu_modifiers (restaurant_id, name, price, applicable_categories)
-- VALUES 
--   ('YOUR_RESTAURANT_ID', 'Cheese Slice',  15, ARRAY['burger','pizza']),
--   ('YOUR_RESTAURANT_ID', 'Extra Patty',   40, ARRAY['burger']),
--   ('YOUR_RESTAURANT_ID', 'Jalapenos',     10, ARRAY['burger']),
--   ('YOUR_RESTAURANT_ID', 'Extra Sauce',    5, ARRAY['burger','fries']),
--   ('YOUR_RESTAURANT_ID', 'Cheese Dip',    20, ARRAY['fries','snack']);
