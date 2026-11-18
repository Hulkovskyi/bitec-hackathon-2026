import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../src/database.js";
import { transitionResult } from "../src/result-workflow.js";
import { seed } from "../src/seed.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const executor = id(201);
const coordinator = id(205);
const resultDate = "2026-11-17";
const timestamp = "2026-11-17T12:00:00.000Z";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  seed(db, { demoMode: true });
  return db;
}

function createDraft(
  db,
  {
    measureId = id(501),
    executorId = executor,
    periodKey = "once",
    revision = 1,
    supersedesId = null,
  } = {},
) {
  const resultId = randomUUID();
  db.prepare(
    `INSERT INTO results (
      id, measure_id, executor_id, period_key, revision, supersedes_id,
      outcome, description, non_completion_reason, result_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'not_completed', ?, ?, ?, ?, ?)`,
  ).run(
    resultId,
    measureId,
    executorId,
    periodKey,
    revision,
    supersedesId,
    "Синтетичний результат",
    "Роботу відкладено",
    resultDate,
    timestamp,
    timestamp,
  );
  return resultId;
}

function transition(db, resultId, actorId, action, version, comment) {
  return transitionResult(
    db,
    actorId,
    resultId,
    { action, version, ...(comment === undefined ? {} : { comment }) },
    { today: () => resultDate },
  );
}

function snapshot(db, resultId) {
  const result = db.prepare("SELECT * FROM results WHERE id=?").get(resultId);
  const reviews = db
    .prepare("SELECT * FROM result_reviews WHERE result_id=? ORDER BY result_version")
    .all(resultId);
  const audit = db
    .prepare("SELECT * FROM audit_events WHERE entity_type='result' AND entity_id=? ORDER BY rowid")
    .all(resultId);
  return { result, reviews, audit };
}

test("executor submits and coordinator returns then approves with a complete audit trail", (t) => {
  const db = setup(t);
  const resultId = createDraft(db);
  const returnComment = "Уточніть причину невиконання";
  const submitted = transition(db, resultId, executor, "submit", 1);
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.version, 2);
  assert.ok(submitted.submitted_at);
  assert.equal(JSON.parse(submitted.plan_snapshot_json).code, "M-501");

  const returned = transition(db, resultId, coordinator, "return", 2, returnComment);
  assert.equal(returned.status, "returned");
  assert.equal(returned.version, 3);

  const resubmitted = transition(db, resultId, executor, "submit", 3);
  assert.equal(resubmitted.status, "submitted");
  assert.equal(resubmitted.version, 4);

  const approved = transition(db, resultId, coordinator, "approve", 4);
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 5);
  assert.equal(approved.outcome, "not_completed");
  assert.ok(approved.approved_at);
  assert.equal(approved.plan_snapshot_json, resubmitted.plan_snapshot_json);

  const { reviews, audit } = snapshot(db, resultId);
  assert.deepEqual(reviews.map((row) => row.decision), ["return", "approve"]);
  assert.ok(reviews.every((row) => row.actor_id === coordinator && row.created_at));
  assert.equal(reviews[0].comment, returnComment);
  assert.deepEqual(audit.map((row) => row.action), ["submit", "return", "submit", "approve"]);
  assert.deepEqual(audit.map((row) => row.actor_id), [
    executor,
    coordinator,
    executor,
    coordinator,
  ]);
  assert.ok(audit.every((row) => row.occurred_at));
  const transitions = audit.map((row) => {
    const before = JSON.parse(row.before_json);
    const after = JSON.parse(row.after_json);
    return [before.status, before.version, after.status, after.version];
  });
  assert.deepEqual(transitions, [
    ["draft", 1, "submitted", 2],
    ["submitted", 2, "returned", 3],
    ["returned", 3, "submitted", 4],
    ["submitted", 4, "approved", 5],
  ]);
});

test("transition access, return comments and optimistic versions are enforced without side effects", (t) => {
  const db = setup(t);
  const resultId = createDraft(db);
  const beforeDraft = snapshot(db, resultId);
  assert.throws(() => transition(db, resultId, coordinator, "approve", 1));
  assert.throws(() => transition(db, resultId, id(202), "submit", 1), {
    status: 404,
    code: "not_found",
  });
  assert.throws(() => transition(db, randomUUID(), coordinator, "approve", 1), {
    status: 404,
    code: "not_found",
  });
  assert.deepEqual(snapshot(db, resultId), beforeDraft);

  transition(db, resultId, executor, "submit", 1);
  const beforeReview = snapshot(db, resultId);
  assert.throws(() => transition(db, resultId, id(208), "approve", 2), {
    status: 403,
    code: "forbidden",
  });
  assert.throws(() => transition(db, resultId, coordinator, "approve", 1), {
    status: 409,
    code: "version_conflict",
  });
  assert.throws(() => transition(db, resultId, coordinator, "return", 2, "  "), {
    status: 400,
    code: "validation_error",
  });
  assert.deepEqual(snapshot(db, resultId), beforeReview);

  const otherResult = createDraft(db, {
    measureId: id(503),
    executorId: id(203),
    periodKey: "2026-H2",
  });
  transition(db, otherResult, id(203), "submit", 1);
  const beforeOther = snapshot(db, otherResult);
  assert.throws(() => transition(db, otherResult, coordinator, "approve", 2), {
    status: 404,
    code: "not_found",
  });
  assert.deepEqual(snapshot(db, otherResult), beforeOther);

  // The former executor still owns the result even after a role change.
  db.prepare("UPDATE users SET role='coordinator' WHERE id=?").run(executor);
  assert.throws(() => transition(db, resultId, executor, "approve", 2), {
    status: 403,
    code: "forbidden",
  });
  assert.deepEqual(snapshot(db, resultId), beforeReview);
});

