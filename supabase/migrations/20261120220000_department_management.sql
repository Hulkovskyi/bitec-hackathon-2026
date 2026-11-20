SET LOCAL search_path = dacm, pg_catalog;

GRANT UPDATE (code, title) ON departments TO dacm_runtime;
GRANT DELETE ON departments TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120220000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
