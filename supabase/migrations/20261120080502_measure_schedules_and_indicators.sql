SET LOCAL search_path = dacm, pg_catalog;

ALTER TABLE measures ADD COLUMN recurrence TEXT
  CHECK (recurrence IS NULL OR (schedule_type = 'continuous'
    AND recurrence IN ('weekly', 'monthly', 'quarterly', 'annual_april_may')));

ALTER TABLE indicators
  ALTER COLUMN unit DROP NOT NULL,
  ALTER COLUMN baseline DROP NOT NULL,
  ALTER COLUMN target DROP NOT NULL,
  ALTER COLUMN direction DROP NOT NULL;