test("a second open revision is rejected and a new draft leaves the approved revision intact", (t) => {
  const db = setup(t);
  const first = createDraft(db);
  assert.throws(() => createDraft(db, { revision: 2, supersedesId: first }), /UNIQUE constraint/);
  transition(db, first, executor, "submit", 1);
  transition(db, first, coordinator, "approve", 2);
  const before = snapshot(db, first);

  assert.throws(() => transition(db, first, coordinator, "return", 3, "Спроба зміни"));
  const next = createDraft(db, { revision: 2, supersedesId: first });
  const nextResult = snapshot(db, next).result;
  assert.equal(nextResult.status, "draft");
  assert.equal(nextResult.revision, 2);
  assert.equal(nextResult.supersedes_id, first);
  assert.deepEqual(snapshot(db, first), before);
});

test("approval verifies only the current executor's latest evidence after reassignment", (t) => {
  const db = setup(t);
  const resultId = createDraft(db);
  const replacement = id(202);
  db.prepare(
    "UPDATE results SET outcome='partial', actual_date=?, measured_value=60 WHERE id=?",
  ).run(resultDate, resultId);

  const insertEvidence = db.prepare(
    `INSERT INTO evidence_versions (
      id, result_id, logical_file_id, revision, original_name, storage_key,
      media_type, byte_size, sha256, uploaded_by, created_at
    ) VALUES (?, ?, ?, ?, 'evidence.txt', ?, 'text/plain', 10, ?, ?, ?)`,
  );
  function addVersion(uploader, logicalFileId, revision) {
    const evidenceId = randomUUID();
    insertEvidence.run(
      evidenceId,
      resultId,
      logicalFileId,
      revision,
      randomUUID(),
      "a".repeat(64),
      uploader,
      timestamp,
    );
    return evidenceId;
  }

  const formerEvidence = addVersion(executor, randomUUID(), 1);
  transition(db, resultId, executor, "submit", 1);
  transition(db, resultId, coordinator, "return", 2, "Уточніть результат");

  // Model the reassignment already recorded by the future assignment service.
  db.prepare(
    "INSERT INTO period_assignments (measure_id, period_key, executor_id) VALUES (?, 'once', ?)",
  ).run(id(501), replacement);
  db.prepare("UPDATE results SET executor_id=?, version=version+1 WHERE id=?")
    .run(replacement, resultId);
  const returned = snapshot(db, resultId);
  assert.throws(() => transition(db, resultId, executor, "submit", 4), {
    status: 404,
    code: "not_found",
  });
  assert.throws(() => transition(db, resultId, replacement, "submit", 4), {
    status: 400,
    code: "validation_error",
  });
  assert.deepEqual(snapshot(db, resultId), returned);

  const replacementEvidence = randomUUID();
  addVersion(replacement, replacementEvidence, 1);
  const latest = addVersion(replacement, replacementEvidence, 2);
  transition(db, resultId, replacement, "submit", 4);
  const submitted = snapshot(db, resultId);

  function approveWith(verifyEvidence) {
    return transitionResult(
      db,
      coordinator,
      resultId,
      { action: "approve", version: 5 },
      { today: () => resultDate, verifyEvidence },
    );
  }
  assert.throws(() => approveWith(undefined), { status: 400, code: "validation_error" });
  assert.throws(() => approveWith(() => false), { status: 400, code: "validation_error" });
  assert.deepEqual(snapshot(db, resultId), submitted);

  const checked = [];
  const approved = approveWith((file) => {
    checked.push(file.id);
    return true;
  });
  assert.deepEqual(checked, [latest]);
  assert.equal(approved.status, "approved");
  const former = db.prepare("SELECT uploaded_by FROM evidence_versions WHERE id=?")
    .get(formerEvidence);
  assert.equal(former.uploaded_by, executor);
});

test("a failed audit write rolls back both the approval and the review row", (t) => {
  const db = setup(t);
  const resultId = createDraft(db);
  transition(db, resultId, executor, "submit", 1);
  const before = snapshot(db, resultId);
  db.exec(`
    CREATE TEMP TRIGGER reject_result_audit BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'result'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic audit failure');
    END;
  `);

  assert.throws(() => transition(db, resultId, coordinator, "approve", 2), /synthetic audit failure/);
  assert.deepEqual(snapshot(db, resultId), before);

  db.exec("DROP TRIGGER reject_result_audit");
  transition(db, resultId, coordinator, "approve", 2);
  const after = snapshot(db, resultId);
  assert.equal(after.result.status, "approved");
  assert.equal(after.result.version, 3);
  assert.equal(after.reviews.length, 1);
  assert.equal(after.audit.length, 2);
});
