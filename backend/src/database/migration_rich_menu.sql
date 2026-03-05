-- ─────────────────────────────────────────────
-- MIGRATION: Add rich menu item fields
-- Run this on your existing restaurant_ai DB
-- ─────────────────────────────────────────────

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS spice_level    VARCHAR(10) DEFAULT 'none',
  -- none | mild | medium | hot | extra_hot

  ADD COLUMN IF NOT EXISTS cuisine_type   VARCHAR(50),
  -- "Indian", "Continental", "Chinese", "Italian", "American" etc

  ADD COLUMN IF NOT EXISTS allergens      TEXT[],
  -- ARRAY['gluten', 'dairy', 'nuts', 'egg', 'soy']

  ADD COLUMN IF NOT EXISTS calories       INTEGER,
  -- approx kcal

  ADD COLUMN IF NOT EXISTS tags           TEXT[];
  -- ARRAY['bestseller', 'new', 'chef_special', 'must_try', 'healthy']

-- ─────────────────────────────────────────────
-- Update Burger Barn items with rich data
-- ─────────────────────────────────────────────
UPDATE menu_items SET
  spice_level  = 'none',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten', 'dairy'],
  calories     = 520,
  tags         = ARRAY['bestseller']
WHERE name = 'Classic Smash Burger';

UPDATE menu_items SET
  spice_level  = 'medium',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten', 'dairy'],
  calories     = 620,
  tags         = ARRAY['bestseller', 'must_try']
WHERE name = 'BBQ Bacon Burger';

UPDATE menu_items SET
  spice_level  = 'medium',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten', 'dairy', 'egg'],
  calories     = 580,
  tags         = ARRAY['chef_special']
WHERE name = 'Crispy Chicken Burger';

UPDATE menu_items SET
  spice_level  = 'hot',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten', 'dairy'],
  calories     = 490,
  tags         = ARRAY['must_try']
WHERE name = 'Veg Chilli Cheese Burger';

UPDATE menu_items SET
  spice_level  = 'none',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten', 'dairy', 'egg'],
  calories     = 780,
  tags         = ARRAY['new', 'must_try']
WHERE name = 'Double Trouble';

UPDATE menu_items SET
  spice_level  = 'medium',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten', 'dairy'],
  calories     = 340,
  tags         = ARRAY['bestseller']
WHERE name = 'Loaded Fries';

UPDATE menu_items SET
  spice_level  = 'none',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten'],
  calories     = 280,
  tags         = ARRAY[]::TEXT[]
WHERE name = 'Onion Rings';

UPDATE menu_items SET
  spice_level  = 'medium',
  cuisine_type = 'American',
  allergens    = ARRAY['gluten'],
  calories     = 420,
  tags         = ARRAY['bestseller']
WHERE name = 'Chicken Wings (6pc)';

UPDATE menu_items SET
  spice_level  = 'none',
  allergens    = ARRAY['dairy'],
  calories     = 380,
  tags         = ARRAY['must_try']
WHERE name = 'Chocolate Milkshake';

-- Verify
SELECT name, spice_level, cuisine_type, allergens, tags
FROM menu_items
ORDER BY kot_type, name;

