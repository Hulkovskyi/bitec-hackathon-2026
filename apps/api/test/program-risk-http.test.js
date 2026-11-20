import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { seed } from "../src/seed.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "http://127.0.0.1:3001";
const program = "/programs/" + id(1);
const risks = program + "/corruption-risks";
const risk = risks + "/" + id(401);
const indicator = {
  ownerDepartmentId: id(101),
  title: "Частка синтетичних прострочень",
  unit: "%",
  direction: "decrease",
  baseline: 40,
  baselineDate: "2025-12-31",
  target: 10,
  targetDate: "2026-12-31",
  description: "Окремий вимір стану синтетичного ризику.",
  likelihood: 3,
  impact: 4,
};

async function setup(t) {
  const db = new DatabaseSync(":memory:");
  const directory = await mkdtemp(join(tmpdir(), "dacm-program-risk-"));
  migrate(db);
  await seed(db, { demoMode: true });
  const server = createApp(db, {
    demoMode: true, today: () => "2026-11-20", evidenceDirectory: directory,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  async function request(path, { method = "GET", body, cookie, expected = 200 } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie && { Cookie: cookie }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return { data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  async function login(n) {
    const { cookie } = await request("/demo/session", {
      method: "POST", body: { userId: id(n) }, expected: 201,
    });
    return async (path, options = {}) => (await request(path, { ...options, cookie })).data;
  }
  return { db, login, request };
}

test("migration 003 upgrades an existing stage 2 program and leaves its prior plan intact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    for (const [version, name] of [[1, "001_registry.sql"], [2, "002_result_workflow.sql"]]) {
      db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, "2026-11-20");
    }
    db.prepare("INSERT INTO programs VALUES (?,?,?,?,?)").run(
      id(1), "UPGRADE", "Синтетична програма", "2026-01-01", "2026-12-31",
    );
    db.prepare("INSERT INTO risks VALUES (?,?,?,?)").run(id(401), id(1), "R-1", "Синтетичний ризик");
    migrate(db);
    migrate(db);
    assert.equal(db.prepare("SELECT title FROM programs WHERE id=?").get(id(1)).title, "Синтетична програма");
    assert.equal(db.prepare("SELECT title FROM risks WHERE id=?").get(id(401)).title, "Синтетичний ризик");
    assert.equal(db.prepare("SELECT count(*) AS n FROM program_passports").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM risk_measurements").get().n, 0);
  } finally {
    db.close();
  }
});

test("passport supplies scoped section counts and logs changes to program goals", async (t) => {
  const { db, login, request } = await setup(t);
  const coordinator = await login(205);
  const executor = await login(201);
  const admin = await login(208);
  const path = program + "/passport";
  await request(path, { expected: 401 });
  const original = await executor(path);
  assert.equal(original.goals, "");
  assert.equal(original.canEdit, false);
  const goals = "Перевіряти стан синтетичних заходів.";
  await coordinator(path, { method: "PUT", body: { goals }, expected: 403 });
  await admin(path, { method: "PUT", body: { goals, coordinatorDepartmentId: id(103) }, expected: 400 });
  const saved = await admin(path, {
    method: "PUT",
    body: { goals, organization: "Синтетична організація", coordinatorDepartmentId: id(101), restrictedInformation: true },
  });
  assert.equal(saved.canEdit, true);
  assert.equal(saved.goals, goals);
  assert.equal(saved.coordinatorDepartmentTitle, "Навчальний підрозділ 1");
  assert.equal(saved.restrictedInformation, true);
  const counts = ({ sections }) => sections.map(({ measureCount }) => measureCount);
  assert.deepEqual(counts(saved), [1, 1, 1]);
  assert.deepEqual(counts(await coordinator(path)), [1, 1, 0]);
  assert.deepEqual(counts(await executor(path)), [1, 0, 0]);
  await executor("/programs/" + id(2) + "/passport", { expected: 404 });
  const logged = db.prepare("SELECT actor_id, after_json FROM audit_events WHERE entity_type='program_passport'").get();
  assert.equal(logged.actor_id, id(208));
  assert.equal(JSON.parse(logged.after_json).goals, goals);
});

test("risk observation scope, immutable dates, and source audit are independent from planned measure indicators", async (t) => {
  const { db, login } = await setup(t);
  const coordinator = await login(205);
  const leader = await login(206);
  const executor = await login(201);
  const admin = await login(208);
  const read = { readingDate: "2026-06-30", value: 26, source: "Синтетичний звіт" };
  await executor(risks, { expected: 403 });
  await coordinator("/programs/" + id(2) + "/corruption-risks", { expected: 404 });
  assert.equal((await coordinator(risks)).items[0].indicator, null);
  await admin(risk + "/readings", { method: "POST", body: read, expected: 409 });
  await coordinator(risk + "/indicator", { method: "PUT", body: indicator, expected: 403 });
  await admin(risk + "/indicator", {
    method: "PUT", body: { ...indicator, ownerDepartmentId: id(103) }, expected: 400,
  });
  await admin(risk + "/indicator", { method: "PUT", body: { ...indicator, ownerDepartmentId: id(102) } });
  assert.equal((await coordinator(risks)).items[0].canMeasure, false);
  await coordinator(risk + "/readings", { method: "POST", body: read, expected: 404 });
  await admin(risk + "/indicator", { method: "PUT", body: indicator });
  await leader(risk + "/readings", { method: "POST", body: read, expected: 403 });
  await coordinator(risk + "/readings", {
    method: "POST", body: { ...read, readingDate: "2026-11-21" }, expected: 400,
  });
  const created = await coordinator(risk + "/readings", { method: "POST", body: read, expected: 201 });
  assert.deepEqual({ ...created, id: null }, { ...read, id: null });
  await coordinator(risk + "/readings", { method: "POST", body: read, expected: 409 });
  const { items } = await leader(risks);
  assert.equal(items[0].canMeasure, false);
  assert.equal(items[0].level, "critical");
  assert.equal(items[0].score, 12);
  assert.equal(items[0].indicator.baseline, 40);
  assert.deepEqual(items[0].latestReading, created);
  assert.deepEqual(items[0].readings, [created]);
  await admin(risk + "/indicator", {
    method: "PUT", body: { ...indicator, baseline: 42 }, expected: 409,
  });
  const logged = db.prepare("SELECT actor_id, after_json FROM audit_events WHERE entity_type='risk_measurement'").all();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].actor_id, id(205));
  assert.equal(JSON.parse(logged[0].after_json).value, 26);
  assert.equal(db.prepare("SELECT baseline FROM indicators WHERE measure_id=?").get(id(502)).baseline, 10);
});
