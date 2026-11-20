import { randomUUID } from "node:crypto";
import { verifyAdministrator } from "./account-admin.js";
import { audit, missing, programAllowed } from "./registry.js";
import { ApiError, keys, text, uuid } from "./validation.js";

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

export function mountDepartmentAdminRoutes(app, db) {
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
      const before = await findDepartment(tx, programId, id);
      try {
        await tx.prepare("DELETE FROM departments WHERE program_id=? AND id=?").run(programId, id);
      } catch (error) {
        if (["23001", "23503"].includes(error.code) || error.errcode === 787 ||
            (error.errcode === 1811 && error.message === "FOREIGN KEY constraint failed")) {
          throw new ApiError(409, "department_in_use", "Підрозділ пов’язаний із заходами, доступами або історичними записами.");
        }
        throw error;
      }
      await audit(tx, req.user.id, "delete", "department", id, before, null);
    });
    res.status(204).end();
  });
}
