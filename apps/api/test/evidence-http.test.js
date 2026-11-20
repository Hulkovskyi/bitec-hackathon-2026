import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { createEvidenceStore } from "../src/evidence.js";
import { migrate } from "../src/database.js";
import { seed } from "../src/seed.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "http://127.0.0.1:3001";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function setup(t, { creatorId = 201, storage } = {}) {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "dacm-test-evidence-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seed(db, { demoMode: true });
  const evidenceStore = createEvidenceStore(db, { directory: evidenceDirectory, storage });
  const server = createApp(db, {
    evidenceStore,
    demoMode: true,
    today: () => "2026-11-17",
  }).listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(evidenceDirectory, { recursive: true });
  });
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (url, { method = "GET", cookie, body } = {}) => {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    if (body && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    return fetch(base + url, { method, headers, body });
  };
  async function login(n) {
    const response = await request("/api/demo/session", {
      method: "POST", body: { userId: id(n) },
    });
    assert.equal(response.status, 201);
    await response.json();
    return response.headers.getSetCookie()[0].split(";")[0];
  }
  const executor = await login(201);
  const creator = creatorId === 201 ? executor : await login(creatorId);
  const creation = await request(`/api/measures/${id(501)}/results`, {
    method: "POST", cookie: creator, body: { periodKey: "once" },
  });
  assert.equal(creation.status, 201);
  const result = await creation.json();
  function upload(content, {
    cookie = executor,
    version = result.version,
    logicalFileId,
    name = "доказ.txt",
    type = "text/plain",
  } = {}) {
    const body = new FormData();
    // A browser may place the file before or after the metadata fields.
    body.append("file", new Blob([content], { type }), name);
    body.append("version", String(version));
    if (logicalFileId) body.append("logicalFileId", logicalFileId);
    return request(`/api/results/${result.id}/evidence`, {
      method: "POST", cookie, body,
    });
  }
  return { db, evidenceDirectory, evidenceStore, request, login, result, executor, creator, upload };
}

test("evidence keeps immutable bytes and version history with scoped download and integrity", async (t) => {
  const { db, evidenceDirectory, request, login, result, executor, upload } = await setup(t);
  const firstText = "Перший синтетичний доказ\n";
  const secondText = "Другий синтетичний доказ\n";
  const firstReply = await upload(firstText);
  assert.equal(firstReply.status, 201);
  const first = await firstReply.json();
  assert.equal(first.evidence.sha256, sha256(firstText));
  assert.equal(first.evidence.originalName, "доказ.txt");
  assert.equal(first.resultVersion, result.version + 1);
  assert.equal(first.evidence.revision, 1);
  assert.equal(Object.hasOwn(first.evidence, "storageKey"), false);

  const secondReply = await upload(secondText, {
    logicalFileId: first.evidence.logicalFileId, version: first.resultVersion,
  });
  assert.equal(secondReply.status, 201);
  const second = await secondReply.json();
  assert.equal(second.evidence.revision, 2);
  assert.equal(second.evidence.sha256, sha256(secondText));
  assert.equal(second.resultVersion, first.resultVersion + 1);
  const detail = await (await request(`/api/results/${result.id}`, { cookie: executor })).json();
  assert.deepEqual(detail.evidence.map(({ id }) => id), [second.evidence.id]);
  assert.deepEqual(detail.evidenceHistory.map(({ revision }) => revision), [1, 2]);

  const oldUrl = `/api/evidence/${first.evidence.id}/download`;
  const download = await request(oldUrl, { cookie: executor });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await download.text(), firstText);
  const other = await login(202);
  assert.equal((await request(oldUrl, { cookie: other })).status, 404);
  const coordinator = await login(205);
  const integrityUrl = `/api/evidence/${first.evidence.id}/integrity`;
  assert.equal((await request(integrityUrl, { cookie: executor })).status, 403);
  let integrity = await (await request(integrityUrl, { cookie: coordinator })).json();
  assert.equal(integrity.intact, true);
  const key = db.prepare("SELECT storage_key FROM evidence_versions WHERE id=?").get(first.evidence.id);
  const storedPath = join(evidenceDirectory, key.storage_key);
  await writeFile(storedPath, "Інші синтетичні байти");
  integrity = await (await request(integrityUrl, { cookie: coordinator })).json();
  assert.equal(integrity.intact, false);
  assert.equal(integrity.actualSha256, sha256("Інші синтетичні байти"));
  assert.equal((await request(oldUrl, { cookie: executor })).status, 409);
  await unlink(storedPath);
  integrity = await (await request(integrityUrl, { cookie: coordinator })).json();
  assert.equal(integrity.intact, false);
  assert.equal(integrity.actualSha256, null);
  assert.equal((await request(oldUrl, { cookie: executor })).status, 404);
});

test("rejected uploads leave no rows, version changes or temporary files", async (t) => {
  const { db, evidenceDirectory, result, upload } = await setup(t);
  function assertUnchanged() {
    assert.equal(db.prepare("SELECT count(*) AS n FROM evidence_versions").get().n, 0);
    assert.equal(db.prepare("SELECT version FROM results WHERE id=?").get(result.id).version, result.version);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE entity_type='evidence'").get().n, 0);
  }
  const wrongSignature = await upload("Синтетичний текст", {
    name: "evidence.png", type: "image/png",
  });
  assert.equal(wrongSignature.status, 400);
  const wrongMedia = await upload("Синтетичний текст", {
    name: "evidence.txt", type: "image/png",
  });
  assert.equal(wrongMedia.status, 400);
  const tooBig = await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 32));
  assert.equal(tooBig.status, 413);
  const stale = await upload("Синтетичний доказ", { version: result.version + 1 });
  assert.equal(stale.status, 409);
  assertUnchanged();
  assert.deepEqual(await readdir(evidenceDirectory), []);

  db.exec(`CREATE TEMP TRIGGER reject_evidence_audit BEFORE INSERT ON audit_events
    WHEN NEW.entity_type='evidence'
    BEGIN SELECT RAISE(ABORT, 'synthetic evidence audit failure'); END;`);
  assert.equal((await upload("Синтетичний доказ")).status, 500);
  assertUnchanged();
  assert.deepEqual(await readdir(evidenceDirectory), []);
});

