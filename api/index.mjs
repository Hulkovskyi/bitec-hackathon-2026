import { createApp } from "../apps/api/src/app.js";
import { createEvidenceStore } from "../apps/api/src/evidence.js";
import { createSupabaseEvidenceStorage } from "../apps/api/src/evidence-storage.js";
import { openPostgres } from "../apps/api/src/postgres.js";

function start() {
  const {
    DACM_DATABASE_URL,
    DACM_PUBLIC_ORIGIN,
    SUPABASE_DB_CA,
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    SUPABASE_EVIDENCE_BUCKET = "bitec-evidence",
  } = process.env;
  const publicOrigin = new URL(DACM_PUBLIC_ORIGIN);
  if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== DACM_PUBLIC_ORIGIN)
    throw new Error("An HTTPS DACM_PUBLIC_ORIGIN is required");

  const storage = createSupabaseEvidenceStorage({
    url: SUPABASE_URL,
    secretKey: SUPABASE_SECRET_KEY,
    bucket: SUPABASE_EVIDENCE_BUCKET,
  });
  // TLS verification is enabled. Do not put sslmode in the URL because it
  // overrides the driver's explicit TLS settings.
  const databaseUrl = new URL(DACM_DATABASE_URL);
  if (["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"].some((key) => databaseUrl.searchParams.has(key)))
    throw new Error("Remove TLS query parameters from DACM_DATABASE_URL");
  if (!SUPABASE_DB_CA?.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error("The official Supabase database CA certificate is required");
  const db = openPostgres(databaseUrl.href, {
    ssl: { ca: SUPABASE_DB_CA, rejectUnauthorized: true },
  });
  return createApp(db, {
    secureCookies: true,
    serveWeb: false,
    allowedOrigins: [publicOrigin.origin],
    evidenceStore: createEvidenceStore(db, { storage }),
    async checkReadiness() {
      if (!await db.prepare("SELECT 1 FROM account_roles WHERE id='admin'").get())
        throw new Error("Account roles have not been initialized");
      await db.prepare("SELECT manager_id FROM credential_accounts LIMIT 1").get();
      await storage.checkPrivateBucket();
    },
  });
}

let app;
export default function handler(req, res) {
  if (!app) {
    try {
      app = start();
    } catch {
      console.error("BITEC hosted configuration is incomplete or invalid");
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({
        error: { code: "unavailable", message: "Онлайн-застосунок ще не налаштовано" },
      }));
      return;
    }
  }
  return app(req, res);
}
