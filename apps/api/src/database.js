import { readFileSync, readdirSync } from "node:fs";

export function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()) {
    const version = Number(file.split("_")[0]);
    transaction(db, () => {
      if (
        db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
          .get(version)
      )
        return;
      db.exec(readFileSync(new URL(file, directory), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(
        version,
        new Date().toISOString(),
      );
    });
  }
}
