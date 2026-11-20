import { resetAccounts } from "../apps/api/src/account-reset.js";
import { validateAccountPassword } from "../apps/api/src/accounts.js";
import { migratePostgres, openPostgres } from "../apps/api/src/postgres.js";
import { text } from "../apps/api/src/validation.js";

const {
  DACM_ADMIN_DATABASE_URL: postgresUrl,
  SUPABASE_DB_CA: ca,
  DACM_ADMIN_PASSWORD: password,
  DACM_ADMIN_NAME: fullName,
  DACM_ADMIN_DEPARTMENT: department,
  DACM_ADMIN_POSITION: position,
} = process.env;

async function main() {
  validateAccountPassword(password);
  for (const value of [fullName, department, position]) {
    if (value !== undefined) text(value, 160);
  }
  if (!postgresUrl) throw new Error("Потрібен DACM_ADMIN_DATABASE_URL для PostgreSQL");
  const url = new URL(postgresUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("DACM_ADMIN_DATABASE_URL має бути мережевою адресою PostgreSQL");
  }
  if (["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"].some((key) => url.searchParams.has(key))) {
    throw new Error("Вилучіть параметри TLS з DACM_ADMIN_DATABASE_URL");
  }
  if (!ca?.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----")) {
    throw new Error("Потрібен PEM-сертифікат SUPABASE_DB_CA");
  }

  let phase = "підключитися до PostgreSQL";
  let db;
  let result;
  try {
    db = openPostgres(url.href, { ssl: { ca, rejectUnauthorized: true } });
    phase = "застосувати міграції PostgreSQL";
    await migratePostgres(db);
    phase = "скинути облікові записи";
    result = await resetAccounts(db, { password, fullName, department, position });
  } catch {
    throw new Error(`Не вдалося ${phase}. Перевірте адресу, сертифікат і права адміністратора PostgreSQL.`);
  } finally {
    try {
      await db?.close();
    } catch {
      if (result) console.error("Скидання виконано. Не вдалося закрити підключення до PostgreSQL.");
    }
  }
  console.log(`Чинний логін адміністратора: ${result.username}. Архівовано облікових записів: ${result.retiredAccounts}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
