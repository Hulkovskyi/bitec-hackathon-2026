SET LOCAL search_path = dacm, pg_catalog;

GRANT UPDATE (display_name) ON users TO dacm_runtime;
GRANT DELETE ON account_roles TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120220001', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
