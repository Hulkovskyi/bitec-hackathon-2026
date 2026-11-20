ALTER TABLE credential_accounts ADD COLUMN manager_id TEXT
  REFERENCES credential_accounts(user_id) ON DELETE RESTRICT
  CHECK(manager_id IS NULL OR manager_id<>user_id);
