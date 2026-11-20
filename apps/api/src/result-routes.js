import { forbidden } from "./registry.js";
import { hasPermission } from "./permissions.js";
import { isIndependentReviewer, readResultForUser } from "./result-access.js";
import {
  assignExecutor,
  createResult,
  listResults,
  patchResult,
  readAssignment,
  transitionResult,
} from "./result-workflow.js";
import { choice, keys, pagination } from "./validation.js";

function resultJson(row) {
  return {
    id: row.id,
    measureId: row.measure_id,
    periodKey: row.period_key,
    revision: row.revision,
    supersedesId: row.supersedes_id,
    executorId: row.executor_id,
    planSnapshot: JSON.parse(row.plan_snapshot_json),
    status: row.status,
    outcome: row.outcome,
    description: row.description,
    nonCompletionReason: row.non_completion_reason,
    resultDate: row.result_date,
    actualDate: row.actual_date,
    measuredValue: row.measured_value,
    version: row.version,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function resultDetail(db, result, user, evidenceStore) {
  const evidenceHistory = await evidenceStore.history(result.id, user);
  const latest = new Map();
  for (const file of evidenceHistory) {
    if (
      (file.executorId ?? file.uploadedBy) === result.executor_id &&
      file.revision > (latest.get(file.logicalFileId)?.revision ?? 0)
    ) latest.set(file.logicalFileId, file);
  }
  const reviews = await db.prepare(
    `SELECT r.id, r.decision, r.comment, r.actor_id AS actorId, u.display_name AS actorName,
            r.created_at AS createdAt, r.result_version AS resultVersion
     FROM result_reviews r JOIN users u ON u.id=r.actor_id
     WHERE r.result_id=? ORDER BY r.result_version`,
  ).all(result.id);
  return {
    ...resultJson(result),
    canReview: result.status === "submitted" && hasPermission(user, "workflow.review") &&
      await isIndependentReviewer(db, result, user.id),
    evidence: [...latest.values()],
    evidenceHistory,
    reviews,
  };
}

async function resultAudit(db, result, user, query) {
  const { page, pageSize } = pagination(query);
  const executor = user.role === "executor";
  const where = `(a.entity_type='result' AND a.entity_id=?) OR (
    a.entity_type='evidence' AND EXISTS (
      SELECT 1 FROM evidence_versions ev WHERE ev.id=a.entity_id AND ev.result_id=?
        ${executor ? "AND ev.uploaded_by=?" : ""}
    )
  )`;
  const params = executor ? [result.id, result.id, user.id] : [result.id, result.id];
  const { n: total } = await db.prepare(
    `SELECT count(*) AS n FROM audit_events a WHERE ${where}`,
  ).get(...params);
  const rows = await db.prepare(
    `SELECT a.id, a.actor_id AS actorId, u.display_name AS actorName, a.action, a.entity_type AS entityType,
            a.entity_id AS entityId, a.before_json, a.after_json,
            a.occurred_at AS occurredAt
     FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE ${where}
     ORDER BY a.occurred_at, a.id LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize);
  const items = rows.map(({ before_json, after_json, ...event }) => ({
      ...event,
      before: JSON.parse(before_json),
      after: JSON.parse(after_json),
    }));
  return { items, total, page, pageSize };
}

export function mountResultRoutes(app, db, { today, evidence }) {
  app.get("/api/measures/:id/results", async (req, res) => {
    keys(req.query, []);
    const results = await db.transaction(() => listResults(db, req.user, req.params.id), { readOnly: true });
    const items = results.map((result) => ({
      id: result.id,
      periodKey: result.period_key,
      revision: result.revision,
      status: result.status,
      outcome: result.outcome,
      resultDate: result.result_date,
      version: result.version,
    }));
    res.json({ items });
  });
  app.post("/api/measures/:id/results", async (req, res) => {
    keys(req.query, []);
    const result = await createResult(db, req.user, req.params.id, req.body);
    res.status(201).location("/api/results/" + result.id).json(resultJson(result));
  });
  app.get("/api/measures/:id/assignment", async (req, res) => {
    keys(req.query, ["periodKey"], ["periodKey"]);
    const assignment = await db.transaction(() => readAssignment(db, req.user, req.params.id, req.query.periodKey), { readOnly: true });
    res.json(assignment);
  });
  app.put("/api/measures/:id/assignment", async (req, res) => {
    keys(req.query, []);
    res.json(await assignExecutor(db, req.user, req.params.id, req.body));
  });
  app.get("/api/results/:id", async (req, res) => {
    keys(req.query, []);
    const value = await db.transaction(async (db) => {
      const result = await readResultForUser(db, req.user, req.params.id);
      return resultDetail(db, result, req.user, evidence);
    }, { readOnly: true });
    res.json(value);
  });
  app.patch("/api/results/:id", async (req, res) => {
    keys(req.query, []);
    res.json(resultJson(await patchResult(db, req.user, req.params.id, req.body, { today })));
  });
  app.post("/api/results/:id/submit", async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["version"], ["version"]);
    const result = await transitionResult(db, req.user.id, req.params.id, {
      action: "submit",
      version: req.body.version,
    }, { today });
    res.json(resultJson(result));
  });
  app.post("/api/results/:id/review", async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["version", "decision", "comment"], ["version", "decision"]);
    const result = await transitionResult(db, req.user.id, req.params.id, {
      action: choice(req.body.decision, ["return", "approve"]),
      version: req.body.version,
      comment: req.body.comment,
    }, { today, verifyEvidence: (file) => evidence.verify(file) });
    res.json(resultJson(result));
  });
  app.get("/api/results/:id/audit", async (req, res) => {
    if (!hasPermission(req.user, "audit.read")) forbidden();
    keys(req.query, ["page", "pageSize"]);
    const value = await db.transaction(async (db) => {
      const result = await readResultForUser(db, req.user, req.params.id);
      return resultAudit(db, result, req.user, req.query);
    }, { readOnly: true });
    res.json(value);
  });
}
