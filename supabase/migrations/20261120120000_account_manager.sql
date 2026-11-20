SET LOCAL search_path = dacm, pg_catalog;

ALTER TABLE credential_accounts ADD COLUMN manager_id TEXT
  REFERENCES credential_accounts(user_id) ON DELETE RESTRICT
  CHECK(manager_id IS NULL OR manager_id<>user_id);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120120000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
