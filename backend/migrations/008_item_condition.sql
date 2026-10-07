-- 008: item condition on listings (new / used / repaired).
-- Existing listings stay NULL (condition unknown) so nothing is guessed.
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_condition VARCHAR(20);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_item_condition_check;
ALTER TABLE products ADD CONSTRAINT products_item_condition_check
  CHECK (item_condition IS NULL OR item_condition IN ('new', 'used', 'repaired'));
