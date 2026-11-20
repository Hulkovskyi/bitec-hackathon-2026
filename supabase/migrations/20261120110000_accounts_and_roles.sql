SET LOCAL search_path = dacm, pg_catalog;

CREATE TABLE account_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  base_role TEXT NOT NULL CHECK(base_role IN ('executor','coordinator','leader','analyst','admin')),
  system INTEGER NOT NULL CHECK(system IN (0,1)),
  permissions_json TEXT,
  CHECK(base_role <> 'admin' OR (id='admin' AND system=1 AND permissions_json IS NULL))
);

INSERT INTO account_roles (id, name, name_key, base_role, system) VALUES
  ('executor', 'Виконавець', 'виконавець', 'executor', 1),
  ('coordinator', 'Координатор', 'координатор', 'coordinator', 1),
  ('leader', 'Керівник', 'керівник', 'leader', 1),
  ('analyst', 'Аналітик', 'аналітик', 'analyst', 1),
  ('admin', 'Адміністратор', 'адміністратор', 'admin', 1);

CREATE TABLE credential_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  department TEXT NOT NULL,
  position TEXT NOT NULL,
  role_id TEXT REFERENCES account_roles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected')),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  decision_reason TEXT,
  CHECK((status='approved' AND role_id IS NOT NULL) OR (status<>'approved' AND role_id IS NULL))
);
CREATE INDEX credential_accounts_status ON credential_accounts(status, submitted_at, user_id);

CREATE TABLE account_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES credential_accounts(user_id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL
);
CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);

REVOKE ALL ON account_roles, credential_accounts, account_sessions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON account_roles, credential_accounts TO dacm_runtime;
GRANT SELECT, INSERT, DELETE ON account_sessions TO dacm_runtime;
GRANT UPDATE (role, active) ON users TO dacm_runtime;
GRANT DELETE ON user_scopes TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120110000', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
