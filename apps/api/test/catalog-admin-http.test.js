import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createFirstAdministrator } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";

test("catalog CRUD preserves linked records, three report sections, and administrator access", async (t) => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const admin = { username: "catalog.admin", password: "synthetic-catalog-admin" };
  const actor = await createFirstAdministrator(db, {
    ...admin, fullName: "Адміністратор тесту", department: "Навчальний підрозділ", position: "Адміністратор",
  });
  const origin = "http://localhost:3001";
  const app = createApp(db);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  let cookie;
  async function call(path, method = "GET", body) {
    return fetch(base + path, {
      method,
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const program = { title: "Синтетична програма", code: "QA-CATALOG", periodStart: "2026-01-01", periodEnd: "2027-12-31" };
  assert.equal((await call("/admin/programs", "POST", program)).status, 401);
  const session = await call("/auth/login", "POST", admin);
  assert.equal(session.status, 201);
  cookie = session.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("/admin/programs", "POST", { ...program, periodEnd: "2025-12-31" })).status, 400);
  const created = await call("/admin/programs", "POST", program);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const path = "/admin/programs/" + id;
  assert.deepEqual(db.prepare("SELECT code FROM sections WHERE program_id=? ORDER BY code").all(id).map((row) => row.code), [1, 2, 3]);
  assert.equal((await call("/admin/programs", "POST", program)).status, 409);
  assert.equal((await call(path, "PATCH", { ...program, title: "Оновлена програма" })).status, 200);
  assert.equal((await call("/programs/" + id + "/passport", "PUT", { goals: "Синтетична перевірка" })).status, 200);
  assert.equal((await call(path, "DELETE")).status, 409);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sections WHERE program_id=?").get(id).n, 3);
  assert.equal((await call(path + "/passport", "DELETE")).status, 204);
  assert.equal((await (await call("/programs/" + id + "/passport")).json()).goals, "");

  const added = await call(path + "/risks", "POST", { code: "QA-RISK", title: "Синтетичний ризик" });
  assert.equal(added.status, 201);
  const risk = await added.json();
  const riskPath = path + "/risks/" + risk.id;
  assert.equal((await call(riskPath, "PATCH", { code: "QA-RISK", title: "Оновлений ризик" })).status, 200);
  assert.equal((await call(path, "DELETE")).status, 409);
  assert.equal((await call(riskPath, "DELETE")).status, 204);
  assert.equal((await call(riskPath, "DELETE")).status, 404);
  assert.equal((await call(path, "DELETE")).status, 204);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sections WHERE program_id=?").get(id).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE actor_id=? AND action='delete'").get(actor.id).n, 3);
});
