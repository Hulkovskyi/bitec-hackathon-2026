import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createFirstAdministrator } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { fixture, seed } from "../src/seed.js";

test("an administrator manages unused departments within the selected program and preserves referenced departments", async (t) => {
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

  const protectedId = fixture.measures[0].departmentId;
  const blocked = await request(`${path}/${protectedId}`, "DELETE", { cookie });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "department_in_use");
  assert.ok(db.prepare("SELECT 1 FROM departments WHERE id=?").get(protectedId));
  assert.equal((await request(`${path}/${department.id}`, "DELETE", { cookie })).status, 204);
  assert.equal(db.prepare("SELECT 1 FROM departments WHERE id=?").get(department.id), undefined);

  const events = db.prepare("SELECT actor_id,action,before_json,after_json FROM audit_events WHERE entity_type='department' AND entity_id=? ORDER BY rowid").all(department.id);
  assert.deepEqual(events.map(({ actor_id, action }) => [actor_id, action]), [
    [admin.id, "create"], [admin.id, "update"], [admin.id, "delete"],
  ]);
  assert.equal(JSON.parse(events[1].before_json).code, data.code);
  assert.equal(JSON.parse(events[2].before_json).code, updated.code);
  assert.equal(events[2].after_json, null);
});
