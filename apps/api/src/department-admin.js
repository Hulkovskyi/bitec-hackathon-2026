import { randomUUID } from "node:crypto";
import { verifyAdministrator } from "./account-admin.js";
import { purgeMeasureRows } from "./measure-purge.js";
import { audit, missing, programAllowed } from "./registry.js";
import { keys, text, uuid } from "./validation.js";

const path = "/api/admin/programs/:programId/departments";
const departmentFields = ["code", "title"];

function departmentInput(req) {
  keys(req.query, []);
  keys(req.body, departmentFields, departmentFields);
  return { code: text(req.body.code, 50), title: text(req.body.title, 200) };
}

async function findDepartment(db, programId, departmentId) {
  const department = await db.prepare(`
    SELECT id, program_id AS programId, code, title
    FROM departments WHERE program_id=? AND id=?
  `).get(programId, departmentId);
  return department ?? missing();
}

export function mountDepartmentAdminRoutes(app, db, { finishDeletion = (res) => res.status(204).end() } = {}) {
  app.post(path, async (req, res) => {
    const input = departmentInput(req);
    const programId = uuid(req.params.programId);
    const department = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      await programAllowed(tx, req.user, programId);
      const id = randomUUID();
      await tx.prepare("INSERT INTO departments (id,program_id,code,title) VALUES (?,?,?,?)")
        .run(id, programId, input.code, input.title);
      const created = { id, programId, ...input };
      await audit(tx, req.user.id, "create", "department", id, null, created);
      return created;
    });
    res.status(201).json(department);
  });

  app.patch(`${path}/:departmentId`, async (req, res) => {
    const input = departmentInput(req);
    const programId = uuid(req.params.programId);
    const id = uuid(req.params.departmentId);
    const department = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const before = await findDepartment(tx, programId, id);
      await tx.prepare("UPDATE departments SET code=?,title=? WHERE program_id=? AND id=?")
        .run(input.code, input.title, programId, id);
      const updated = { id, programId, ...input };
      await audit(tx, req.user.id, "update", "department", id, before, updated);
      return updated;
    });
    res.json(department);
  });

  app.delete(`${path}/:departmentId`, async (req, res) => {
    keys(req.query, []);
    const programId = uuid(req.params.programId);
    const id = uuid(req.params.departmentId);
    await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      await findDepartment(tx, programId, id);
      const measureIds = (await tx.prepare(`
        SELECT id FROM measures WHERE department_id=?
        UNION
        SELECT measure_id FROM official_measure_metadata WHERE source_department_id=?
      `).all(id, id)).map((row) => row.id);
      const { measures } = await purgeMeasureRows(tx, measureIds);
      const scopes = await tx.prepare("DELETE FROM user_scopes WHERE program_id=? AND department_id=?").run(programId, id);
      await tx.prepare(`
        UPDATE program_passports SET coordinator_department_id=NULL
        WHERE program_id=? AND coordinator_department_id=?
      `).run(programId, id);
      const ownedRisks = "SELECT risk_id FROM risk_indicators WHERE program_id=? AND owner_department_id=?";
      await tx.prepare(`
        DELETE FROM audit_events
        WHERE (entity_type IN ('department','departments') AND entity_id=?)
          OR (entity_type='scopes' AND entity_id LIKE ('%/' || ? || '/' || ?))
          OR (entity_type='risk_indicator' AND entity_id IN (${ownedRisks}))
          OR (entity_type='risk_measurement' AND entity_id IN (
            SELECT id FROM risk_measurements WHERE risk_id IN (${ownedRisks})
          ))
      `).run(id, programId, id, programId, id, programId, id);
      const readings = await tx.prepare(`DELETE FROM risk_measurements WHERE risk_id IN (${ownedRisks})`).run(programId, id);
      const indicators = await tx.prepare("DELETE FROM risk_indicators WHERE program_id=? AND owner_department_id=?").run(programId, id);
      await tx.prepare("DELETE FROM departments WHERE program_id=? AND id=?").run(programId, id);
      await audit(tx, req.user.id, "delete", "department", id, {
        measures, scopes: scopes.changes, riskIndicators: indicators.changes, riskMeasurements: readings.changes,
      }, null);
    });
    return finishDeletion(res);
  });
}
