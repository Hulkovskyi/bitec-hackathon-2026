SET LOCAL search_path = dacm, pg_catalog;

ALTER TABLE official_dataset_batches ADD COLUMN source_audit INTEGER NOT NULL DEFAULT 0
  CHECK(source_audit IN (0,1));

-- Imported history remains separate from auditable application activity.
CREATE TABLE official_audit_events (
  program_id TEXT NOT NULL,
  measure_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK(object_type IN ('measure','result','evidence')),
  object_code TEXT NOT NULL,
  field TEXT,
  before_value TEXT,
  after_value TEXT,
  PRIMARY KEY(program_id, source_id),
  FOREIGN KEY(measure_id, program_id) REFERENCES official_measure_metadata(measure_id, program_id) ON DELETE CASCADE
);
CREATE INDEX official_audit_measure_idx ON official_audit_events(measure_id, occurred_at, source_id);

REVOKE ALL ON official_audit_events FROM PUBLIC;
ALTER TABLE official_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY official_audit_runtime_read ON official_audit_events
  FOR SELECT TO dacm_runtime USING (true);
GRANT SELECT ON official_audit_events TO dacm_runtime;

INSERT INTO schema_migrations(version, applied_at)
VALUES ('20261120230005', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
