import { readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { adaptDatabase, migrate } from "./database.js";
import { importRegistry, stableIndicatorId } from "./registry.js";
import { ApiError } from "./validation.js";

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/registry.json", import.meta.url), "utf8"),
);
const groups = [
  "programs",
  "sections",
  "departments",
  "users",
  "risks",
  "measures",
];
const fail = (code) => {
  throw new ApiError(409, code, "Seed зупинено: " + code);
};
export async function seed(
  database,
  { demoMode = false, manifest = fixture, version = 1 } = {},
) {
  if (!demoMode) throw new Error("Seed requires DEMO_MODE=true");
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  return adaptDatabase(database).transaction(async (db) => {
    const marker = await db
      .prepare("SELECT manifest_hash FROM seed_batches WHERE version=?")
      .get(version);
    const entries = groups.flatMap((group) =>
      manifest[group].map((row) => ({ table: group, id: row.id })),
    );
    entries.push(
      ...manifest.measures.map((m) => ({
        table: "indicators",
        id: stableIndicatorId(m.id),
      })),
    );
    if (marker) {
      if (marker.manifest_hash !== manifestHash) fail("seed_version_conflict");
      for (const { table, id } of entries)
        if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)))
          fail("seed_inconsistent");
      for (const s of manifest.scopes)
        if (
          !(await db
            .prepare(
              "SELECT 1 FROM user_scopes WHERE user_id=? AND program_id=? AND department_id=?",
            )
            .get(s.userId, s.programId, s.departmentId))
        )
          fail("seed_inconsistent");
      if (db.dialect === "sqlite" && (await db.prepare("PRAGMA foreign_key_check").all()).length)
        fail("seed_inconsistent");
      for (const m of manifest.measures) {
        const valid = await db
          .prepare(
            `SELECT 1 FROM measures m JOIN sections s ON s.id=m.section_id JOIN departments d ON d.id=m.department_id JOIN indicators i ON i.measure_id=m.id WHERE m.id=? AND i.id=? AND s.program_id=d.program_id AND EXISTS (SELECT 1 FROM user_scopes us WHERE us.user_id=m.executor_id AND us.program_id=s.program_id AND us.department_id=m.department_id) AND ((s.code=2 AND EXISTS (SELECT 1 FROM risks r WHERE r.id=m.risk_id AND r.program_id=s.program_id)) OR (s.code<>2 AND m.risk_id IS NULL))`,
          )
          .get(m.id, stableIndicatorId(m.id));
        if (!valid) fail("seed_inconsistent");
      }
      return { alreadyApplied: true, version };
    }
    // Check the complete manifest before inserting any row, including cross-table UUID collisions.
    for (const entry of entries)
      for (const table of [...groups, "indicators"])
        if (await db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(entry.id))
          fail("seed_conflict");
    for (const p of manifest.programs)
      if (await db.prepare("SELECT 1 FROM programs WHERE code=?").get(p.code))
        fail("seed_conflict");
    for (const table of ["sections", "departments", "risks"])
      for (const row of manifest[table])
        if (
          await db
            .prepare(`SELECT 1 FROM ${table} WHERE program_id=? AND code=?`)
            .get(row.programId, row.code)
        )
          fail("seed_conflict");
    for (const m of manifest.measures)
      if (
        await db
          .prepare(
            "SELECT 1 FROM measures WHERE section_id=? AND department_id=? AND code=?",
          )
          .get(m.sectionId, m.departmentId, m.code)
      )
        fail("seed_conflict");
    const result = await importRegistry(db, null, manifest, {
      seed: true,
      inTransaction: true,
    });
    await db.prepare("INSERT INTO seed_batches VALUES (?,?,?)").run(
      version,
      manifestHash,
      new Date().toISOString(),
    );
    return result;
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.DEMO_MODE !== "true")
    throw new Error("Seed requires DEMO_MODE=true");
  const path =
    process.env.DATABASE_PATH ||
    fileURLToPath(new URL("../../../data/demo.sqlite", import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    migrate(db);
    console.log(await seed(db, { demoMode: true }));
  } finally {
    db.close();
  }
}
