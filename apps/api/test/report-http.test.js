import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { fixture, seed } from "../src/seed.js";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const origin = "http://127.0.0.1:3001";
const programId = id(1);
const timestamp = "2026-11-17T12:00:00.000Z";
const sectionTitles = [
  "Заходи з реалізації засад загальної відомчої політики, виконання антикорупційної стратегії та державної антикорупційної програми",
  "Заходи з усунення корупційних ризиків",
  "Навчання та заходи з поширення антикорупційної інформації",
];

function measure(number, code, overrides = {}) {
  return {
    ...fixture.measures[0],
    id: id(number),
    code,
    title: `Синтетичний захід ${code}`,
    plannedDate: "2026-06-25",
    ...overrides,
  };
}

function snapshot(plan, overrides = {}) {
  const section = fixture.sections.find(({ id }) => id === plan.sectionId);
  const department = fixture.departments.find(({ id }) => id === plan.departmentId);
  return {
    programId: section.programId,
    sectionId: section.id,
    sectionCode: section.code,
    sectionTitle: section.title,
    departmentId: department.id,
    departmentCode: department.code,
    departmentTitle: department.title,
    code: plan.code,
    title: plan.title,
    description: plan.description,
    scheduleType: plan.scheduleType,
    plannedDate: plan.plannedDate,
    effectiveFrom: plan.effectiveFrom,
    indicator: plan.indicator,
    ...overrides,
  };
}

