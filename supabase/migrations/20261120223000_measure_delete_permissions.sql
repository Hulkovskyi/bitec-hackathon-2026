SET LOCAL search_path = dacm, pg_catalog;

GRANT DELETE ON measures, indicators TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120223000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
