import { randomUUID } from "node:crypto";
import { verifyAdministrator } from "./account-admin.js";
import { audit, missing } from "./registry.js";
import { ApiError, date, invalid, keys, text, uuid } from "./validation.js";

const sectionTitles = [
  "Загальна відомча політика",
  "Усунення корупційних ризиків",
  "Навчання та антикорупційна інформація",
];

async function readProgram(db, id) {
  const program = await db.prepare(
    "SELECT id, code, title, period_start AS periodStart, period_end AS periodEnd FROM programs WHERE id=?",
  ).get(id);
  return program ?? missing();
}

async function readRisk(db, programId, id) {
  const risk = await db.prepare("SELECT id,code,title FROM risks WHERE program_id=? AND id=?").get(programId, id);
  return risk ?? missing();
}

function programFields(body) {
  const fields = ["code", "title", "periodStart", "periodEnd"];
  keys(body, fields, fields);
  const periodStart = date(body.periodStart), periodEnd = date(body.periodEnd);
  if (periodEnd < periodStart) invalid("Кінець програми має бути не раніше за початок.");
  return { code: text(body.code, 50), title: text(body.title), periodStart, periodEnd };
}

function riskFields(body) {
  keys(body, ["code", "title"], ["code", "title"]);
  return { code: text(body.code, 50), title: text(body.title) };
}

function dependentRecord(message) {
  return new ApiError(409, "record_in_use", message);
}

async function removeWithDependencies(write, work, message) {
  try {
    await write(work);
  } catch (error) {
    if (["23503", "23001"].includes(error.code) || error.errcode === 787 ||
        (error.errcode === 1811 && error.message === "FOREIGN KEY constraint failed")) {
      throw dependentRecord(message);
    }
    throw error;
  }
}

