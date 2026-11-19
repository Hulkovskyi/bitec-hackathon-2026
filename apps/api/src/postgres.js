import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

const queryTypes = {
  getTypeParser(oid, format) {
    if (oid !== 20 || format === "binary") return pg.types.getTypeParser(oid, format);
    return (text) => {
      const number = Number(text);
      if (!Number.isSafeInteger(number)) throw new RangeError("Postgres integer exceeds JavaScript precision");
      return number;
    };
  },
};

function quotedEnd(sql, start, escaped) {
  const quote = sql[start];
  for (let position = start + 1; position < sql.length; position += 1) {
    if (escaped && sql[position] === "\\") position += 1;
    else if (sql[position] === quote) {
      if (sql[position + 1] === quote) position += 1;
      else return position + 1;
    }
  }
  return sql.length;
}

function commentEnd(sql, start) {
  let depth = 1;
  let position = start + 2;
  while (position < sql.length && depth > 0) {
    const pair = sql.slice(position, position + 2);
    if (pair === "/*" || pair === "*/") {
      depth += pair === "/*" ? 1 : -1;
      position += 2;
    } else position += 1;
  }
  return position;
}

function statement(sql) {
  let text = "";
  let bindCount = 0;
  for (let position = 0; position < sql.length;) {
    const character = sql[position];
    const next = sql[position + 1];
    const tokenStart = position === 0 || !/[\w$]/.test(sql[position - 1]);
    let end = position + 1;
    if (character === "-" && next === "-") {
      const newline = sql.indexOf("\n", position + 2);
      end = newline < 0 ? sql.length : newline;
    } else if (character === "/" && next === "*") {
      end = commentEnd(sql, position);
    } else if (character === "'" || character === '"') {
      end = quotedEnd(sql, position, false);
    } else if (tokenStart && (character === "E" || character === "e") && next === "'") {
      end = quotedEnd(sql, position + 1, true);
    } else if (tokenStart && character === "$") {
      const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(position))?.[0];
      if (delimiter) {
        const closing = sql.indexOf(delimiter, position + delimiter.length);
        end = closing < 0 ? sql.length : closing + delimiter.length;
      }
    } else if (character === "?") {
      bindCount += 1;
      text += "$" + bindCount;
      position += 1;
      continue;
    } else if (tokenStart && (character === "A" || character === "a")) {
      const alias = /^(AS\s+)([a-z_][a-z0-9_]*)(?![\w$])/i.exec(sql.slice(position));
      // PostgreSQL folds unquoted aliases. Existing API names use camel case.
      if (alias && /[a-z]/.test(alias[2]) && /[A-Z]/.test(alias[2])) {
        text += alias[1] + '"' + alias[2] + '"';
        position += alias[0].length;
        continue;
      }
    }
    text += sql.slice(position, end);
    position = end;
  }
  return { text, bindCount };
}

export function openPostgres(connectionString, { ssl } = {}) {
  if (!connectionString) throw new Error("Postgres connection string is required");
  const pool = new pg.Pool({
    connectionString,
    ...(ssl === undefined ? {} : { ssl }),
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => console.error("Postgres idle connection failed", error.code ?? "UNKNOWN"));
  const context = new AsyncLocalStorage();

  async function withClient(callback, readOnly) {
    const client = await pool.connect();
    const scope = { client, active: true };
    let releaseError;
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      await client.query("SET LOCAL search_path TO pg_catalog, dacm");
      // Preserve SQLite's one-writer semantics for checks and writes performed
      // by separate statements. The lock is released at commit or rollback.
      if (!readOnly) await client.query("SELECT pg_advisory_xact_lock(1145127757, 1)");
      const result = await context.run(scope, callback, client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (cause) {
        releaseError = cause;
      }
      throw error;
    } finally {
      scope.active = false;
      client.release(releaseError);
    }
  }

  async function execute(callback, readOnly = false) {
    const scope = context.getStore();
    if (!scope) return withClient(callback, readOnly);
    if (!scope.active) throw new Error("Database transaction has ended");
    return callback(scope.client);
  }

  const adapter = {
    dialect: "postgres",
    prepare(sql) {
      const { text, bindCount } = statement(sql);
      const readOnly = /^\s*SELECT\b/i.test(sql);
      async function query(params) {
        if (params.length !== bindCount) throw new Error("Incorrect number of SQL parameters");
        return execute((client) => client.query({ text, values: params, types: queryTypes }), readOnly);
      }
      return {
        get: async (...params) => (await query(params)).rows[0],
        all: async (...params) => (await query(params)).rows,
        run: async (...params) => ({ changes: (await query(params)).rowCount ?? 0 }),
      };
    },
    async exec(sql) {
      await execute((client) => client.query(sql));
    },
    async transaction(callback, { readOnly = false } = {}) {
      if (context.getStore()) throw new Error("Nested database transactions are not supported");
      return withClient(() => callback(adapter), readOnly);
    },
    async close() {
      if (context.getStore()) throw new Error("Cannot close the database from its transaction");
      await pool.end();
    },
  };
  return adapter;
}

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);

export async function migratePostgres(db) {
  const files = (await readdir(migrationsDirectory)).filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort();
  return db.transaction(async (tx) => {
    await tx.exec(`
      CREATE SCHEMA IF NOT EXISTS dacm;
      CREATE TABLE IF NOT EXISTS dacm.schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    const applied = [];
    for (const file of files) {
      const version = file.split("_")[0];
      if (await tx.prepare("SELECT 1 FROM dacm.schema_migrations WHERE version=?").get(version)) continue;
      await tx.exec(await readFile(new URL(file, migrationsDirectory), "utf8"));
      await tx.prepare(`
        INSERT INTO dacm.schema_migrations (version, applied_at) VALUES (?, ?)
        ON CONFLICT (version) DO NOTHING
      `).run(version, new Date().toISOString());
      applied.push(version);
    }
    return applied;
  });
}
