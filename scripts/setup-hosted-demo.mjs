import { migratePostgres, openPostgres } from "../apps/api/src/postgres.js";
import { seed } from "../apps/api/src/seed.js";

if (process.env.DEMO_MODE !== "true" || !process.env.DACM_ADMIN_DATABASE_URL)
  throw new Error("Set DEMO_MODE=true and DACM_ADMIN_DATABASE_URL for the isolated demo database");

const db = openPostgres(process.env.DACM_ADMIN_DATABASE_URL, {
  ssl: { ca: process.env.SUPABASE_DB_CA, rejectUnauthorized: true },
});
try {
  const applied = await migratePostgres(db);
  const data = await seed(db, { demoMode: true });
  console.log("Applied migrations", applied.length, "Synthetic registry", data);
} catch (error) {
  // Do not print the connection URL, raw Postgres details or credentials.
  console.error("Hosted demo setup failed", error.code ?? "UNKNOWN");
  process.exitCode = 1;
} finally {
  await db.close();
}
