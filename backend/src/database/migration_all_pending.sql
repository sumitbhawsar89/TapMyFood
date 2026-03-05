-- ══════════════════════════════════════════════════════
-- Run this ONCE — adds all missing columns safely
-- ══════════════════════════════════════════════════════

-- Opening hours
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS open_time        TIME,
  ADD COLUMN IF NOT EXISTS close_time       TIME,

-- Delivery team per restaurant (comma-separated WhatsApp numbers)
  ADD COLUMN IF NOT EXISTS delivery_phones  TEXT;

-- Delivery location coordinates
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS delivery_lat     DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS delivery_lng     DECIMAL(10,7);

-- Verify all added
SELECT column_name FROM information_schema.columns
WHERE table_name = 'restaurants'
  AND column_name IN ('open_time','close_time','delivery_phones')
ORDER BY column_name;
