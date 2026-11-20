import { randomUUID } from "node:crypto";
import { adaptDatabase } from "./database.js";
import { hasPermission, loadPermissions } from "./permissions.js";
import {
  audit,
  forbidden,
  kyivDate,
  measure,
  missing,
} from "./registry.js";
import {
  assertPeriod,
  assertResultEditor,
  canReadResult,
  effectiveAssignment,
  getMeasurePlan,
  isIndependentReviewer,
  planForScope,
  readResultForUser,
  validPeriodKey,
  workInterval,
} from "./result-access.js";
import { ApiError, choice, date, invalid, keys, positive, text, uuid } from "./validation.js";

const nextStatus = {
  submit: "submitted",
  return: "returned",
  approve: "approved",
};

export async function currentEvidence(database, result) {
  const db = adaptDatabase(database);
  return db.prepare(
    `SELECT e.* FROM evidence_versions e
     WHERE e.result_id=? AND e.uploaded_by=?
       AND NOT EXISTS (
         SELECT 1 FROM evidence_versions next
         WHERE next.result_id=e.result_id AND next.uploaded_by=e.uploaded_by
           AND next.logical_file_id=e.logical_file_id AND next.revision>e.revision
       )
     ORDER BY e.logical_file_id`,
  ).all(result.id, result.executor_id);
}

const outcomes = ["completed", "partial", "not_completed"];

async function validateResultDates(db, result, plan, today) {
  const [start, end] = assertPeriod(plan, result.period_key);
  const resultDate = result.result_date === null ? null : date(result.result_date);
  const actualDate = result.actual_date === null ? null : date(result.actual_date);
  if ([resultDate, actualDate].some(
    (value) => value !== null && (value < start || value > end || value > today),
  )) invalid("Дата результату поза робочим інтервалом");

  if (result.supersedes_id !== null) {
    const previous = await db.prepare("SELECT * FROM results WHERE id=?").get(result.supersedes_id);
    if (
      !previous || previous.status !== "approved" || previous.outcome === "completed" ||
      previous.revision + 1 !== result.revision ||
      (resultDate && resultDate < previous.result_date) ||
      (actualDate && previous.actual_date && actualDate < previous.actual_date)
    ) invalid("Некоректне продовження погодженого результату");
  }

}

async function validateForDecision(db, result, plan, today, verifyEvidence) {
  const outcome = choice(result.outcome, outcomes);
  text(result.description, 4000);
  if (outcome !== "completed") text(result.non_completion_reason, 4000);
  date(result.result_date);
  await validateResultDates(db, result, plan, today);

  const evidence = await currentEvidence(db, result);
  if (outcome !== "not_completed") {
    if (result.actual_date !== result.result_date || evidence.length === 0)
      invalid("Потрібні фактична дата й актуальний доказ виконавця");
    if (plan.target !== null && !Number.isFinite(result.measured_value))
      invalid("Потрібне виміряне значення індикатора");
  }
  if (result.measured_value !== null && !Number.isFinite(result.measured_value))
    invalid("Некоректне виміряне значення");

  if (verifyEvidence) {
    for (const file of evidence) {
      if (await verifyEvidence(file) !== true)
        invalid("Не вдалося підтвердити цілісність доказу");
    }
  }
}

function planSnapshot(row) {
  const plan = measure(row);
  return JSON.stringify({
    programId: plan.programId,
    sectionId: plan.sectionId,
    sectionCode: row.section_code,
    sectionTitle: row.section_title,
    departmentId: plan.departmentId,
    departmentCode: row.department_code,
    departmentTitle: row.department_title,
    code: plan.code,
    title: plan.title,
    description: plan.description,
    scheduleType: plan.scheduleType,
    ...(plan.recurrence ? { recurrence: plan.recurrence } : {}),
    plannedDate: plan.plannedDate,
    effectiveFrom: plan.effectiveFrom,
    indicator: plan.indicator,
  });
}

const versionConflict = () =>
  new ApiError(409, "version_conflict", "Версія результату змінилася");

function inactiveMeasure() {
  throw new ApiError(409, "inactive_measure", "Захід неактивний");
}

function latestResult(db, measureId, periodKey) {
  return db.prepare(
    "SELECT * FROM results WHERE measure_id=? AND period_key=? ORDER BY revision DESC LIMIT 1",
  ).get(measureId, periodKey);
}

async function hasPlanAssignment(db, plan, userId) {
  if (plan.schedule_type === "one_time")
    return (await effectiveAssignment(db, plan, "once")).executorId === userId;
  const overrides = await db.prepare(
    "SELECT executor_id FROM period_assignments WHERE measure_id=?",
  ).all(plan.id);
  if (overrides.some((row) => row.executor_id === userId)) return true;
  if (plan.executor_id !== userId) return false;
  const halfIndex = (value) => Number(value.slice(0, 4)) * 2 + Number(value.slice(5, 7) >= "07");
  const start = plan.period_start > plan.effective_from ? plan.period_start : plan.effective_from;
  const end = plan.period_end;
  if (plan.recurrence === "annual_april_may") {
    const firstYear = Number(start.slice(0, 4)) + Number(start.slice(5) > "05-31");
    const lastYear = Number(end.slice(0, 4)) - Number(end.slice(5) < "04-01");
    return overrides.length < lastYear - firstYear + 1;
  }
  return overrides.length < halfIndex(end) - halfIndex(start) + 1;
}

