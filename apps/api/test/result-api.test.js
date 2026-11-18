import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { seed } from "../src/seed.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-11-18";
const measure = "/measures/" + id(501);
const origin = "http://127.0.0.1:3001";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "dacm-result-api-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db, { demoMode: true });
  const server = createApp(db, {
    demoMode: true,
    today: () => date,
    evidenceDirectory: directory,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { method = "GET", body, cookie } = {}) {
    const isJson = body !== undefined && !(body instanceof FormData);
    const response = await fetch(url + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(isJson ? { "Content-Type": "application/json" } : {}),
      },
      body: isJson ? JSON.stringify(body) : body,
    });
    const type = response.headers.get("content-type");
    return {
      status: response.status,
      data: type?.includes("application/json") ? await response.json() : await response.text(),
      headers: response.headers,
    };
  }
  async function login(n) {
    const response = await request("/demo/session", {
      method: "POST",
      body: { userId: id(n) },
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return (path, options = {}) => request(path, { ...options, cookie });
  }
  return { db, directory, login };
}

async function makeResult(executor) {
  const created = await executor(measure + "/results", {
    method: "POST",
    body: { periodKey: "once" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const path = "/results/" + created.data.id;
  const saved = await executor(path, {
    method: "PATCH",
    body: {
      version: created.data.version,
      outcome: "completed",
      description: "Перевірено синтетичні записи",
      resultDate: date,
      actualDate: date,
      measuredValue: 100,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return { path, result: saved.data };
}

function uploadBody(version, contents, logicalFileId) {
  const data = new FormData();
  data.set("version", String(version));
  if (logicalFileId) data.set("logicalFileId", logicalFileId);
  data.set("file", new Blob([contents], { type: "text/plain" }), "evidence.txt");
  return data;
}

async function upload(executor, path, version, contents, logicalFileId) {
  const response = await executor(path + "/evidence", {
    method: "POST",
    body: uploadBody(version, contents, logicalFileId),
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.evidence.sha256, createHash("sha256").update(contents).digest("hex"));
  return response.data;
}

const submit = (request, path, version) =>
  request(path + "/submit", { method: "POST", body: { version } });
const review = (request, path, version, decision, comment = "") =>
  request(path + "/review", { method: "POST", body: { version, decision, comment } });

test("HTTP cycle returns, replaces evidence, resubmits and approves with an audit trail", async (t) => {
  const { db, login } = await setup(t);
  const executor = await login(201);
  const other = await login(202);
  const coordinator = await login(205);
  const { path, result } = await makeResult(executor);

  assert.equal((await submit(executor, path, result.version)).status, 400);
  const first = await upload(executor, path, result.version, "Синтетична версія 1");
  const firstPath = `/evidence/${first.evidence.id}`;
  assert.equal((await other(path)).status, 404);
  assert.equal((await other(firstPath + "/download")).status, 404);
  assert.equal((await executor(firstPath + "/integrity")).status, 403);
  assert.equal((await coordinator(firstPath + "/integrity")).data.intact, true);

  const submitted = await submit(executor, path, first.resultVersion);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.status, "submitted");
  const frozen = await coordinator(measure, { method: "PATCH", body: { version: 1, title: "Зміна плану" } });
  assert.equal(frozen.data.error.code, "plan_frozen");
  assert.equal((await review(executor, path, submitted.data.version, "approve")).status, 403);

  const returned = await review(coordinator, path, submitted.data.version, "return", "Уточніть доказ");
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.equal(returned.data.status, "returned");
  const second = await upload(executor, path, returned.data.version, "Синтетична версія 2", first.evidence.logicalFileId);
  assert.equal(second.evidence.revision, 2);
  const detail = await executor(path);
  assert.deepEqual(detail.data.evidence.map(({ id }) => id), [second.evidence.id]);
  assert.equal(detail.data.evidenceHistory.length, 2);
  const oldFile = await executor(firstPath + "/download");
  assert.equal(oldFile.status, 200);
  assert.match(oldFile.headers.get("content-disposition"), /^attachment/);
  assert.equal(oldFile.data, "Синтетична версія 1");

  const again = await submit(executor, path, second.resultVersion);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const approved = await review(coordinator, path, again.data.version, "approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, "approved");
  const audit = await coordinator(path + "/audit");
  assert.equal(audit.status, 200, JSON.stringify(audit.data));
  assert.ok(audit.data.items.some((item) => item.action === "approve" && item.actorId === id(205)));
  assert.equal(db.prepare("SELECT count(*) AS n FROM result_reviews").get().n, 2);
});

test("current assignment replaces the default while returned evidence stays with its uploader", async (t) => {
  const { login } = await setup(t);
  const executor = await login(201);
  const replacement = await login(202);
  const coordinator = await login(205);
  const { path, result } = await makeResult(executor);
  const first = await upload(executor, path, result.version, "Файл попереднього виконавця");
  const submitted = await submit(executor, path, first.resultVersion);
  assert.equal(submitted.status, 200);
  const returned = await review(coordinator, path, submitted.data.version, "return", "Уточніть дані");
  assert.equal(returned.status, 200);

  const assignment = await coordinator(measure + "/assignment", {
    method: "PUT",
    body: { periodKey: "once", executorId: id(202), version: 0 },
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.data));
  assert.equal((await executor(measure)).status, 404);
  assert.equal((await replacement(measure)).status, 200);
  const list = "/measures?programId=" + id(1);
  assert.equal((await executor(list)).data.total, 0);
  assert.ok((await replacement(list)).data.items.some((item) => item.id === id(501)));

  const inherited = await replacement(path);
  assert.equal(inherited.status, 200);
  assert.deepEqual(inherited.data.evidence, []);
  assert.deepEqual(inherited.data.evidenceHistory, []);
  assert.equal((await replacement(`/evidence/${first.evidence.id}/download`)).status, 404);
  const replaceForeign = await replacement(path + "/evidence", {
    method: "POST",
    body: uploadBody(inherited.data.version, "Інша версія", first.evidence.logicalFileId),
  });
  assert.equal(replaceForeign.status, 404);
  assert.equal((await submit(replacement, path, inherited.data.version)).status, 400);
  assert.equal((await coordinator(path)).data.evidenceHistory.length, 1);
  const own = await upload(replacement, path, inherited.data.version, "Новий синтетичний доказ");
  assert.equal((await submit(replacement, path, own.resultVersion)).status, 200);
});

test("half-year reassignment agrees across registry reads and audit before a late H1 submission", async (t) => {
  const { login } = await setup(t);
  const executorA = await login(201);
  const executorB = await login(202);
  const coordinator = await login(205);
  const converted = await coordinator(measure, {
    method: "PATCH",
    body: { version: 1, scheduleType: "continuous", plannedDate: null },
  });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  const assignment = await coordinator(measure + "/assignment", {
    method: "PUT",
    body: { periodKey: "2026-H2", executorId: id(202), version: 0 },
  });
  assert.equal(assignment.status, 200, JSON.stringify(assignment.data));

  const h2 = "?periodKey=2026-H2";
  const h1 = "?periodKey=2026-H1";
  const periodAudit = measure + "/audit?entityType=period_assignment&";
  const [handoff, priorHalf, hiddenAudit, ownPlanAudit] = await Promise.all([
    coordinator(periodAudit + "periodKey=2026-H2&pageSize=1"),
    coordinator(periodAudit + "periodKey=2026-H1"),
    executorB(periodAudit + "periodKey=2026-H2"),
    executorB(measure + "/audit" + h2),
  ]);
  assert.equal(handoff.status, 200);
  assert.equal(handoff.data.total, 1);
  const [entry] = handoff.data.items;
  assert.equal(entry.actorId, id(205));
  assert.equal(entry.actorName, "Координатор А");
  assert.ok(Number.isFinite(Date.parse(entry.occurredAt)));
  assert.deepEqual(entry.before, { periodKey: "2026-H2", executorId: id(201), version: 0, executorName: "Виконавець А" });
  assert.deepEqual(entry.after, { periodKey: "2026-H2", executorId: id(202), version: 1, executorName: "Виконавець Б" });
  assert.equal(priorHalf.data.total, 0);
  assert.equal(hiddenAudit.status, 403);
  assert.equal(ownPlanAudit.status, 200);
  assert.ok(ownPlanAudit.data.items.every(({ entityType }) => entityType === "measure"));

  const list = "/measures?programId=" + id(1);
  const [h1Card, h1List, h2Card, h2List, h2Assignment, filtered] = await Promise.all([
    executorA(measure + h1),
    executorA(list + "&periodKey=2026-H1"),
    executorB(measure + h2),
    executorB(list + "&periodKey=2026-H2"),
    coordinator(measure + "/assignment" + h2),
    coordinator(list + "&periodKey=2026-H2&executorId=" + id(202)),
  ]);
  assert.equal((await executorA(measure)).status, 404);
  assert.ok(!(await executorA(list)).data.items.some((item) => item.id === id(501)));
  assert.equal((await executorB(measure + h1)).status, 404);
  for (const value of [h1Card.data, h1List.data.items.find((item) => item.id === id(501))]) {
    assert.equal(value.periodKey, "2026-H1");
    assert.equal(value.executorId, id(201));
    assert.equal(Object.hasOwn(value, "baseExecutorId"), false);
  }
  for (const value of [h2Card.data, h2List.data.items.find((item) => item.id === id(501)), filtered.data.items.find((item) => item.id === id(501))]) {
    assert.equal(value.periodKey, "2026-H2");
    assert.equal(value.executorId, h2Assignment.data.executorId);
  }
  assert.equal(filtered.data.items[0].baseExecutorId, id(201));

  const cardForEditing = await coordinator(measure + h2);
  assert.equal(cardForEditing.data.executorId, id(202));
  assert.equal(cardForEditing.data.baseExecutorId, id(201));
  const edited = await coordinator(measure, {
    method: "PATCH",
    body: { version: cardForEditing.data.version, title: "Синтетичний постійний захід" },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.baseExecutorId, id(201));
  assert.equal(edited.data.executorId, id(202));
  const changes = await coordinator(measure + "/audit?entityType=measure");
  assert.ok(changes.data.items.every((item) => item.after.executorId === id(201)));

  const draft = await executorA(measure + "/results", {
    method: "POST", body: { periodKey: "2026-H1" },
  });
  assert.equal(draft.status, 201);
  const path = "/results/" + draft.data.id;
  const saved = await executorA(path, {
    method: "PATCH",
    body: {
      version: draft.data.version,
      outcome: "not_completed",
      resultDate: "2026-06-30",
      description: "Звіт за перше півріччя подано пізніше",
      nonCompletionReason: "Очікували синтетичне підтвердження",
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const late = await submit(executorA, path, saved.data.version);
  assert.equal(late.status, 200, JSON.stringify(late.data));
  assert.equal(late.data.periodKey, "2026-H1");
  assert.equal(late.data.status, "submitted");
});

test("approval rejects a changed evidence file and leaves the submitted result intact", async (t) => {
  const { db, directory, login } = await setup(t);
  const executor = await login(201);
  const coordinator = await login(205);
  const { path, result } = await makeResult(executor);
  const file = await upload(executor, path, result.version, "Справжні тестові байти");
  const submitted = await submit(executor, path, file.resultVersion);
  assert.equal(submitted.status, 200);
  const savedFile = db.prepare("SELECT storage_key FROM evidence_versions WHERE id=?").get(file.evidence.id);
  assert.ok((await readdir(directory, { recursive: true })).includes(savedFile.storage_key));
  await writeFile(join(directory, savedFile.storage_key), "Контрольна зміна в тестовому файлі");

  const integrity = await coordinator(`/evidence/${file.evidence.id}/integrity`);
  assert.equal(integrity.status, 200);
  assert.equal(integrity.data.intact, false);
  const failed = await review(coordinator, path, submitted.data.version, "approve");
  assert.equal(failed.status, 400);
  const current = await coordinator(path);
  assert.equal(current.data.status, "submitted");
  assert.equal(current.data.version, submitted.data.version);
  assert.deepEqual(current.data.reviews, []);
});
