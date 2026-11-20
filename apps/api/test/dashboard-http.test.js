import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createFirstAdministrator } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { kyivDate } from "../src/registry.js";
import { fixture, seed } from "../src/seed.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "http://127.0.0.1:3001";
const program = id(1);
const department = id(101);
const start = "2026-01-01";
const date = "2026-11-17";
const timestamp = `${date}T10:00:00.000Z`;

function measure(n, code, overrides = {}) {
  return {
    ...fixture.measures[0],
    id: id(n),
    code,
    title: `Синтетичний захід ${code}`,
    plannedDate: "2026-11-10",
    effectiveFrom: start,
    ...overrides,
  };
}

async function setup(t, measures, today = () => date, evidenceStore) {
  const directory = await mkdtemp(join(tmpdir(), "dacm-dashboard-http-"));
  const db = new DatabaseSync(":memory:");
  let server;
  t.after(async () => {
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  migrate(db);
  await seed(db, { demoMode: true, manifest: { ...fixture, measures } });
  server = createApp(db, { demoMode: true, today, evidenceDirectory: directory, evidenceStore }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { method = "GET", body, cookie } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
      headers: response.headers,
    };
  }
  async function login(n) {
    const response = await request("/demo/session", { method: "POST", body: { userId: id(n) } });
    checked(response, 201);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return (path, options = {}) => request(path, { ...options, cookie });
  }
  return { db, directory, login, request };
}

function checked(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

function result(db, n, plan, {
  status = "approved", outcome = "completed", period = "once",
  measured = 100, resultDate = "2026-11-09", executorId = plan.executorId,
  description = "Синтетичний результат",
} = {}) {
  const resultId = id(n);
  db.prepare(
    `INSERT INTO results (
      id, measure_id, period_key, revision, executor_id, status, outcome, description,
      non_completion_reason, result_date, actual_date, measured_value, version,
      submitted_at, approved_at, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(resultId, plan.id, period, executorId, status, outcome, description,
    outcome === "completed" || outcome === null ? null : "Синтетична причина",
    resultDate, outcome === "completed" || outcome === "partial" ? resultDate : null,
    measured, status === "draft" ? null : timestamp, status === "approved" ? timestamp : null,
    timestamp, timestamp);
  return resultId;
}

async function evidence(db, directory, n, resultId, executorId, { damaged = false } = {}) {
  const storageKey = id(n + 1000);
  const content = "Синтетичний файл";
  const sha256 = createHash("sha256").update(content).digest("hex");
  await writeFile(join(directory, storageKey), damaged ? content + " змінено" : content);
  db.prepare(
    `INSERT INTO evidence_versions
      (id, result_id, logical_file_id, revision, original_name, storage_key,
       media_type, byte_size, sha256, uploaded_by, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 'text/plain', ?, ?, ?, ?)`,
  ).run(id(n), resultId, id(n), "synthetic.txt", storageKey, Buffer.byteLength(content), sha256,
    executorId, timestamp);
}

const url = (path, params = {}) => `${path}?${new URLSearchParams({ programId: program, ...params })}`;
const sorted = (items, key) => items.map(key).sort();
const pair = ({ measureId, periodKey }) => `${measureId}:${periodKey}`;
const label = ({ code, periodKey }) => `${code}:${periodKey}`;
const flag = (item) => `${label(item)}:${item.ruleCode}`;

async function pages(request, path, params, total, key, invariants = {}) {
  const pageSize = 2;
  const count = Math.ceil(total / pageSize);
  const responses = await Promise.all(Array.from({ length: count + 1 }, (_, i) =>
    request(url(path, { ...params, pageSize, page: i + 1 }))));
  const items = responses.flatMap((response, i) => {
    const data = checked(response);
    assert.equal(data.total, total);
    assert.equal(data.page, i + 1);
    assert.equal(data.pageSize, pageSize);
    assert.equal(data.items.length, Math.max(0, Math.min(pageSize, total - i * pageSize)));
    for (const [name, value] of Object.entries(invariants)) assert.deepEqual(data[name], value);
    return data.items;
  });
  const full = checked(await request(url(path, params)));
  assert.deepEqual(items.map(key), full.items.map(key));
  assert.equal(new Set(items.map(key)).size, total);
  return items;
}

test("deadline and indicator filters avoid evidence I/O and overdue pages match the dashboard", async (t) => {
  const partial = measure(501, "A");
  const late = measure(502, "B");
  const due = measure(503, "C", { plannedDate: "2026-11-20" });
  const completed = measure(504, "D");
  const otherDepartment = measure(505, "X", { departmentId: id(102), executorId: id(203) });
  const calls = [];
  const store = {
    integrity(file) {
      calls.push(file.id);
      throw Object.assign(new Error("Synthetic evidence read failure"), { code: "EIO" });
    },
  };
  const { db, directory, login } = await setup(
    t, [partial, late, due, completed, otherDepartment], () => date, store,
  );
  await evidence(db, directory, 701,
    result(db, 601, partial, { outcome: "partial", measured: 40 }), partial.executorId);
  await evidence(db, directory, 704,
    result(db, 604, completed, { measured: 0 }), completed.executorId);
  await evidence(db, directory, 705,
    result(db, 605, otherDepartment, { outcome: "partial", measured: 30 }), otherDepartment.executorId);

  const coordinator = await login(205);
  const overduePairs = [];
  for (const page of [1, 2, 3]) {
    const [flags, dashboard] = await Promise.all([
      coordinator(url("/risk-flags", { ruleCode: "overdue", page, pageSize: 1 })),
      coordinator(url("/dashboard", { metric: "overdue", page, pageSize: 1 })),
    ]).then((responses) => responses.map((response) => checked(response)));
    assert.equal(flags.total, 2);
    assert.equal(flags.total, dashboard.total);
    assert.equal(flags.total, dashboard.counts.overdue);
    assert.equal(flags.page, page);
    assert.equal(flags.pageSize, 1);
    assert.deepEqual(flags.items.map(pair), dashboard.items.map(pair));
    overduePairs.push(...flags.items.map(label));
  }
  assert.deepEqual(overduePairs, ["A:once", "B:once"]);

  for (const [ruleCode, expected] of [
    ["due_soon", ["C:once"]],
    ["target_not_met", ["A:once", "D:once"]],
    ["closed_without_improvement", ["D:once"]],
  ]) {
    const data = checked(await coordinator(url("/risk-flags", { ruleCode })));
    assert.deepEqual(data.items.map(label), expected);
  }
  assert.deepEqual(calls, []);

  const missing = checked(await coordinator(url("/risk-flags", { ruleCode: "missing_evidence" })));
  assert.deepEqual(missing.items.map(label), ["A:once", "D:once"]);
  assert.ok(missing.items.every(({ sourceValues }) => sourceValues.issue === "integrity_failed"));
  assert.deepEqual(calls.sort(), [id(701), id(704)]);
  const unfiltered = checked(await coordinator(url("/risk-flags")));
  assert.deepEqual(unfiltered.items.filter(({ ruleCode }) => ruleCode === "overdue").map(label), overduePairs);
});

test("dashboard counts and pages share scoped period pairs and expose the A–G risk flags", async (t) => {
  const a = measure(501, "A");
  const b = measure(502, "B");
  const c = measure(503, "C", { plannedDate: "2026-11-20" });
  const d = measure(504, "D", { plannedDate: date });
  const e = measure(505, "E", { scheduleType: "continuous", plannedDate: null });
  const f = measure(506, "F", { indicator: { ...a.indicator, baseline: 10, target: 20 } });
  const g = measure(507, "G", { plannedDate: "2026-12-01" });
  const localX = measure(508, "X-department", { departmentId: id(102), executorId: id(203) });
  const foreignX = measure(509, "X-program", {
    sectionId: id(21), departmentId: id(103), executorId: id(204),
  });
  const { db, directory, login } = await setup(t, [a, b, c, d, e, f, g, localX, foreignX]);

  const approved = [
    result(db, 601, a),
    result(db, 602, b, { outcome: "partial", measured: 50 }),
    result(db, 605, e, { period: "2026-H1", resultDate: "2026-06-30" }),
    result(db, 606, f, { measured: 10 }),
  ];
  for (const [index, resultId] of approved.entries())
    await evidence(db, directory, 701 + index, resultId, a.executorId);
  result(db, 603, c, { status: "draft", outcome: null, measured: null, resultDate: null });
  const pending = result(db, 607, g, {
    status: "submitted", outcome: "not_completed", measured: null, resultDate: date,
  });

  const coordinator = await login(205);
  const leader = await login(206);
  const otherDepartment = await login(203);
  const otherProgram = await login(204);
  const unassigned = await login(202);
  const counts = { measures: 7, completed: 2, overdue: 1, overdueMeasures: 1, dueSoon: 2, pendingReview: 1 };
  const dashboard = checked(await coordinator(url("/dashboard")));
  assert.deepEqual(dashboard.counts, counts);
  assert.equal(dashboard.completionRate, 2 / 7);
  assert.equal(dashboard.asOf, date);

  const expected = {
    measures: [[a, "once"], [b, "once"], [c, "once"], [d, "once"], [e, "2026-H2"], [f, "once"], [g, "once"]],
    completed: [[a, "once"], [f, "once"]],
    overdue: [[b, "once"]],
    overdueMeasures: [[b, "once"]],
    dueSoon: [[c, "once"], [d, "once"]],
    pendingReview: [[g, "once"]],
  };
  for (const [metric, values] of Object.entries(expected)) {
    const items = await pages(coordinator, "/dashboard", { metric }, counts[metric], pair, { counts });
    assert.deepEqual(sorted(items, pair), values.map(([plan, key]) => `${plan.id}:${key}`).sort(), metric);
    for (const item of items) {
      const [plan, key] = values.find(([plan]) => plan.id === item.measureId);
      assert.equal(item.code, plan.code);
      assert.equal(item.title, plan.title);
      assert.equal(item.deadline, key === "2026-H2" ? "2026-12-31" : plan.plannedDate);
    }
    if (metric === "pendingReview") assert.equal(items[0].resultId, pending);
    if (metric === "measures") assert.deepEqual(items.map(pair), dashboard.items.map(pair));
  }

  const flags = await pages(coordinator, "/risk-flags", {}, 7, flag, { asOf: date });
  assert.deepEqual(sorted(flags, flag), [
    "B:once:overdue", "B:once:target_not_met", "C:once:due_soon", "D:once:due_soon",
    "F:once:closed_without_improvement", "F:once:target_not_met", "G:once:missing_evidence",
  ]);
  assert.ok(flags.every(({ code, title, explanation, suggestedAction }) =>
    title === `Синтетичний захід ${code}` && explanation && suggestedAction));
  const byRule = Object.fromEntries(flags.map((item) => [flag(item), item]));
  assert.deepEqual(byRule["B:once:overdue"].sourceValues, { deadline: "2026-11-10", today: date, daysOverdue: 7 });
  assert.deepEqual(byRule["D:once:due_soon"].sourceValues, { deadline: date, today: date, daysRemaining: 0 });
  assert.deepEqual(byRule["G:once:missing_evidence"].sourceValues, { revision: 1, issue: "no_current_evidence" });
  assert.equal(byRule["G:once:missing_evidence"].resultId, pending);
  const targets = await pages(coordinator, "/risk-flags", { ruleCode: "target_not_met" }, 2, flag);
  assert.deepEqual(sorted(targets, pair), sorted(flags.filter((item) => item.ruleCode === "target_not_met"), pair));

  const lead = checked(await leader(url("/dashboard", { metric: "overdue" })));
  assert.deepEqual(lead.counts, { ...counts, measures: 8, overdue: 2, overdueMeasures: 2 });
  assert.deepEqual(sorted(lead.items, label), ["B:once", "X-department:once"]);
  const filtered = checked(await leader(url("/dashboard", { departmentId: department })));
  assert.deepEqual(filtered.counts, counts);
  const outside = checked(await otherDepartment(url("/risk-flags")));
  assert.deepEqual(outside.items.map(flag), ["X-department:once:overdue"]);
  const foreign = checked(await otherProgram(url("/risk-flags", { programId: id(2) })));
  assert.deepEqual(foreign.items.map(flag), ["X-program:once:overdue"]);
  const empty = checked(await unassigned(url("/dashboard")));
  assert.deepEqual(empty.counts, Object.fromEntries(Object.keys(counts).map((key) => [key, 0])));
  assert.equal(empty.completionRate, null);
  assert.deepEqual(empty.items, []);
});

test("dashboard and risk flags reject malformed filters without disclosing unknown or foreign scope", async (t) => {
  const { login, request } = await setup(t, [measure(501, "A")]);
  const coordinator = await login(205);
  const admin = await login(208);

  for (const path of ["/dashboard", "/risk-flags"]) {
    checked(await request(url(path)), 401);
    const bad = [
      path,
      url(path, { programId: "bad" }),
      url(path, { departmentId: "bad" }),
      url(path, { page: 0 }),
      url(path, { pageSize: 101 }),
      url(path, { today: date }),
      url(path) + `&programId=${program}`,
    ];
    for (const query of bad) checked(await coordinator(query), 400);
    const absent = checked(await coordinator(url(path, { programId: id(778) })), 404);
    assert.deepEqual(checked(await coordinator(url(path, { programId: id(2) })), 404), absent);
    for (const departmentId of [id(102), id(103), id(779)]) {
      assert.deepEqual(checked(await coordinator(url(path, { departmentId })), 404), absent);
    }
    checked(await admin(url(path, { departmentId: id(103) })), 404);
  }
  checked(await coordinator(url("/dashboard", { metric: "bad" })), 400);
  checked(await coordinator(url("/risk-flags", { ruleCode: "bad" })), 400);
});

test("Kyiv half-year rollover keeps overdue pairs and reassignment hides foreign result fields", async (t) => {
  const e = measure(505, "E", { scheduleType: "continuous", plannedDate: null });
  let now = "2026-06-30T20:59:59Z";
  const { db, directory, login } = await setup(t, [e], () => kyivDate(new Date(now)));
  const a = await login(201);
  const b = await login(202);
  const coordinator = await login(205);
  const startFlags = checked(await a(url("/risk-flags")));
  assert.equal(startFlags.asOf, "2026-06-30");
  assert.deepEqual(startFlags.items.map(flag), ["E:2026-H1:due_soon"]);
  const atDeadline = checked(await a(url("/dashboard", { metric: "dueSoon" })));
  assert.equal(atDeadline.counts.overdue, 0);
  assert.equal(atDeadline.counts.dueSoon, 1);
  assert.deepEqual(atDeadline.items.map(label), ["E:2026-H1"]);

  now = "2026-06-30T21:00:00Z";
  const rollover = checked(await a(url("/dashboard")));
  assert.equal(rollover.asOf, "2026-07-01");
  assert.deepEqual(rollover.items.map(label), ["E:2026-H2"]);
  assert.equal(rollover.counts.overdue, 1);
  assert.deepEqual(checked(await a(url("/risk-flags"))).items.map(flag), ["E:2026-H1:overdue"]);

  const previous = result(db, 615, e, {
    outcome: "partial", period: "2026-H2", measured: 42, resultDate: "2026-07-01",
    description: "Закритий синтетичний опис попереднього виконавця",
  });
  await evidence(db, directory, 715, previous, e.executorId, { damaged: true });
  const pending = result(db, 616, e, {
    status: "submitted", outcome: "not_completed", period: "2026-H1", measured: null, resultDate: "2026-06-30",
  });
  const assignment = checked(await coordinator(`/measures/${e.id}/assignment`, {
    method: "PUT",
    body: { periodKey: "2026-H2", executorId: id(202), version: 0 },
  }));
  assert.equal(assignment.executorId, id(202));
  checked(await b(`/results/${previous}`), 404);

  const current = checked(await b(url("/dashboard")));
  assert.deepEqual(current.items.map(label), ["E:2026-H2"]);
  assert.equal(current.counts.overdue, 0);
  for (const key of ["resultId", "resultStatus", "outcome", "reviewComment"])
    assert.equal(Object.hasOwn(current.items[0], key), false, key);
  assert.equal(checked(await b(url("/dashboard", { metric: "pendingReview" }))).total, 0);
  const readableQueue = checked(await a(url("/dashboard", { metric: "pendingReview" })));
  assert.deepEqual(readableQueue.items.map(({ periodKey, resultId }) => [periodKey, resultId]), [["2026-H1", pending]]);
  assert.deepEqual(checked(await b(url("/risk-flags"))).items, []);
  const teamFlags = checked(await coordinator(url("/risk-flags")));
  const h2Flags = teamFlags.items.filter(({ periodKey }) => periodKey === "2026-H2");
  assert.deepEqual(sorted(h2Flags, flag), ["E:2026-H2:missing_evidence", "E:2026-H2:target_not_met"]);
  assert.ok(h2Flags.every(({ resultId }) => resultId === previous));
  assert.equal(h2Flags.find(({ ruleCode }) => ruleCode === "missing_evidence").sourceValues.issue, "integrity_failed");
  assert.ok(checked(await a(url("/risk-flags"))).items.every(({ periodKey }) => periodKey === "2026-H1"));

  now = "2026-12-31T22:00:00Z";
  const scoped = checked(await coordinator(url("/dashboard", { metric: "overdue" })));
  assert.equal(scoped.asOf, "2027-01-01");
  assert.equal(scoped.counts.overdue, 2);
  assert.equal(scoped.counts.overdueMeasures, 1);
  assert.deepEqual(sorted(scoped.items, label), ["E:2026-H1", "E:2026-H2"]);
  const unique = checked(await coordinator(url("/dashboard", { metric: "overdueMeasures" })));
  assert.deepEqual(unique.items.map(label), ["E:2026-H1"]);
  assert.deepEqual(checked(await a(url("/dashboard", { metric: "overdue" }))).items.map(label), ["E:2026-H1"]);
  assert.deepEqual(checked(await b(url("/dashboard", { metric: "overdue" }))).items.map(label), ["E:2026-H2"]);
});

const decisionPath = "/risk-flag-decisions";
function overdueDecision(subjectId) {
  const key = { programId: program, source: "live", ruleCode: "overdue", subjectType: "measure", subjectId, periodKey: "once" };
  return {
    key,
    options: `${decisionPath}/assignees?${new URLSearchParams(key)}`,
    save: (session, patch) => session(decisionPath, {
      method: "PUT",
      body: { ...key, action: "Уточнити причину та подати результат", assigneeId: id(201), dueDate: date, version: 0, ...patch },
    }),
  };
}

test("risk flag decisions persist after the signal clears and track scoped, versioned changes", async (t) => {
  const local = measure(501, "A");
  const foreign = measure(502, "X", { departmentId: id(102), executorId: id(203) });
  const { db, login } = await setup(t, [local, foreign]);
  const coordinator = await login(205);
  const executor = await login(201);
  const analyst = await login(207);
  const leader = await login(206);
  const admin = await login(208);
  const localDecision = overdueDecision(local.id);
  const foreignDecision = overdueDecision(foreign.id);

  checked(await coordinator(foreignDecision.options), 404);
  checked(await analyst(localDecision.options), 403);
  checked(await executor(url(decisionPath)), 403);
  const { items, decision, signalVersion } = checked(await coordinator(localDecision.options));
  assert.equal(decision, null);
  assert.deepEqual(items.map(({ id }) => id).sort(), [201, 202, 205, 206, 207, 208].map(id));
  checked(await coordinator(localDecision.options.replace("overdue", "forged_rule")), 404);
  checked(await localDecision.save(coordinator, { signalVersion, assigneeId: id(203) }), 400);
  checked(await localDecision.save(coordinator, { signalVersion, assigneeId: id(209) }), 400);
  checked(await localDecision.save(coordinator, { signalVersion, dueDate: "2026-11-16" }), 400);
  checked(await localDecision.save(analyst, { signalVersion }), 403);

  const first = checked(await localDecision.save(coordinator, { signalVersion }));
  assert.equal(first.version, 1);
  assert.equal(first.decidedBy, id(205));
  assert.equal(first.assigneeName, "Виконавець А");
  assert.equal(first.signal.code, local.code);
  assert.equal(first.signal.title, local.title);
  assert.equal(first.signal.sourceValues.deadline, local.plannedDate);
  const duplicate = checked(await localDecision.save(coordinator, { signalVersion }), 409);
  assert.equal(duplicate.error.code, "version_conflict");

  db.prepare("UPDATE measures SET planned_date=? WHERE id=?").run("2026-11-11", local.id);
  const changed = checked(await localDecision.save(coordinator, { signalVersion, version: first.version }), 409);
  assert.equal(changed.error.code, "signal_changed");
  const refreshed = checked(await coordinator(localDecision.options));
  assert.deepEqual(refreshed.decision, first);
  const second = checked(await localDecision.save(coordinator, {
    signalVersion: refreshed.signalVersion, version: first.version, assigneeId: id(202),
  }));
  assert.equal(second.id, first.id);
  assert.equal(second.version, 2);
  assert.equal(second.signal.sourceValues.deadline, "2026-11-11");
  const events = db.prepare(`
    SELECT action, before_json, after_json FROM audit_events
    WHERE entity_type='risk_flag_decision' AND entity_id=? ORDER BY occurred_at
  `).all(first.id);
  assert.deepEqual(events.map(({ action }) => action), ["create_risk_flag_decision", "update_risk_flag_decision"]);
  assert.equal(events[0].before_json, null);
  assert.deepEqual(JSON.parse(events[1].before_json), first);
  assert.deepEqual(JSON.parse(events[1].after_json), second);

  const otherOptions = checked(await admin(foreignDecision.options));
  checked(await foreignDecision.save(admin, { signalVersion: otherOptions.signalVersion, assigneeId: id(203) }));
  const scoped = checked(await analyst(url(decisionPath)));
  assert.deepEqual(scoped, { items: [second], total: 1, page: 1, pageSize: 20, canDecide: false });
  assert.equal(checked(await leader(url(decisionPath, { pageSize: "1", page: "2" }))).total, 2);
  checked(await coordinator(url(decisionPath, { departmentId: id(102) })), 404);

  db.prepare("DELETE FROM user_scopes WHERE user_id=? AND department_id=?").run(id(205), department);
  checked(await localDecision.save(coordinator, { signalVersion: refreshed.signalVersion, version: second.version }), 404);
  db.prepare("UPDATE measures SET planned_date=? WHERE id=?").run("2026-12-01", local.id);
  checked(await admin(localDecision.options), 404);
  checked(await localDecision.save(admin, { signalVersion: refreshed.signalVersion, version: second.version }), 404);
  assert.deepEqual(checked(await analyst(url(decisionPath))).items, [second]);

  checked(await admin(`/measures/${local.id}`, { method: "DELETE", body: { version: 1 } }), 204);
  assert.deepEqual(checked(await analyst(url(decisionPath))).items, []);
  assert.equal(db.prepare("SELECT count(*) AS count FROM audit_events WHERE entity_id=?").get(first.id).count, 0);
});

test("role preview can inspect decisions while password sessions exclude seed-only assignees", async (t) => {
  const local = measure(501, "A");
  const { db, request } = await setup(t, [local]);
  const credentials = { username: "decision.admin", password: "synthetic-password" };
  const administrator = await createFirstAdministrator(db, {
    ...credentials, fullName: "Синтетичний адміністратор", department: "Підрозділ", position: "Адміністратор",
  });
  const login = await request("/auth/login", { method: "POST", body: credentials });
  assert.equal(checked(login, 201).userId, administrator.id);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const authenticated = (path, options = {}) => request(path, { ...options, cookie });
  const localDecision = overdueDecision(local.id);
  const options = checked(await authenticated(localDecision.options));
  assert.deepEqual(options.items.map(({ id }) => id), [administrator.id]);
  const saved = checked(await localDecision.save(authenticated, { signalVersion: options.signalVersion, assigneeId: administrator.id }));

  checked(await authenticated("/role-preview", { method: "PUT", body: { userId: id(205) } }), 204);
  const preview = checked(await authenticated(url(decisionPath)));
  assert.equal(preview.canDecide, false);
  assert.deepEqual(preview.items, [saved]);
  checked(await authenticated(localDecision.options), 403);
  checked(await localDecision.save(authenticated, {
    signalVersion: options.signalVersion, assigneeId: administrator.id, version: saved.version,
  }), 403);
  assert.equal(db.prepare("SELECT version FROM risk_flag_decisions WHERE id=?").get(saved.id).version, 1);
});
