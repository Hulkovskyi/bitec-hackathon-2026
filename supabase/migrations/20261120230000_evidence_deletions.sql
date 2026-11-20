CREATE TABLE dacm.evidence_deletions (
  storage_key TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

REVOKE ALL ON dacm.evidence_deletions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON dacm.evidence_deletions TO dacm_runtime;
GRANT UPDATE (attempts) ON dacm.evidence_deletions TO dacm_runtime;

INSERT INTO dacm.schema_migrations (version, applied_at)
VALUES ('20261120230000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
