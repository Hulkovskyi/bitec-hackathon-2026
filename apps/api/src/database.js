import { readFileSync, readdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const sqliteAdapters = new WeakMap();

export function databaseConstraintKind(error) {
  if (error.code === "23505" || [1555, 2067].includes(error.errcode)) return "unique";
  if (["23502", "23503", "23514"].includes(error.code) || [275, 787, 1299].includes(error.errcode)) {
    return "invalid";
  }
  return null;
}

export function adaptDatabase(db) {
  if (db.dialect === "sqlite" || db.dialect === "postgres") return db;
  const existing = sqliteAdapters.get(db);
  if (existing) return existing;

  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  function enqueue(work) {
    const operation = tail.then(work);
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async function execute(work) {
    const scope = context.getStore();
    if (!scope) return enqueue(work);
    if (!scope.active) throw new Error("Database transaction has ended");
    return work();
  }

  const adapter = {
    dialect: "sqlite",
    prepare(sql) {
      let statement;
      const call = (method, params) => execute(() => {
        statement ??= db.prepare(sql);
        return statement[method](...params);
      });
      return {
        get: (...params) => call("get", params),
        all: (...params) => call("all", params),
        run: (...params) => call("run", params),
      };
    },
    exec: (sql) => execute(() => db.exec(sql)),
    async transaction(callback, { readOnly = false } = {}) {
      if (context.getStore()) throw new Error("Nested database transactions are not supported");
      return enqueue(async () => {
        // A single SQLite connection must not interleave other requests with
        // queries that run across awaits in a transaction.
        const setReadOnly = readOnly && !db.prepare("PRAGMA query_only").get().query_only;
        if (setReadOnly) db.exec("PRAGMA query_only=ON");
        const scope = { active: true };
        try {
          db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
          try {
            const value = await context.run(scope, callback, adapter);
            db.exec("COMMIT");
            return value;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        } finally {
          scope.active = false;
          if (setReadOnly) db.exec("PRAGMA query_only=OFF");
        }
      });
    },
    async close() {
      if (context.getStore()) throw new Error("Cannot close the database from its transaction");
      return enqueue(() => db.close());
    },
  };
  sqliteAdapters.set(db, adapter);
  return adapter;
}

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