// The shared /api/admin middleware requires an active password administrator.
export function mountCatalogAdminRoutes(app, db) {
  const writeAsAdmin = (actor, operation) => db.transaction(async (tx) => {
    await verifyAdministrator(tx, actor.id);
    return operation(tx);
  });
  app.post("/api/admin/programs", async (req, res) => {
    keys(req.query, []);
    const program = { id: randomUUID(), ...programFields(req.body) };
    await writeAsAdmin(req.user, async (tx) => {
      await tx.prepare("INSERT INTO programs (id,code,title,period_start,period_end) VALUES (?,?,?,?,?)")
        .run(program.id, program.code, program.title, program.periodStart, program.periodEnd);
      const insertSection = tx.prepare("INSERT INTO sections (id,program_id,code,title) VALUES (?,?,?,?)");
      for (const [index, title] of sectionTitles.entries()) {
        await insertSection.run(randomUUID(), program.id, index + 1, title);
      }
      await audit(tx, req.user.id, "create", "program", program.id, null, program);
    });
    res.status(201).json(program);
  });

  app.patch("/api/admin/programs/:programId", async (req, res) => {
    keys(req.query, []);
    const id = uuid(req.params.programId);
    const after = { id, ...programFields(req.body) };
    await writeAsAdmin(req.user, async (tx) => {
      const before = await readProgram(tx, id);
      const changesPeriod = before.periodStart !== after.periodStart || before.periodEnd !== after.periodEnd;
      if (changesPeriod && await tx.prepare(
        "SELECT 1 FROM measures m JOIN sections s ON s.id=m.section_id WHERE s.program_id=? LIMIT 1",
      ).get(id)) {
        throw dependentRecord("У програмі вже є заходи. Її період зафіксовано.");
      }
      const changed = await tx.prepare(
        "UPDATE programs SET code=?, title=?, period_start=?, period_end=? WHERE id=?",
      ).run(after.code, after.title, after.periodStart, after.periodEnd, id);
      if (!changed.changes) missing();
      await audit(tx, req.user.id, "update", "program", id, before, after);
    });
    res.json(after);
  });

  app.delete("/api/admin/programs/:programId", async (req, res) => {
    keys(req.query, []);
    if (req.body !== undefined) keys(req.body, []);
    const id = uuid(req.params.programId);
    const message = "Програма має підрозділи, ризики, заходи, паспорт або архівні записи.";
    await removeWithDependencies((work) => writeAsAdmin(req.user, work), async (tx) => {
      const before = await readProgram(tx, id);
      await tx.prepare("DELETE FROM sections WHERE program_id=?").run(id);
      const removed = await tx.prepare("DELETE FROM programs WHERE id=?").run(id);
      if (!removed.changes) missing();
      await audit(tx, req.user.id, "delete", "program", id, before, null);
    }, message);
    res.status(204).end();
  });

  app.delete("/api/admin/programs/:programId/passport", async (req, res) => {
    keys(req.query, []);
    if (req.body !== undefined) keys(req.body, []);
    const id = uuid(req.params.programId);
    await writeAsAdmin(req.user, async (tx) => {
      await readProgram(tx, id);
      if (await tx.prepare("SELECT 1 FROM official_dataset_batches WHERE program_id=?").get(id)) {
        throw dependentRecord("Паспорт пов’язаний з офіційним архівом.");
      }
      const before = await tx.prepare("SELECT * FROM program_passports WHERE program_id=?").get(id);
      if (!before) missing();
      const removed = await tx.prepare("DELETE FROM program_passports WHERE program_id=?").run(id);
      if (!removed.changes) missing();
      await audit(tx, req.user.id, "delete", "program_passport", id, before, null);
    });
    res.status(204).end();
  });

  app.post("/api/admin/programs/:programId/risks", async (req, res) => {
    keys(req.query, []);
    const programId = uuid(req.params.programId);
    const risk = { id: randomUUID(), ...riskFields(req.body) };
    await writeAsAdmin(req.user, async (tx) => {
      await readProgram(tx, programId);
      await tx.prepare("INSERT INTO risks (id,program_id,code,title) VALUES (?,?,?,?)")
        .run(risk.id, programId, risk.code, risk.title);
      await audit(tx, req.user.id, "create", "risk", risk.id, null, { ...risk, programId });
    });
    res.status(201).json(risk);
  });

  app.patch("/api/admin/programs/:programId/risks/:riskId", async (req, res) => {
    keys(req.query, []);
    const programId = uuid(req.params.programId), id = uuid(req.params.riskId);
    const after = { id, ...riskFields(req.body) };
    await writeAsAdmin(req.user, async (tx) => {
      const before = await readRisk(tx, programId, id);
      const changed = await tx.prepare("UPDATE risks SET code=?,title=? WHERE program_id=? AND id=?")
        .run(after.code, after.title, programId, id);
      if (!changed.changes) missing();
      await audit(tx, req.user.id, "update", "risk", id, { ...before, programId }, { ...after, programId });
    });
    res.json(after);
  });

  app.delete("/api/admin/programs/:programId/risks/:riskId", async (req, res) => {
    keys(req.query, []);
    if (req.body !== undefined) keys(req.body, []);
    const programId = uuid(req.params.programId), id = uuid(req.params.riskId);
    const message = "Ризик має пов’язані заходи або історію вимірювань.";
    await removeWithDependencies((work) => writeAsAdmin(req.user, work), async (tx) => {
      const before = await readRisk(tx, programId, id);
      const indicator = await tx.prepare("SELECT * FROM risk_indicators WHERE risk_id=?").get(id);
      if (indicator) await tx.prepare("DELETE FROM risk_indicators WHERE risk_id=?").run(id);
      await tx.prepare(`
        DELETE FROM audit_events
        WHERE entity_type='risk_flag_decision' AND entity_id IN (
          SELECT id FROM risk_flag_decisions WHERE program_id=? AND risk_id=?
        )
      `).run(programId, id);
      const removed = await tx.prepare("DELETE FROM risks WHERE program_id=? AND id=?").run(programId, id);
      if (!removed.changes) missing();
      await audit(tx, req.user.id, "delete", "risk", id, { ...before, programId, indicator }, null);
    }, message);
    res.status(204).end();
  });
}
