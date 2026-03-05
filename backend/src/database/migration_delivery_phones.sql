-- Add delivery_phones column to restaurants table
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS delivery_phones TEXT;
-- TEXT allows comma-separated numbers: '919876543210,919876543211'

-- Example: set delivery person for MakeDate's Burger
-- UPDATE restaurants 
-- SET delivery_phones = '919876543210'
-- WHERE slug = 'makedates-burger';

SELECT name, delivery_phones FROM restaurants;
