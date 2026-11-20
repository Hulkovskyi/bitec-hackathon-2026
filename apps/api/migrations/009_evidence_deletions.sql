-- File deletion is retried separately after the owning database record commits.
CREATE TABLE evidence_deletions (
  storage_key TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
