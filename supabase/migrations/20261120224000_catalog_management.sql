GRANT UPDATE (code, title, period_start, period_end) ON dacm.programs TO dacm_runtime;
GRANT UPDATE (code, title) ON dacm.risks TO dacm_runtime;
GRANT DELETE ON dacm.programs, dacm.risks TO dacm_runtime;
GRANT DELETE ON dacm.sections, dacm.program_passports, dacm.risk_indicators TO dacm_runtime;

INSERT INTO dacm.schema_migrations (version, applied_at)
VALUES ('20261120224000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
