-- ─────────────────────────────────────────────
-- MakeDate's Burger — Complete Menu Seed
-- PURE VEG restaurant
-- Run: sudo -u postgres psql -d restaurant_ai -f /tmp/makedate.sql
-- ─────────────────────────────────────────────

DO $$
DECLARE
  r_id        UUID;
  cat_halka   UUID;
  cat_sides   UUID;
  cat_hungry  UUID;
  cat_cheesy  UUID;
  cat_green   UUID;
  cat_spicy   UUID;
  cat_combos  UUID;
  cat_drinks  UUID;
  cat_addons  UUID;

BEGIN

  -- ── INSERT RESTAURANT ──
  INSERT INTO restaurants (
    name, slug, phone,
    gstin, fssai,
    restaurant_type, state_code, bill_prefix,
    zomato_discount, swiggy_discount,
    zomato_active, swiggy_active,
    delivery_active, delivery_radius_km, delivery_fee, min_order_delivery,
    bot_name, welcome_message,
    is_active
  ) VALUES (
    'MakeDate''s Burger',
    'makedates-burger',
    '',                         -- owner to fill
    '',                         -- owner to fill
    '',                         -- owner to fill
    'non_ac',
    'MH',
    'MDB',
    15,
    12,
    true,
    true,
    true, 5, 30, 100,
    'Buddy',
    'Hey! Welcome to MakeDate''s Burger 🍔 Taste Since 2014! I''m Buddy, your AI waiter. Everything here is 100% Pure Veg 🟢 What are you craving today?',
    true
  )
  RETURNING id INTO r_id;

  RAISE NOTICE 'Restaurant created: %', r_id;

  -- ── CATEGORIES ──
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'हल्का फुल्का 😊',  1) RETURNING id INTO cat_halka;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'Sides & Snacks',    2) RETURNING id INTO cat_sides;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'बहुत जोरो की भुख 💪', 3) RETURNING id INTO cat_hungry;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'मुझे तो Cheesy ही भाता है 🧀', 4) RETURNING id INTO cat_cheesy;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'हराभरा 🥗',         5) RETURNING id INTO cat_green;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'थोड़ा सा तीखा 🌶️',   6) RETURNING id INTO cat_spicy;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'MakeDate''s Combo 🎉', 7) RETURNING id INTO cat_combos;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'Drinks 🥤',          8) RETURNING id INTO cat_drinks;
  INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (r_id, 'Add-Ons',            9) RETURNING id INTO cat_addons;

  -- ── हल्का फुल्का (Light & Easy) ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_halka, 'Small Alu Tikki Burger', 'Crispy alu tikki patty with fresh veggies and sauce', 35, 'kitchen', 'food', true, 'mild', 'Indian', ARRAY['bestseller'], 1),
    (r_id, cat_halka, 'Big Alu Tikki Burger',   'Bigger, crispier alu tikki with our special sauce', 40, 'kitchen', 'food', true, 'mild', 'Indian', ARRAY['bestseller'], 2),
    (r_id, cat_halka, 'Cheese Burger',           'Classic veg burger with a generous cheese slice', 80, 'kitchen', 'food', true, 'none', 'American', ARRAY[]::TEXT[], 3),
    (r_id, cat_halka, 'Paneer Burger',           'Soft paneer patty with fresh lettuce and sauces', 80, 'kitchen', 'food', true, 'none', 'Indian', ARRAY[]::TEXT[], 4);

  -- ── Sides & Snacks ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_sides, 'Peri-Peri French Fries', 'Crispy fries tossed in zesty peri-peri seasoning', 80,  'kitchen', 'food', true, 'medium', 'American', ARRAY['bestseller'], 1),
    (r_id, cat_sides, 'Salted French Fries',    'Classic golden fries with a sprinkle of salt',     60,  'kitchen', 'food', true, 'none',   'American', ARRAY[]::TEXT[], 2),
    (r_id, cat_sides, 'Cheesy Fries',           'Golden fries loaded with melted cheese sauce',     100, 'kitchen', 'food', true, 'none',   'American', ARRAY['must_try'], 3),
    (r_id, cat_sides, 'Peri-Peri With Cheesy',  'Best of both worlds — peri-peri spice + cheese',  120, 'kitchen', 'food', true, 'medium', 'American', ARRAY['must_try'], 4),
    (r_id, cat_sides, 'Salted Nuggets (6 pcs)', 'Crispy veg nuggets, lightly salted',               70,  'kitchen', 'food', true, 'none',   'American', ARRAY[]::TEXT[], 5),
    (r_id, cat_sides, 'Peri-Peri Nuggets (6 pcs)', 'Veg nuggets with a peri-peri punch',            90,  'kitchen', 'food', true, 'medium', 'American', ARRAY['bestseller'], 6),
    (r_id, cat_sides, 'Cheesy Nuggets',         'Veg nuggets smothered in cheese sauce',            100, 'kitchen', 'food', true, 'none',   'American', ARRAY[]::TEXT[], 7),
    (r_id, cat_sides, 'Cheesy Chips',           'Thick-cut chips with a drizzle of cheese',        80,  'kitchen', 'food', true, 'none',   'American', ARRAY[]::TEXT[], 8);

  -- ── बहुत जोरो की भुख (Very Hungry) ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_hungry, 'Double Decker Burger',  'Two patties stacked high — for the truly hungry!', 90, 'kitchen', 'food', true, 'mild',   'American', ARRAY['must_try'], 1),
    (r_id, cat_hungry, 'Cheese Paneer Burger',  'Paneer patty with extra cheese — rich and filling', 90, 'kitchen', 'food', true, 'none',   'Indian',   ARRAY[]::TEXT[], 2),
    (r_id, cat_hungry, 'Russian Burger',        'Loaded burger with a creamy Russian-style sauce',   90, 'kitchen', 'food', true, 'none',   'Continental', ARRAY[]::TEXT[], 3);

  -- ── Cheesy ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_cheesy, 'Newyork Burger',    'NY-style loaded with triple cheese and veggies', 90, 'kitchen', 'food', true, 'none', 'American', ARRAY['chef_special'], 1),
    (r_id, cat_cheesy, 'Melbourne Burger',  'Aussie-inspired burger with tangy special sauce', 90, 'kitchen', 'food', true, 'none', 'Continental', ARRAY[]::TEXT[], 2);

  -- ── हराभरा (Fresh & Green) ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_green, 'Veg Burger',          'Simple, fresh veg burger — light and satisfying',        60, 'kitchen', 'food', true, 'none', 'American', ARRAY[]::TEXT[], 1),
    (r_id, cat_green, 'California Burger',   'Fresh veggies, lettuce, California-style dressing',      60, 'kitchen', 'food', true, 'none', 'American', ARRAY[]::TEXT[], 2),
    (r_id, cat_green, 'Jain Burger',         'No onion, no garlic — Jain-friendly burger',             60, 'kitchen', 'food', true, 'none', 'Indian',   ARRAY['jain_friendly'], 3),
    (r_id, cat_green, 'Jain Tikki Burger',   'Jain-friendly alu tikki burger, no onion no garlic',     70, 'kitchen', 'food', true, 'mild', 'Indian',   ARRAY['jain_friendly'], 4),
    (r_id, cat_green, 'Cheese Salad Burger', 'Light salad burger with a cheese slice',                 40, 'kitchen', 'food', true, 'none', 'American', ARRAY[]::TEXT[], 5);

  -- ── थोड़ा सा तीखा (Spicy) ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_spicy, 'Spicy Burger',        'Classic spicy veg burger with our fiery sauce',          60, 'kitchen', 'food', true, 'hot',    'American', ARRAY[]::TEXT[], 1),
    (r_id, cat_spicy, 'Spicy Veggie Burger', 'Loaded with veggies and extra spice kick',               60, 'kitchen', 'food', true, 'hot',    'American', ARRAY[]::TEXT[], 2),
    (r_id, cat_spicy, 'Mexican Burger',      'Mexican spices, jalapeños and chipotle sauce',           90, 'kitchen', 'food', true, 'hot',    'Mexican',  ARRAY['must_try'], 3),
    (r_id, cat_spicy, 'New Texas Burger',    'Texas-style bold flavours with smoky hot sauce',         90, 'kitchen', 'food', true, 'hot',    'American', ARRAY['chef_special'], 4),
    (r_id, cat_spicy, 'Spicy Paneer Burger', 'Crispy paneer patty with a spicy masala coating',        90, 'kitchen', 'food', true, 'hot',    'Indian',   ARRAY['bestseller'], 5);

  -- ── Combos ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_combos, 'Combo: Big Tikki + Cold Coffee',      'Big Alu Tikki Burger + Cold Coffee — great value!',       70,  'kitchen', 'food', true, 'mild', 'Indian', ARRAY['bestseller'], 1),
    (r_id, cat_combos, 'Combo: Big Tikki + Strawberry Shake', 'Big Alu Tikki Burger + Strawberry Shake',                100, 'kitchen', 'food', true, 'mild', 'Indian', ARRAY[]::TEXT[], 2),
    (r_id, cat_combos, 'Combo: Big Tikki + Chocolate Shake',  'Big Alu Tikki Burger + Chocolate Shake',                 100, 'kitchen', 'food', true, 'mild', 'Indian', ARRAY[]::TEXT[], 3);

  -- ── Drinks ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, cuisine_type, tags, sort_order)
  VALUES
    (r_id, cat_drinks, 'Cold Coffee',                 'Chilled cold coffee — refreshing and smooth',           50, 'bar', 'soft_drink', true, 'none', 'Beverages', ARRAY['bestseller'], 1),
    (r_id, cat_drinks, 'Cold Coffee with Ice-cream',  'Cold coffee topped with a scoop of vanilla ice-cream', 60, 'bar', 'soft_drink', true, 'none', 'Beverages', ARRAY['must_try'], 2),
    (r_id, cat_drinks, 'Cold Coffee with Brownie',    'Cold coffee paired with a rich chocolate brownie',      90, 'bar', 'soft_drink', true, 'none', 'Beverages', ARRAY['chef_special'], 3),
    (r_id, cat_drinks, 'Chocolate Shake',             'Thick and creamy chocolate milkshake',                  70, 'bar', 'soft_drink', true, 'none', 'Beverages', ARRAY['bestseller'], 4),
    (r_id, cat_drinks, 'Strawberry Shake',            'Smooth and fruity strawberry milkshake',                70, 'bar', 'soft_drink', true, 'none', 'Beverages', ARRAY[]::TEXT[], 5);

  -- ── Add-Ons ──
  INSERT INTO menu_items (restaurant_id, category_id, name, description, price, kot_type, tax_category, is_veg, spice_level, sort_order)
  VALUES
    (r_id, cat_addons, 'Add-On: Cheese Slice',        'Extra cheese slice on any burger',       15, 'kitchen', 'food', true, 'none', 1),
    (r_id, cat_addons, 'Add-On: Medium Mexican Spicy','Extra Mexican spicy sauce on any item',  10, 'kitchen', 'food', true, 'hot',  2);

  -- ── Blocked items (pure veg restaurant) ──
  INSERT INTO blocked_items (restaurant_id, item_name)
  VALUES
    (r_id, 'chicken'),
    (r_id, 'mutton'),
    (r_id, 'beef'),
    (r_id, 'pork'),
    (r_id, 'egg'),
    (r_id, 'fish'),
    (r_id, 'meat'),
    (r_id, 'alcohol'),
    (r_id, 'beer'),
    (r_id, 'wine'),
    (r_id, 'non veg');

  RAISE NOTICE '✅ MakeDates Burger seeded successfully! Restaurant ID: %', r_id;
  RAISE NOTICE 'Total items: 37 | Pure Veg | Slug: makedates-burger';

END $$;

-- ── Verify ──
SELECT
  r.name as restaurant,
  c.name as category,
  COUNT(m.id) as items
FROM restaurants r
JOIN menu_categories c ON c.restaurant_id = r.id
JOIN menu_items m ON m.category_id = c.id
WHERE r.slug = 'makedates-burger'
GROUP BY r.name, c.name, c.sort_order
ORDER BY c.sort_order;

