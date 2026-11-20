CREATE TABLE account_session_previews (
  session_id_hash TEXT PRIMARY KEY NOT NULL REFERENCES account_sessions(id_hash) ON DELETE CASCADE,
  preview_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX account_session_previews_target ON account_session_previews(preview_user_id);
