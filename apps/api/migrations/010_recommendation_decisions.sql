CREATE TABLE risk_flag_decisions (
  id TEXT NOT NULL PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('live', 'official')),
  rule_code TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('measure', 'department', 'risk')),
  subject_id TEXT NOT NULL,
  measure_id TEXT REFERENCES measures(id) ON DELETE CASCADE,
  risk_id TEXT,
  risk_owner_department_id TEXT,
  period_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(length(trim(action)) BETWEEN 1 AND 2000),
  assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_date TEXT NOT NULL,
  decided_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  signal_json TEXT NOT NULL,
  FOREIGN KEY(department_id, program_id) REFERENCES departments(id, program_id) ON DELETE CASCADE,
  FOREIGN KEY(risk_id, program_id) REFERENCES risks(id, program_id) ON DELETE CASCADE,
  FOREIGN KEY(risk_owner_department_id, program_id) REFERENCES departments(id, program_id) ON DELETE CASCADE,
  UNIQUE(program_id, source, rule_code, subject_type, subject_id, period_key),
  CHECK(
    (subject_type='measure' AND measure_id IS NOT NULL AND measure_id=subject_id AND (
      (source='official' AND rule_code='RF3' AND risk_id IS NOT NULL AND risk_owner_department_id IS NOT NULL) OR
      ((source<>'official' OR rule_code<>'RF3') AND risk_id IS NULL AND risk_owner_department_id IS NULL)
    )) OR
    (subject_type='risk' AND risk_id IS NOT NULL AND risk_id=subject_id AND measure_id IS NULL AND risk_owner_department_id IS NULL) OR
    (subject_type='department' AND department_id=subject_id AND measure_id IS NULL AND risk_id IS NULL AND risk_owner_department_id IS NULL)
  )
);

CREATE INDEX risk_flag_decisions_program_order_idx ON risk_flag_decisions(program_id, updated_at, id);
CREATE INDEX risk_flag_decisions_department_idx ON risk_flag_decisions(department_id, program_id);
CREATE INDEX risk_flag_decisions_measure_idx ON risk_flag_decisions(measure_id);
CREATE INDEX risk_flag_decisions_risk_idx ON risk_flag_decisions(risk_id);
CREATE INDEX risk_flag_decisions_risk_owner_idx ON risk_flag_decisions(risk_owner_department_id, program_id);
