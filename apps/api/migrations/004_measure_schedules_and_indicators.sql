ALTER TABLE measures ADD COLUMN recurrence TEXT
  CHECK (recurrence IS NULL OR (schedule_type = 'continuous'
    AND recurrence IN ('weekly', 'monthly', 'quarterly', 'annual_april_may')));

-- Imported qualitative indicators may have no numeric definition.
CREATE TABLE indicators_with_optional_values (
  id TEXT PRIMARY KEY,
  measure_id TEXT NOT NULL UNIQUE REFERENCES measures(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  unit TEXT,
  baseline REAL,
  target REAL,
  direction TEXT CHECK (direction IN ('increase','decrease','maintain')),
  CHECK ((direction='increase' AND target>=baseline)
    OR (direction='decrease' AND target<=baseline)
    OR (direction='maintain' AND target=baseline))
);
INSERT INTO indicators_with_optional_values (id, measure_id, title, unit, baseline, target, direction)
SELECT id, measure_id, title, unit, baseline, target, direction FROM indicators;
DROP TABLE indicators;
ALTER TABLE indicators_with_optional_values RENAME TO indicators;
