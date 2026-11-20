SET LOCAL search_path = dacm, pg_catalog;

CREATE TABLE account_session_previews (
  session_id_hash TEXT PRIMARY KEY REFERENCES account_sessions(id_hash) ON DELETE CASCADE,
  preview_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX account_session_previews_target ON account_session_previews(preview_user_id);

REVOKE ALL ON account_session_previews FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON account_session_previews TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120210000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
