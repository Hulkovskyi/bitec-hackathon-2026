SET LOCAL search_path = dacm, pg_catalog;

GRANT DELETE ON results, result_reviews, evidence_versions, period_assignments, audit_events,
  official_dataset_batches, official_measure_results, official_evidence_claims,
  official_deadline_changes, official_measure_metadata TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120230002', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
