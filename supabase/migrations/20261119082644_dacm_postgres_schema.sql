-- App backend only. Run with the isolated project's database owner.
CREATE SCHEMA IF NOT EXISTS dacm;
REVOKE ALL ON SCHEMA dacm FROM PUBLIC;
SET LOCAL search_path = dacm, pg_catalog;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE programs (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, CHECK(period_start <= period_end));
CREATE TABLE sections (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE RESTRICT, code INTEGER NOT NULL CHECK(code IN (1,2,3)), title TEXT NOT NULL, UNIQUE(program_id,code));
CREATE TABLE departments (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE RESTRICT, code TEXT NOT NULL, title TEXT NOT NULL, UNIQUE(program_id,code), UNIQUE(id,program_id));
CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('executor','coordinator','leader','analyst','admin')), active INTEGER NOT NULL CHECK(active IN (0,1)));
CREATE TABLE user_scopes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE RESTRICT, department_id TEXT NOT NULL, PRIMARY KEY(user_id,program_id,department_id), FOREIGN KEY(department_id,program_id) REFERENCES departments(id,program_id) ON DELETE RESTRICT);
CREATE TABLE risks (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE RESTRICT, code TEXT NOT NULL, title TEXT NOT NULL, UNIQUE(program_id,code));
CREATE TABLE measures (id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE RESTRICT, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE RESTRICT, executor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, risk_id TEXT REFERENCES risks(id) ON DELETE RESTRICT, code TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, schedule_type TEXT NOT NULL CHECK(schedule_type IN ('one_time','continuous')), planned_date TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), version INTEGER NOT NULL CHECK(version >= 1), effective_from TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(section_id,department_id,code), CHECK((schedule_type='one_time' AND planned_date IS NOT NULL) OR (schedule_type='continuous' AND planned_date IS NULL)));
CREATE TABLE indicators (id TEXT PRIMARY KEY, measure_id TEXT NOT NULL UNIQUE REFERENCES measures(id) ON DELETE RESTRICT, title TEXT NOT NULL, unit TEXT NOT NULL, baseline DOUBLE PRECISION NOT NULL, target DOUBLE PRECISION NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('increase','decrease','maintain')), CHECK((direction='increase' AND target>=baseline) OR (direction='decrease' AND target<=baseline) OR (direction='maintain' AND target=baseline)));
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, occurred_at TEXT NOT NULL);
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, auth_kind TEXT NOT NULL CHECK(auth_kind='demo'), expires_at TEXT NOT NULL);
CREATE INDEX measures_executor ON measures(executor_id);
CREATE INDEX measures_department ON measures(department_id);
CREATE INDEX audit_entity ON audit_events(entity_type,entity_id,occurred_at,id);
CREATE INDEX scopes_department ON user_scopes(department_id,user_id);
CREATE TABLE seed_batches (version INTEGER PRIMARY KEY, manifest_hash TEXT NOT NULL, applied_at TEXT NOT NULL);

CREATE TABLE results (
  id TEXT NOT NULL PRIMARY KEY,
  measure_id TEXT NOT NULL REFERENCES measures(id) ON DELETE RESTRICT,
  period_key TEXT NOT NULL CHECK (
    period_key = 'once' OR period_key ~ '^[0-9]{4}-H[12]$'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  supersedes_id TEXT,
  executor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_snapshot_json TEXT CHECK (plan_snapshot_json IS NULL OR plan_snapshot_json::jsonb IS NOT NULL),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'approved')),
  outcome TEXT CHECK (outcome IN ('completed', 'partial', 'not_completed')),
  description TEXT NOT NULL DEFAULT '',
  non_completion_reason TEXT,
  result_date TEXT,
  actual_date TEXT,
  measured_value DOUBLE PRECISION,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (measure_id, period_key, revision),
  UNIQUE (id, measure_id, period_key),
  FOREIGN KEY (supersedes_id, measure_id, period_key)
    REFERENCES results(id, measure_id, period_key) ON DELETE RESTRICT,
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK ((revision = 1 AND supersedes_id IS NULL) OR (revision > 1 AND supersedes_id IS NOT NULL))
);

CREATE UNIQUE INDEX results_one_open_revision
  ON results(measure_id, period_key)
  WHERE status IN ('draft', 'submitted', 'returned');

CREATE TABLE period_assignments (
  measure_id TEXT NOT NULL REFERENCES measures(id) ON DELETE RESTRICT,
  period_key TEXT NOT NULL CHECK (
    period_key = 'once' OR period_key ~ '^[0-9]{4}-H[12]$'
  ),
  executor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (measure_id, period_key)
);

CREATE TABLE evidence_versions (
  id TEXT NOT NULL PRIMARY KEY,
  result_id TEXT NOT NULL REFERENCES results(id) ON DELETE RESTRICT,
  logical_file_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf', 'image/png', 'image/jpeg', 'text/plain')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 5242880),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (logical_file_id, revision)
);

CREATE INDEX evidence_versions_result ON evidence_versions(result_id, uploaded_by);

CREATE TABLE result_reviews (
  id TEXT NOT NULL PRIMARY KEY,
  result_id TEXT NOT NULL REFERENCES results(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('return', 'approve')),
  comment TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  UNIQUE (result_id, result_version),
  CHECK (decision <> 'return' OR length(trim(comment)) > 0)
);

-- Provision the runtime role's login credential separately.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dacm_runtime') THEN
    CREATE ROLE dacm_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$role$;

ALTER ROLE dacm_runtime SET search_path TO pg_catalog, dacm;
REVOKE ALL ON ALL TABLES IN SCHEMA dacm FROM PUBLIC;
GRANT USAGE ON SCHEMA dacm TO dacm_runtime;
GRANT SELECT ON programs, sections, departments, users, user_scopes, risks, measures,
  indicators, audit_events, sessions, results, period_assignments, evidence_versions,
  result_reviews TO dacm_runtime;
GRANT INSERT ON programs, sections, departments, users, user_scopes, risks, measures,
  indicators, audit_events, sessions, results, period_assignments, evidence_versions,
  result_reviews TO dacm_runtime;
GRANT UPDATE ON measures, indicators, results, period_assignments TO dacm_runtime;
GRANT DELETE ON sessions TO dacm_runtime;

-- A Supabase migration and the standalone bootstrap record the same version.
INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261119082644', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
