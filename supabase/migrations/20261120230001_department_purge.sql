SET LOCAL search_path TO pg_catalog, dacm;

GRANT DELETE ON dacm.risk_measurements TO dacm_runtime;

INSERT INTO dacm.schema_migrations (version, applied_at)
VALUES ('20261120230001', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