async function assignmentForUser(db, plan, user, periodKey) {
  if (!workInterval(plan, periodKey)) {
    if (user.role === "executor" && !(await hasPlanAssignment(db, plan, user.id))) missing();
    invalid("Період не належить заходу");
  }
  const assignment = await effectiveAssignment(db, plan, periodKey);
  if (user.role === "executor" && assignment.executorId !== user.id) missing();
  return assignment;
}

export async function listResults(database, user, measureId) {
  const db = adaptDatabase(database);
  const plan = await planForScope(db, user, measureId);
  const results = await db.prepare(
    "SELECT * FROM results WHERE measure_id=? ORDER BY period_key DESC, revision DESC",
  ).all(plan.id);
  const items = [];
  for (const result of results) {
    if (await canReadResult(db, user, result, plan)) items.push(result);
  }
  if (user.role === "executor" && items.length === 0 && !(await hasPlanAssignment(db, plan, user.id)))
    missing();
  return items;
}

export async function createResult(db, user, measureId, input) {
  if (!hasPermission(user, "workflow.submit")) forbidden();
  keys(input, ["periodKey"], ["periodKey"]);
  const periodKey = validPeriodKey(input.periodKey);
  return adaptDatabase(db).transaction(async (db) => {
    const plan = await planForScope(db, user, measureId);
    const { executorId } = await assignmentForUser(db, plan, user, periodKey);
    if (!plan.active) inactiveMeasure();

    const previous = await latestResult(db, plan.id, periodKey);
    if (previous && previous.status !== "approved")
      throw new ApiError(409, "result_open", "Для періоду вже є відкритий результат");
    if (previous?.outcome === "completed")
      throw new ApiError(409, "already_completed", "Захід уже виконано в цьому періоді");

    const now = new Date().toISOString();
    const result = await db.prepare(
      `INSERT INTO results
         (id, measure_id, period_key, revision, supersedes_id, executor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(randomUUID(), plan.id, periodKey, (previous?.revision ?? 0) + 1,
      previous?.id ?? null, executorId, now, now);
    await audit(db, user.id, "create", "result", result.id, null, result);
    return result;
  });
}

const resultFields = {
  outcome: ["outcome", (value) => value === null ? null : choice(value, outcomes)],
  description: ["description", (value) => text(value, 4000, true)],
  nonCompletionReason: ["non_completion_reason", (value) => value === null ? null : text(value, 4000, true)],
  resultDate: ["result_date", (value) => value === null ? null : date(value)],
  actualDate: ["actual_date", (value) => value === null ? null : date(value)],
  measuredValue: ["measured_value", (value) => {
    if (value === null || Number.isFinite(value)) return value;
    invalid("Некоректне виміряне значення");
  }],
};

export async function patchResult(db, user, resultId, input, { today = kyivDate } = {}) {
  if (!hasPermission(user, "workflow.submit")) forbidden();
  keys(input, ["version", ...Object.keys(resultFields)], ["version"]);
  const version = positive(input.version);
  const fields = Object.entries(resultFields).filter(([key]) => Object.hasOwn(input, key));
  if (!fields.length) invalid("Немає полів для оновлення");

  return adaptDatabase(db).transaction(async (db) => {
    const result = await readResultForUser(db, user, resultId);
    await assertResultEditor(db, user, result);
    if (result.version !== version) throw versionConflict();
    const changes = fields.map(([key, [column, validate]]) => [column, validate(input[key])]);
    const updated = { ...result, ...Object.fromEntries(changes) };
    await validateResultDates(db, updated, await getMeasurePlan(db, result.measure_id), today());

    const after = await db.prepare(
      `UPDATE results
       SET ${changes.map(([column]) => column + "=?").join(", ")}, version=version+1, updated_at=?
       WHERE id=? AND version=? RETURNING *`,
    ).get(...changes.map(([, value]) => value), new Date().toISOString(), result.id, version);
    if (!after) throw versionConflict();
    await audit(db, user.id, "update", "result", result.id, result, after);
    return after;
  });
}

export async function readAssignment(database, user, measureId, periodKey) {
  const db = adaptDatabase(database);
  validPeriodKey(periodKey);
  const plan = await planForScope(db, user, measureId);
  return assignmentForUser(db, plan, user, periodKey);
}

export async function assignExecutor(db, user, measureId, input) {
  if (!hasPermission(user, "workflow.assign")) forbidden();
  keys(input, ["periodKey", "executorId", "version"], ["periodKey", "executorId", "version"]);
  const executorId = uuid(input.executorId);
  const version = input.version === 0 ? 0 : positive(input.version);
  return adaptDatabase(db).transaction(async (db) => {
    const plan = await planForScope(db, user, measureId);
    const periodKey = input.periodKey;
    assertPeriod(plan, periodKey);
    if (!plan.active) inactiveMeasure();
    const before = await effectiveAssignment(db, plan, periodKey);
    if (version !== before.version) throw versionConflict();

    const result = await latestResult(db, plan.id, periodKey);
    if (result?.status === "submitted" ||
        (result?.status === "approved" && result.outcome === "completed"))
      throw new ApiError(409, "invalid_transition", "Зміна виконавця для цього стану недоступна");

    const eligible = await db.prepare(
      `SELECT 1 FROM users u
       JOIN user_scopes us ON us.user_id=u.id
       WHERE u.id=? AND u.role='executor' AND u.active=1
         AND us.program_id=? AND us.department_id=?`,
    ).get(executorId, plan.program_id, plan.department_id);
    if (!eligible) invalid("Виконавець не має доступу до підрозділу");

    const assignment = version === 0
      ? await db.prepare(
        `INSERT INTO period_assignments (measure_id, period_key, executor_id)
         VALUES (?, ?, ?) RETURNING executor_id AS executorId, version`,
      ).get(plan.id, periodKey, executorId)
      : await db.prepare(
        `UPDATE period_assignments SET executor_id=?, version=version+1
         WHERE measure_id=? AND period_key=? AND version=?
         RETURNING executor_id AS executorId, version`,
      ).get(executorId, plan.id, periodKey, version);
    if (!assignment) throw versionConflict();

    if (result && ["draft", "returned"].includes(result.status) && result.executor_id !== executorId) {
      const updated = await db.prepare(
        `UPDATE results SET executor_id=?, version=version+1, updated_at=?
         WHERE id=? AND version=? RETURNING *`,
      ).get(executorId, new Date().toISOString(), result.id, result.version);
      if (!updated) throw versionConflict();
      await audit(db, user.id, "reassign", "result", result.id, result, updated);
    }
    await audit(db, user.id, "assign", "period_assignment", plan.id,
      { periodKey, ...before }, { periodKey, ...assignment });
    return assignment;
  });
}

export async function transitionResult(
  db,
  actorId,
  resultId,
  input,
  { today = kyivDate, verifyEvidence } = {},
) {
  keys(input, ["action", "version", "comment"], ["action", "version"]);
  const action = choice(input.action, Object.keys(nextStatus));
  const version = positive(input.version);
  const comment = text(input.comment === undefined ? "" : input.comment, 4000, action !== "return");
  const submit = action === "submit";
  const approve = action === "approve";

  return adaptDatabase(db).transaction(async (db) => {
    const user = await db.prepare("SELECT id, role FROM users WHERE id=? AND active=1").get(uuid(actorId));
    if (!user) throw new ApiError(401, "unauthenticated", "Користувач недоступний");
    const actor = await loadPermissions(db, user);
    if (!hasPermission(actor, submit ? "workflow.submit" : "workflow.review")) forbidden();

    const readResult = db.prepare("SELECT * FROM results WHERE id=?");
    const result = await readResult.get(uuid(resultId));
    if (!result) missing();
    const plan = await getMeasurePlan(db, result.measure_id);
    if (!(await canReadResult(db, actor, result, plan))) missing();
    if (submit) {
      if ((await effectiveAssignment(db, plan, result.period_key)).executorId !== result.executor_id)
        missing();
      if (!plan.active) inactiveMeasure();
    } else if (!(await isIndependentReviewer(db, result, actor.id))) {
      forbidden();
    }

    if (result.version !== version) throw versionConflict();
    const allowed = submit ? ["draft", "returned"] : ["submitted"];
    if (!allowed.includes(result.status))
      throw new ApiError(409, "invalid_transition", "Перехід для цього стану недоступний");

    if (submit || approve)
      await validateForDecision(db, result, plan, today(), approve ? (verifyEvidence ?? (() => false)) : null);

    const now = new Date().toISOString();
    const updated = await db.prepare(
      `UPDATE results
       SET status=?, version=version+1, plan_snapshot_json=?, submitted_at=?, approved_at=?, updated_at=?
       WHERE id=? AND version=?`,
    ).run(
      nextStatus[action],
      submit ? planSnapshot(plan) : result.plan_snapshot_json,
      submit ? now : result.submitted_at,
      approve ? now : result.approved_at,
      now,
      result.id,
      version,
    );
    if (updated.changes !== 1) throw versionConflict();

    const after = await readResult.get(result.id);
    if (!submit) await db.prepare(
      `INSERT INTO result_reviews (id, result_id, decision, comment, actor_id, created_at, result_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), result.id, action, comment, actor.id, now, after.version);
    await audit(db, actor.id, action, "result", result.id, result, after);
    return after;
  });
}