test("admin can manage a measure and its result while uploads retain executor ownership and real authorship", async (t) => {
  const { db, request, login, result, executor, creator: admin, upload } = await setup(t, { creatorId: 208 });
  assert.equal(result.executorId, id(201));
  const measurePath = `/api/measures/${id(501)}`;
  const resultPath = `/api/results/${result.id}`;
  const edit = await request(measurePath, {
    method: "PATCH", cookie: admin, body: { version: 1, title: "Захід після перевірки" },
  });
  assert.equal(edit.status, 200);

  const assign = await request(measurePath + "/assignment", {
    method: "PUT", cookie: admin, body: { version: 0, periodKey: "once", executorId: id(202) },
  });
  assert.equal(assign.status, 200);

  const replaceOwner = await (await request(resultPath, { cookie: admin })).json();
  assert.equal(replaceOwner.executorId, id(202));
  const patch = await request(resultPath, {
    method: "PATCH", cookie: admin, body: {
      version: replaceOwner.version, outcome: "completed", description: "Результат підтверджено",
      resultDate: "2026-11-17", actualDate: "2026-11-17", measuredValue: 100,
    },
  });
  assert.equal(patch.status, 200);
  const { version } = await patch.json();

  const first = await upload("Перший доказ", { cookie: admin, version });
  assert.equal(first.status, 201);
  const original = await first.json();
  assert.equal(original.evidence.uploadedBy, id(208));
  assert.equal(original.evidence.executorId, id(202));
  const replacement = await upload("Оновлений доказ", {
    cookie: admin, version: original.resultVersion, logicalFileId: original.evidence.logicalFileId,
  });
  assert.equal(replacement.status, 201);
  const uploaded = await replacement.json();
  assert.equal(uploaded.evidence.revision, 2);

  const newExecutor = await login(202);
  const current = await (await request(resultPath, { cookie: newExecutor })).json();
  assert.deepEqual(current.evidence, [uploaded.evidence]);
  assert.equal((await request(resultPath, { cookie: executor })).status, 404);
  const previousDownload = await request(`/api/evidence/${original.evidence.id}/download`, { cookie: newExecutor });
  assert.equal(previousDownload.status, 200);
  assert.equal(await previousDownload.text(), "Перший доказ");

  const submitted = await request(resultPath + "/submit", {
    method: "POST", cookie: admin, body: { version: uploaded.resultVersion },
  });
  assert.equal(submitted.status, 200);
  const submission = await submitted.json();
  assert.equal((await (await request(resultPath, { cookie: admin })).json()).canReview, false);
  for (const decision of ["approve", "return"]) {
    const selfReview = await request(resultPath + "/review", {
      method: "POST", cookie: admin, body: { version: submission.version, decision, comment: "Перевірено" },
    });
    assert.equal(selfReview.status, 403);
  }
  const coordinator = await login(205);
  assert.equal((await (await request(resultPath, { cookie: coordinator })).json()).canReview, true);
  const approved = await request(resultPath + "/review", {
    method: "POST", cookie: coordinator, body: { version: submission.version, decision: "approve" },
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "approved");
  const evidenceAudits = db.prepare("SELECT actor_id FROM audit_events WHERE entity_type='evidence'").all();
  assert.deepEqual(evidenceAudits.map(({ actor_id }) => actor_id), [id(208), id(208)]);
});

test("a failed upload with possibly stored bytes queues an idempotent removal", async (t) => {
  const objects = new Map();
  let canDelete = false;
  const storage = {
    async put(key, bytes) {
      objects.set(key, bytes);
      throw new Error("Synthetic response failure after storage");
    },
    async get(key) { return objects.get(key) ?? null; },
    async delete(key) {
      if (!canDelete) throw new Error("Synthetic delete unavailable");
      objects.delete(key);
    },
  };
  const { db, result, evidenceStore, upload } = await setup(t, { storage });
  assert.equal((await upload("Синтетичні байти")).status, 500);
  assert.equal(objects.size, 1);
  assert.equal(await evidenceStore.pendingDeletions(), 1);
  assert.equal(db.prepare("SELECT version FROM results WHERE id=?").get(result.id).version, result.version);
  assert.equal(db.prepare("SELECT count(*) AS n FROM evidence_versions").get().n, 0);
  canDelete = true;
  assert.equal(await evidenceStore.drainDeletions(), 0);
  assert.equal(objects.size, 0);
});

test("inactive measures retain draft history and stop draft edits and uploads", async (t) => {
  const { db, result, executor, request, upload } = await setup(t);
  db.prepare("UPDATE measures SET active=0 WHERE id=?").run(id(501));
  const updated = await request(`/api/results/${result.id}`, {
    method: "PATCH", cookie: executor, body: { version: result.version, description: "Тестова зміна" },
  });
  assert.equal(updated.status, 409);
  assert.equal((await updated.json()).error.code, "inactive_measure");
  const uploaded = await upload("Синтетичний файл");
  assert.equal(uploaded.status, 409);
  assert.equal((await uploaded.json()).error.code, "inactive_measure");
  assert.equal((await request(`/api/results/${result.id}`, { cookie: executor })).status, 200);
});
