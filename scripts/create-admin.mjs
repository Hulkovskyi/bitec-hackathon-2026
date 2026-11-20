import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createFirstAdministrator } from "../apps/api/src/accounts.js";
import { migrate } from "../apps/api/src/database.js";
import { migratePostgres, openPostgres } from "../apps/api/src/postgres.js";

const {
  DACM_ADMIN_USERNAME: username,
  DACM_ADMIN_PASSWORD: password,
  DACM_ADMIN_NAME: fullName,
  DACM_ADMIN_DEPARTMENT: department,
  DACM_ADMIN_POSITION: position,
  DACM_ADMIN_DATABASE_URL: postgresUrl,
  SUPABASE_DB_CA: ca,
} = process.env;

async function main() {
  if (![username, password, fullName, department, position].every(Boolean)) {
    throw new Error("Потрібні DACM_ADMIN_USERNAME, DACM_ADMIN_PASSWORD, DACM_ADMIN_NAME, DACM_ADMIN_DEPARTMENT і DACM_ADMIN_POSITION");
  }
  let db;
  try {
    if (postgresUrl) {
      const url = new URL(postgresUrl);
      if (["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"].some((key) => url.searchParams.has(key))) {
        throw new Error("Вилучіть параметри TLS з DACM_ADMIN_DATABASE_URL");
      }
      if (!ca?.includes("-----BEGIN CERTIFICATE-----")) throw new Error("Потрібен SUPABASE_DB_CA");
      db = openPostgres(url.href, { ssl: { ca, rejectUnauthorized: true } });
      await migratePostgres(db);
    } else {
      const path = process.env.DATABASE_PATH || fileURLToPath(new URL("../data/demo.sqlite", import.meta.url));
      mkdirSync(dirname(path), { recursive: true });
      db = new DatabaseSync(path);
      migrate(db);
    }
    const administrator = await createFirstAdministrator(db, { username, password, fullName, department, position });
    console.log(`Створено адміністратора ${administrator.username}`);
  } finally {
    await db?.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
