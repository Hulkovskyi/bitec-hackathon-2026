CREATE TABLE results (
  id TEXT NOT NULL PRIMARY KEY,
  measure_id TEXT NOT NULL REFERENCES measures(id) ON DELETE RESTRICT,
  period_key TEXT NOT NULL CHECK (
    period_key = 'once' OR period_key GLOB '[0-9][0-9][0-9][0-9]-H[12]'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  supersedes_id TEXT,
  executor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_snapshot_json TEXT CHECK (plan_snapshot_json IS NULL OR json_valid(plan_snapshot_json)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'approved')),
  outcome TEXT CHECK (outcome IN ('completed', 'partial', 'not_completed')),
  description TEXT NOT NULL DEFAULT '',
  non_completion_reason TEXT,
  result_date TEXT,
  actual_date TEXT,
  measured_value REAL,
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
    period_key = 'once' OR period_key GLOB '[0-9][0-9][0-9][0-9]-H[12]'
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
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
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
