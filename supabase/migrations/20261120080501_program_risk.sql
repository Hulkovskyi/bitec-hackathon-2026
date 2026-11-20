SET LOCAL search_path TO dacm, pg_catalog;

CREATE TABLE program_passports (
  program_id TEXT NOT NULL PRIMARY KEY REFERENCES programs(id) ON DELETE RESTRICT,
  goals TEXT NOT NULL,
  organization TEXT,
  approval_reference TEXT,
  nazk_approval_status TEXT,
  notes TEXT,
  restricted_information INTEGER NOT NULL DEFAULT 0 CHECK (restricted_information IN (0, 1)),
  coordinator_department_id TEXT,
  FOREIGN KEY (coordinator_department_id, program_id) REFERENCES departments(id, program_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX risks_program_identity ON risks(id, program_id);

CREATE TABLE risk_indicators (
  risk_id TEXT NOT NULL PRIMARY KEY,
  program_id TEXT NOT NULL,
  owner_department_id TEXT NOT NULL,
  title TEXT NOT NULL,
  unit TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('increase', 'decrease')),
  baseline DOUBLE PRECISION NOT NULL,
  baseline_on TEXT NOT NULL,
  target DOUBLE PRECISION NOT NULL,
  target_on TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  likelihood INTEGER CHECK (likelihood BETWEEN 1 AND 4),
  impact INTEGER CHECK (impact BETWEEN 1 AND 4),
  FOREIGN KEY (risk_id, program_id) REFERENCES risks(id, program_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_department_id, program_id) REFERENCES departments(id, program_id) ON DELETE RESTRICT,
  CHECK ((likelihood IS NULL) = (impact IS NULL)),
  CHECK (target_on >= baseline_on),
  CHECK ((direction = 'increase' AND target >= baseline) OR (direction = 'decrease' AND target <= baseline))
);

CREATE TABLE risk_measurements (
  id TEXT NOT NULL PRIMARY KEY,
  risk_id TEXT NOT NULL REFERENCES risk_indicators(risk_id) ON DELETE RESTRICT,
  reading_on TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (risk_id, reading_on)
);

REVOKE ALL ON program_passports, risk_indicators, risk_measurements FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON program_passports, risk_indicators TO dacm_runtime;
GRANT SELECT, INSERT ON risk_measurements TO dacm_runtime;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('20261120080501', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (version) DO NOTHING;
