-- Source records are historical synthetic claims, separate from live workflow.
CREATE TABLE official_dataset_batches (
  program_id TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE RESTRICT,
  source_period TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  imported_at TEXT NOT NULL,
  UNIQUE(program_id, source_period)
);

CREATE TABLE official_measure_metadata (
  measure_id TEXT PRIMARY KEY REFERENCES measures(id) ON DELETE RESTRICT,
  program_id TEXT NOT NULL REFERENCES official_dataset_batches(program_id) ON DELETE RESTRICT,
  section_order INTEGER NOT NULL CHECK(section_order>=1),
  plan_text TEXT NOT NULL,
  source_schedule_type TEXT NOT NULL CHECK(source_schedule_type IN ('one_time','continuous','periodic')),
  source_planned_date TEXT,
  source_title TEXT NOT NULL,
  source_department_id TEXT NOT NULL,
  source_department_title TEXT NOT NULL,
  source_section_code INTEGER NOT NULL CHECK(source_section_code IN (1,2,3)),
  indicator_title TEXT NOT NULL,
  indicator_target REAL,
  indicator_unit TEXT,
  expected_evidence TEXT NOT NULL,
  resources TEXT NOT NULL,
  UNIQUE(measure_id, program_id),
  FOREIGN KEY(source_department_id, program_id) REFERENCES departments(id, program_id) ON DELETE RESTRICT
);
CREATE INDEX official_measure_program_idx ON official_measure_metadata(program_id);

CREATE TABLE official_measure_results (
  measure_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  source_period TEXT NOT NULL,
  source_status TEXT NOT NULL CHECK(source_status IN ('vykonano','chastkovo','ne_vykonano','v_roboti','ne_rozpochato')),
  source_approved INTEGER NOT NULL CHECK(source_approved IN (0,1)),
  source_actual_date TEXT,
  description TEXT NOT NULL,
  measured_value REAL,
  source_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  source_entered_at TEXT,
  PRIMARY KEY(measure_id, source_period),
  FOREIGN KEY(measure_id, program_id) REFERENCES official_measure_metadata(measure_id, program_id) ON DELETE RESTRICT,
  FOREIGN KEY(program_id, source_period) REFERENCES official_dataset_batches(program_id, source_period) ON DELETE RESTRICT
);
CREATE INDEX official_results_program_idx ON official_measure_results(program_id, source_period);

CREATE TABLE official_evidence_claims (
  id TEXT PRIMARY KEY,
  measure_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  document_date TEXT NOT NULL,
  reference_url TEXT,
  source_uploaded_at TEXT NOT NULL,
  source_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_checksum TEXT NOT NULL CHECK(length(source_checksum)=64),
  UNIQUE(program_id, source_id),
  FOREIGN KEY(measure_id, program_id) REFERENCES official_measure_metadata(measure_id, program_id) ON DELETE RESTRICT
);
CREATE INDEX official_evidence_measure_idx ON official_evidence_claims(measure_id);

CREATE TABLE official_deadline_changes (
  id TEXT PRIMARY KEY,
  measure_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  decision_date TEXT NOT NULL,
  old_deadline TEXT NOT NULL,
  new_deadline TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY(measure_id, program_id) REFERENCES official_measure_metadata(measure_id, program_id) ON DELETE RESTRICT
);
CREATE INDEX official_deadline_measure_idx ON official_deadline_changes(measure_id);
