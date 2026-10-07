-- 007: add the Musical Instruments category
-- Safe to run more than once: it skips the row if the slug already exists.

BEGIN;

INSERT INTO categories (name, slug) VALUES
  ('Musical Instruments', 'musical-instruments')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