function result(db, number, plan, {
  periodKey = "once", revision = 1, supersedesId = null,
  status = "approved", outcome = "completed", resultDate = "2026-06-20",
  measuredValue = 100, description = "Синтетичний погоджений результат",
  nonCompletionReason = outcome === "completed" ? null : "Синтетична причина невиконання",
  approvedAt = timestamp, planSnapshot = snapshot(plan),
} = {}) {
  const resultId = id(number);
  db.prepare(`
    INSERT INTO results (
      id, measure_id, period_key, revision, supersedes_id, executor_id,
      plan_snapshot_json, status, outcome, description, non_completion_reason,
      result_date, actual_date, measured_value, version, submitted_at,
      approved_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    resultId, plan.id, periodKey, revision, supersedesId, plan.executorId,
    JSON.stringify(planSnapshot), status, outcome, description, nonCompletionReason,
    resultDate, ["completed", "partial"].includes(outcome) ? resultDate : null,
    measuredValue, status === "draft" ? null : timestamp,
    status === "approved" ? approvedAt : null, timestamp, timestamp,
  );
  return resultId;
}

async function setup(t, measures, today = () => "2026-11-17") {
  const directory = await mkdtemp(join(tmpdir(), "dacm-report-http-"));
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
  server = createApp(db, { demoMode: true, today, evidenceDirectory: directory }).listen(0, "127.0.0.1");
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
    const text = await response.text();
    const data = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
    return { status: response.status, data, text, headers: response.headers };
  }
  async function login(number) {
    const response = await request("/demo/session", { method: "POST", body: { userId: id(number) } });
    checked(response, 201);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return (path, options = {}) => request(path, { ...options, cookie });
  }
  return { db, login, request };
}

function checked(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

const reportUrl = (half = 1, extra = {}) => `/reports/half-year?${new URLSearchParams({
  programId, year: "2026", half: String(half), ...extra,
})}`;
const rows = (report) => report.sections.flatMap(({ rows }) => rows);
const rowFor = (report, measureId) => rows(report).find((row) => row.measureId === measureId);

function parseCsv(text) {
  const parsed = [];
  let record = [];
  let value = "";
  let quoted = false;
  const csv = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && character === ",") {
      record.push(value);
      value = "";
    } else if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      record.push(value);
      parsed.push(record);
      record = [];
      value = "";
    } else value += character;
  }
  if (record.length || value) parsed.push([...record, value]);
  assert.equal(quoted, false, "CSV must close quoted fields");
  return parsed;
}

test("half-year report preserves W3 history and carries incomplete once results forward", async (t) => {
  const continued = measure(501, "W3");
  const carried = measure(502, "CARRY");
  const { db, login } = await setup(t, [continued, carried]);
  const firstId = result(db, 601, continued, { outcome: "partial", measuredValue: 40 });
  const secondId = result(db, 602, continued, {
    revision: 2, supersedesId: firstId, resultDate: "2026-07-20", measuredValue: 100,
  });
  const carriedId = result(db, 603, carried, {
    outcome: "not_completed", resultDate: "2026-06-21", measuredValue: null,
  });
  result(db, 604, carried, {
    status: "draft", outcome: null, revision: 2, supersedesId: carriedId,
    resultDate: null, measuredValue: null,
  });
  const coordinator = await login(205);
  const h1 = checked(await coordinator(reportUrl(1)));
  const h2 = checked(await coordinator(reportUrl(2)));
  const h1Continued = rowFor(h1, continued.id);
  const h2Continued = rowFor(h2, continued.id);
  assert.equal(h1Continued.resultId, firstId);
  assert.equal(h1Continued.resultRevision, 1);
  assert.equal(h1Continued.executionState, "partial");
  assert.equal(h1Continued.indicator.actual, 40);
  assert.equal(h2Continued.resultId, secondId);
  assert.equal(h2Continued.resultRevision, 2);
  assert.equal(h2Continued.executionState, "completed");
  const h2Carried = rowFor(h2, carried.id);
  assert.equal(h2Carried.resultId, carriedId);
  assert.equal(h2Carried.resultDate, "2026-06-21");
  assert.equal(h2Carried.executionState, "not_completed");
  assert.equal(h2Carried.carriedForward, true);
  assert.equal(h2Carried.actualDate, null);
  assert.equal(h2Carried.indicator.actual, null);
  assert.match(h2Carried.resultDescription, /Синтетична причина невиконання/);
  assert.equal(h2.summary.total, 2);
  assert.equal(h2.summary.counts.completed, 1);
  assert.equal(h2.summary.counts.not_completed, 1);
  assert.equal(h2.summary.completionRate, 0.5);
  assert.deepEqual(h2.summary.problemRows.map(({ measureId }) => measureId), [carried.id]);
});

test("W5 effective start and W6 early completion place measures in the right half-year", async (t) => {
  const newContinuous = measure(501, "W5", {
    scheduleType: "continuous", plannedDate: null, effectiveFrom: "2026-07-15",
  });
  const early = measure(502, "W6", { plannedDate: "2026-07-20", effectiveFrom: "2026-06-01" });
  const { db, login } = await setup(t, [newContinuous, early]);
  const earlyId = result(db, 601, early, { resultDate: "2026-06-20" });
  const coordinator = await login(205);
  const h1 = checked(await coordinator(reportUrl(1)));
  const h2 = checked(await coordinator(reportUrl(2)));
  assert.equal(rowFor(h1, newContinuous.id), undefined);
  assert.equal(rowFor(h1, early.id).resultId, earlyId);
  assert.equal(rowFor(h1, early.id).actualDate, "2026-06-20");
  assert.equal(rowFor(h2, early.id), undefined);
  assert.equal(rowFor(h2, newContinuous.id).periodKey, "2026-H2");
  assert.equal(rowFor(h2, newContinuous.id).executionState, "not_due");
});

test("continuous results use the exact half-year and late approvals remain in their result period", async (t) => {
  const continuous = measure(501, "CONT", { scheduleType: "continuous", plannedDate: null });
  const late = measure(502, "LATE");
  const { db, login } = await setup(t, [continuous, late]);
  const h1Id = result(db, 601, continuous, {
    periodKey: "2026-H1", resultDate: "2026-06-15", approvedAt: "2026-07-12T12:00:00.000Z",
  });
  result(db, 602, continuous, {
    periodKey: "2026-H2", status: "submitted", outcome: "partial",
    resultDate: "2026-11-01", measuredValue: 30,
  });
  const lateId = result(db, 603, late, {
    resultDate: "2026-06-20", approvedAt: "2026-07-12T12:00:00.000Z",
  });
  const coordinator = await login(205);
  const h1 = checked(await coordinator(reportUrl(1)));
  const h2 = checked(await coordinator(reportUrl(2)));
  const h1Row = rowFor(h1, continuous.id);
  assert.equal(h1Row.resultId, h1Id);
  assert.equal(h1Row.actualDate, "2026-06-30");
  assert.equal(h1Row.executionState, "completed");
  assert.equal(rowFor(h1, late.id).resultId, lateId);
  const h2Row = rowFor(h2, continuous.id);
  assert.equal(h2Row.resultId, null);
  assert.equal(h2Row.actualDate, null);
  assert.equal(h2Row.indicator.actual, null);
  assert.equal(h2Row.reviewStatus, "submitted");
  assert.equal(h2Row.executionState, "not_due");
  assert.equal(rowFor(h2, late.id), undefined);
  assert.equal(h1.period.cutoff, "2026-06-30");
  assert.equal(h2.period.cutoff, "2026-11-17");
  assert.ok(Date.parse(h1.generatedAt));
  assert.ok(Date.parse(h1.dataAsOf));
});

test("missing approvals distinguish future deadlines from due records and preserve all three groups", async (t) => {
  const future = measure(501, "FUTURE", { plannedDate: "2026-11-20" });
  const today = measure(502, "TODAY", { plannedDate: "2026-11-17" });
  const overdue = measure(503, "OVERDUE", { plannedDate: "2026-11-10" });
  const { db, login } = await setup(t, [future, today, overdue]);
  result(db, 601, overdue, {
    status: "returned", outcome: "partial", resultDate: "2026-11-09", measuredValue: 50,
  });
  const coordinator = await login(205);
  const report = checked(await coordinator(reportUrl(2)));
  assert.deepEqual(report.sections.map(({ code }) => code), [1, 2, 3]);
  assert.deepEqual(report.sections.map(({ title }) => title), sectionTitles);
  assert.equal(report.sections[1].rows.length, 0);
  assert.equal(report.sections[2].rows.length, 0);
  assert.equal(rowFor(report, future.id).executionState, "not_due");
  assert.equal(rowFor(report, today.id).executionState, "not_approved");
  assert.equal(rowFor(report, overdue.id).executionState, "not_approved");
  assert.equal(rowFor(report, overdue.id).reviewStatus, "returned");
  for (const row of rows(report)) {
    assert.equal(row.resultId, null);
    assert.equal(row.resultRevision, null);
    assert.equal(row.resultDate, null);
    assert.equal(row.actualDate, null);
    assert.equal(row.indicator.actual, null);
    assert.equal(row.indicator.targetReached, null);
    assert.equal(row.resultDescription, "Погоджений результат відсутній");
  }
  assert.deepEqual(report.summary.counts, {
    completed: 0, partial: 0, not_completed: 0, not_due: 1, not_approved: 2,
  });
  const csv = checked(await coordinator(reportUrl(2, { format: "csv" })));
  for (const row of parseCsv(csv).slice(1)) {
    assert.deepEqual(row.slice(-5), [future.indicator.unit, "0", "100", "", ""]);
  }
});

test("a future half-year shows plans without copying approved outcomes into them", async (t) => {
  const partial = measure(501, "FUTURE-PARTIAL", { plannedDate: "2026-07-10" });
  const complete = measure(502, "FUTURE-COMPLETE", { plannedDate: "2026-07-20" });
  const { db, login } = await setup(t, [partial, complete], () => "2026-06-25");
  result(db, 601, partial, { outcome: "partial", measuredValue: 35 });
  result(db, 602, complete);
  const coordinator = await login(205);
  const report = checked(await coordinator(reportUrl(2)));

  assert.equal(report.period.cutoff, "2026-06-25");
  assert.equal(rowFor(report, complete.id), undefined);
  const row = rowFor(report, partial.id);
  assert.equal(row.executionState, "not_due");
  assert.equal(row.resultId, null);
  assert.equal(row.reviewStatus, null);
  assert.equal(row.indicator.actual, null);
  assert.equal(row.carriedForward, false);
});

test("undated drafts use their Kyiv creation day at a half-year boundary", async (t) => {
  const june = measure(501, "JUNE");
  const july = measure(502, "JULY");
  const { db, login } = await setup(t, [june, july]);
  const draft = { status: "draft", outcome: null, resultDate: null, measuredValue: null };
  const creationTime = db.prepare("UPDATE results SET created_at=? WHERE id=?");
  creationTime.run("2026-06-30T20:59:59.999Z", result(db, 601, june, draft));
  creationTime.run("2026-06-30T21:00:00.000Z", result(db, 602, july, draft));

  const coordinator = await login(205);
  const h1 = checked(await coordinator(reportUrl(1)));
  assert.equal(rowFor(h1, june.id).reviewStatus, "draft");
  assert.equal(rowFor(h1, july.id).reviewStatus, null);
  assert.equal(rowFor(checked(await coordinator(reportUrl(2))), july.id).reviewStatus, "draft");
});

test("report scopes isolate departments and programs and reject invalid or unauthorized requests", async (t) => {
  const local = measure(501, "SAME");
  const hidden = measure(502, "SAME", { departmentId: id(102), executorId: id(203) });
  const foreign = measure(503, "FOREIGN", {
    sectionId: id(21), departmentId: id(103), executorId: id(204),
  });
  const { login, request } = await setup(t, [local, hidden, foreign]);
  const coordinator = await login(205);
  const leader = await login(206);
  const analyst = await login(207);
  const admin = await login(208);
  const executor = await login(201);
  checked(await request(reportUrl()), 401);
  checked(await executor(reportUrl()), 403);
  checked(await executor(reportUrl(1, { format: "csv" })), 403);
  const scoped = checked(await coordinator(reportUrl()));
  assert.deepEqual(rows(scoped).map(({ measureId }) => measureId), [local.id]);
  assert.deepEqual(scoped.scope.departmentIds, [id(101)]);
  assert.equal(scoped.summary.total, 1);
  assert.deepEqual(rows(checked(await analyst(reportUrl()))).map(({ measureId }) => measureId), [local.id]);
  assert.deepEqual(rows(checked(await leader(reportUrl()))).map(({ measureId }) => measureId).sort(), [local.id, hidden.id].sort());
  assert.deepEqual(rows(checked(await admin(reportUrl()))).map(({ measureId }) => measureId).sort(), [local.id, hidden.id].sort());
  const foreignReport = checked(await admin(reportUrl(1, { programId: id(2) })));
  assert.deepEqual(rows(foreignReport).map(({ measureId }) => measureId), [foreign.id]);
  checked(await coordinator(reportUrl(1, { programId: id(2) })), 404);
  checked(await coordinator(reportUrl(1, { programId: id(9999) })), 404);
  for (const query of [
    { year: "not-a-year" }, { year: "2026.5" }, { year: "0" },
    { half: "0" }, { half: "3" }, { half: "1.5" },
    { format: "xml" }, { unexpected: "1" },
  ]) checked(await coordinator(reportUrl(1, query)), 400);
});

test("approved snapshots drive report values and CSV exports the same safe scoped rows", async (t) => {
  const first = measure(501, "A");
  const second = measure(502, "B");
  const hidden = measure(503, "PRIVATE", { departmentId: id(102), executorId: id(203) });
  const { db, login } = await setup(t, [first, second, hidden]);
  const description = '=HYPERLINK("https://example.invalid","synthetic")\r\nНаступний рядок, з комою';
  result(db, 601, first, {
    measuredValue: 80,
    description,
    planSnapshot: snapshot(first, {
      title: '+Синтетична "історична" назва',
      departmentTitle: "Історичний підрозділ",
      indicator: { ...first.indicator, baseline: 10, target: 80 },
    }),
  });
  result(db, 602, second, { outcome: "partial", measuredValue: 0 });
  result(db, 603, hidden, { description: "PRIVATE CONTENT" });
  const before = db.prepare("SELECT count(*) AS count FROM audit_events").get().count;
  const coordinator = await login(205);
  const report = checked(await coordinator(reportUrl()));
  const firstRow = rowFor(report, first.id);
  assert.equal(firstRow.title, '+Синтетична "історична" назва');
  assert.equal(firstRow.departmentTitle, "Історичний підрозділ");
  assert.equal(firstRow.indicator.baseline, 10);
  assert.equal(firstRow.indicator.target, 80);
  assert.equal(firstRow.indicator.actual, 80);
  assert.equal(firstRow.indicator.targetReached, true);
  assert.equal(firstRow.resultDescription, description);
  const response = await coordinator(reportUrl(1, { format: "csv" }));
  checked(response);
  assert.match(response.headers.get("content-type"), /^text\/csv/);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.match(response.headers.get("content-disposition"), /2026.*(?:H1|1).*\.csv/);
  const csv = parseCsv(response.text);
  const exportedRows = csv.slice(1);
  assert.equal(exportedRows.length, report.summary.total);
  assert.deepEqual(exportedRows.map(([measureId]) => measureId), rows(report).map(({ measureId }) => measureId));
  assert.ok(exportedRows.every((row) => row.length === csv[0].length));
  assert.ok(exportedRows[0].includes("'" + description));
  assert.ok(exportedRows[0].includes("'+Синтетична \"історична\" назва"));
  assert.deepEqual(csv[0].slice(-5), [
    "Одиниця виміру", "Базове значення", "Цільове значення", "Фактичне значення", "Ціль досягнуто",
  ]);
  assert.deepEqual(exportedRows[0].slice(-5), [first.indicator.unit, "10", "80", "80", "Так"]);
  assert.deepEqual(exportedRows[1].slice(-5), [second.indicator.unit, "0", "100", "0", "Ні"]);
  assert.equal(response.text.includes("PRIVATE"), false);
  assert.equal(response.text.includes(hidden.id), false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM audit_events").get().count, before);
});

test("empty report retains its three sections and a null completion rate", async (t) => {
  const { login } = await setup(t, []);
  const coordinator = await login(205);
  const report = checked(await coordinator(reportUrl()));
  assert.deepEqual(report.sections.map(({ title }) => title), sectionTitles);
  assert.deepEqual(rows(report), []);
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.completionRate, null);
  assert.deepEqual(report.summary.problemRows, []);
  const csv = parseCsv(checked(await coordinator(reportUrl(1, { format: "csv" }))));
  assert.equal(csv.length, 1);
});
