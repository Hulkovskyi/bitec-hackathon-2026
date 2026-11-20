SET LOCAL search_path = dacm, pg_catalog;

ALTER TABLE official_dataset_batches ADD COLUMN source_signals INTEGER NOT NULL DEFAULT 0
  CHECK(source_signals IN (0,1));

CREATE TABLE official_risk_metadata (
  risk_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES official_dataset_batches(program_id) ON DELETE CASCADE,
  owner_department_id TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  baseline DOUBLE PRECISION NOT NULL,
  baseline_on TEXT NOT NULL,
  target DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  likelihood INTEGER NOT NULL CHECK(likelihood BETWEEN 1 AND 4),
  impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 4),
  actual DOUBLE PRECISION,
  reading_on TEXT,
  CHECK((actual IS NULL) = (reading_on IS NULL)),
  FOREIGN KEY(risk_id, program_id) REFERENCES risks(id, program_id) ON DELETE CASCADE,
  FOREIGN KEY(owner_department_id, program_id) REFERENCES departments(id, program_id) ON DELETE CASCADE
);
CREATE INDEX official_risk_program_idx ON official_risk_metadata(program_id);
CREATE INDEX official_risk_owner_idx ON official_risk_metadata(owner_department_id, program_id);

ALTER TABLE official_measure_metadata ADD COLUMN source_risk_id TEXT
  REFERENCES official_risk_metadata(risk_id) ON DELETE SET NULL;
ALTER TABLE official_measure_metadata ADD COLUMN source_code TEXT;
ALTER TABLE official_measure_metadata ADD COLUMN source_department_code TEXT;
ALTER TABLE official_measure_metadata ADD COLUMN source_indicator_direction TEXT
  CHECK(source_indicator_direction IN ('increase','decrease','maintain'));
CREATE INDEX official_measure_risk_idx ON official_measure_metadata(source_risk_id);

REVOKE ALL ON official_risk_metadata FROM PUBLIC;
ALTER TABLE official_risk_metadata ENABLE ROW LEVEL SECURITY;
CREATE POLICY official_risk_metadata_backend ON official_risk_metadata FOR SELECT TO dacm_runtime USING (true);
GRANT SELECT ON official_risk_metadata TO dacm_runtime;

INSERT INTO schema_migrations(version, applied_at)
VALUES ('20261120230004', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
