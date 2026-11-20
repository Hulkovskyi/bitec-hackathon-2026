import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createFirstAdministrator } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { fixture, seed } from "../src/seed.js";

test("an administrator manages departments and atomically deletes linked records in the selected program", async (t) => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seed(db, { demoMode: true });
  const credentials = { username: "department.admin", password: "synthetic-department-admin" };
  const admin = await createFirstAdministrator(db, {
    ...credentials, fullName: "Тестовий адміністратор", department: "Адміністрація", position: "Адміністратор",
  });
  const server = createApp(db, { demoMode: true }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, method, { cookie, body } = {}) {
    return fetch(base + path, {
      method,
      headers: {
        Origin: "http://127.0.0.1:3001",
        ...(cookie && { Cookie: cookie }),
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
  }

  const programId = fixture.programs[0].id;
  const path = `/admin/programs/${programId}/departments`;
  const data = { code: "D-NEW", title: "Навчальний підрозділ" };
  assert.equal((await request(path, "POST", { body: data })).status, 401);
  const demo = await request("/demo/session", "POST", { body: { userId: fixture.users[0].id } });
  assert.equal(demo.status, 201);
  assert.equal((await request(path, "POST", { cookie: demo.headers.get("set-cookie").split(";")[0], body: data })).status, 403);

  const login = await request("/auth/login", "POST", { body: credentials });
  assert.equal(login.status, 201);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const creation = await request(path, "POST", { cookie, body: data });
  assert.equal(creation.status, 201);
  const department = await creation.json();
  assert.deepEqual(department, { ...data, id: department.id, programId });
  assert.equal((await request(path, "POST", { cookie, body: data })).status, 409);

  const updated = { code: "D-RENAMED", title: "Оновлений підрозділ" };
  const otherPath = `/admin/programs/${fixture.programs[1].id}/departments/${department.id}`;
  assert.equal((await request(otherPath, "PATCH", { cookie, body: updated })).status, 404);
  assert.equal((await request(otherPath, "DELETE", { cookie })).status, 404);
  const revision = await request(`${path}/${department.id}`, "PATCH", { cookie, body: updated });
  assert.equal(revision.status, 200);
  assert.deepEqual(await revision.json(), { ...updated, id: department.id, programId });

  const events = (id) => db.prepare(`
    SELECT actor_id,action,before_json,after_json FROM audit_events
    WHERE entity_type='department' AND entity_id=? ORDER BY rowid
  `).all(id);
  assert.deepEqual(events(department.id).map(({ actor_id, action }) => [actor_id, action]), [
    [admin.id, "create"], [admin.id, "update"],
  ]);
  assert.equal(JSON.parse(events(department.id)[1].before_json).code, data.code);
  assert.equal((await request(`${path}/${department.id}`, "DELETE", { cookie })).status, 204);
  assert.equal(db.prepare("SELECT 1 FROM departments WHERE id=?").get(department.id), undefined);
  assert.deepEqual(events(department.id).map(({ actor_id, action, before_json, after_json }) => ({
    actor_id, action, counts: JSON.parse(before_json), after_json,
  })), [{
    actor_id: admin.id, action: "delete", after_json: null,
    counts: { measures: 0, scopes: 0, riskIndicators: 0, riskMeasurements: 0 },
  }]);

  const affectedId = fixture.departments[0].id;
  const otherDepartmentId = fixture.departments[1].id;
  const movedMeasure = fixture.measures[2];
  const unrelatedMeasure = fixture.measures[3];
  const resultMeasure = fixture.measures[0];
  const riskId = fixture.risks[0].id;
  const riskPath = `/programs/${programId}/corruption-risks/${riskId}`;
  const passportPath = `/programs/${programId}/passport`;
  const passportBody = { goals: "Перевірити синтетичні заходи", coordinatorDepartmentId: affectedId };
  assert.equal((await request(passportPath, "PUT", { cookie, body: passportBody })).status, 200);
  assert.equal((await request(riskPath + "/indicator", "PUT", { cookie, body: {
    ownerDepartmentId: affectedId, title: "Індикатор ризику", unit: "%", direction: "decrease",
    baseline: 40, baselineDate: "2026-01-01", target: 20, targetDate: "2026-12-31",
  } })).status, 200);
  const reading = await request(riskPath + "/readings", "POST", { cookie, body: {
    readingDate: "2026-06-30", value: 26, source: "Навчальний звіт",
  } });
  assert.equal(reading.status, 201);
  const readingId = (await reading.json()).id;

  db.prepare(`
    INSERT INTO results (id, measure_id, period_key, revision, executor_id, created_at, updated_at)
    VALUES ('test-result', ?, 'once', 1, ?, '2026-11-17', '2026-11-17')
  `).run(resultMeasure.id, resultMeasure.executorId);
  db.prepare(`
    INSERT INTO official_dataset_batches (program_id, source_period, source_as_of, source_hash, imported_at)
    VALUES (?, '2026-H1', '2026-07-06', ?, '2026-07-06')
  `).run(programId, "a".repeat(64));
  db.prepare(`
    INSERT INTO official_measure_metadata (
      measure_id, program_id, section_order, plan_text, source_schedule_type, source_title, source_department_id,
      source_department_title, source_section_code, indicator_title, expected_evidence, resources
    ) VALUES (?, ?, 1, 'Навчальний план', 'continuous', 'Архівний захід', ?, 'Навчальний підрозділ', 3, 'Індикатор', '', '')
  `).run(movedMeasure.id, programId, affectedId);

  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, after_json, occurred_at)
    VALUES ('imported-dept-audit', ?, 'import_create', 'departments', ?, '{"title":"Навчальний підрозділ"}', '2026-11-17')
  `).run(admin.id, affectedId);
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, after_json, occurred_at)
    VALUES ('imported-scope-audit', ?, 'import_create', 'scopes', ?, '{}', '2026-11-17')
  `).run(admin.id, `${resultMeasure.executorId}/${programId}/${affectedId}`);

  const affectedPath = `${path}/${affectedId}`;
  assert.equal((await request(affectedPath, "DELETE", { cookie: demo.headers.get("set-cookie").split(";")[0] })).status, 403);
  db.exec(`
    CREATE TRIGGER fail_department_audit BEFORE INSERT ON audit_events
    WHEN NEW.entity_type='department' AND NEW.action='delete'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
  `);
  assert.equal((await request(affectedPath, "DELETE", { cookie })).status, 500);
  assert.ok(db.prepare("SELECT 1 FROM departments WHERE id=?").get(affectedId));
  assert.ok(db.prepare("SELECT 1 FROM results WHERE id='test-result'").get());
  assert.ok(db.prepare("SELECT 1 FROM official_measure_metadata WHERE measure_id=?").get(movedMeasure.id));
  assert.ok(db.prepare("SELECT 1 FROM risk_measurements WHERE id=?").get(readingId));
  assert.equal(db.prepare("SELECT coordinator_department_id FROM program_passports WHERE program_id=?").get(programId).coordinator_department_id, affectedId);
  db.exec("DROP TRIGGER fail_department_audit");

  assert.equal((await request(affectedPath, "DELETE", { cookie })).status, 204);
  assert.equal((await request(affectedPath, "DELETE", { cookie })).status, 404);
  assert.equal(db.prepare("SELECT 1 FROM departments WHERE id=?").get(affectedId), undefined);
  assert.ok(db.prepare("SELECT 1 FROM departments WHERE id=?").get(otherDepartmentId));
  assert.equal(db.prepare("SELECT 1 FROM user_scopes WHERE department_id=?").get(affectedId), undefined);
  assert.ok(db.prepare("SELECT 1 FROM user_scopes WHERE department_id=?").get(otherDepartmentId));
  assert.ok(db.prepare("SELECT 1 FROM users WHERE id=?").get(resultMeasure.executorId));
  assert.ok(db.prepare("SELECT 1 FROM measures WHERE id=?").get(unrelatedMeasure.id));
  assert.equal(db.prepare("SELECT 1 FROM measures WHERE id=?").get(resultMeasure.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM measures WHERE id=?").get(movedMeasure.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM results WHERE id='test-result'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM official_measure_metadata WHERE measure_id=?").get(movedMeasure.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM risk_indicators WHERE risk_id=?").get(riskId), undefined);
  assert.equal(db.prepare("SELECT 1 FROM risk_measurements WHERE id=?").get(readingId), undefined);
  assert.ok(db.prepare("SELECT 1 FROM risks WHERE id=?").get(riskId));
  assert.equal(db.prepare("SELECT 1 FROM audit_events WHERE entity_id IN (?, ?) AND entity_type IN ('risk_indicator','risk_measurement')").get(riskId, readingId), undefined);
  const passport = await (await request(passportPath, "GET", { cookie })).json();
  assert.equal(passport.goals, passportBody.goals);
  assert.equal(passport.coordinatorDepartmentId, null);
  assert.equal(db.prepare("SELECT 1 FROM audit_events WHERE id IN ('imported-dept-audit', 'imported-scope-audit')").get(), undefined);
  assert.equal(events(affectedId).length, 1);
  assert.equal(JSON.parse(events(affectedId)[0].before_json).measures, 3);
});
