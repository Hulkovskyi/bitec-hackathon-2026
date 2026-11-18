import { forbidden, missing, scope, selectMeasure } from "./registry.js";
import { ApiError, invalid, uuid } from "./validation.js";

const halfYearKey = /^(\d{4})-H([12])$/;

export function validPeriodKey(value) {
  if (typeof value !== "string" || (value !== "once" && (value.length !== 7 || !halfYearKey.test(value))))
    invalid("Некоректний ключ періоду");
  return value;
}

export function getMeasurePlan(db, id) {
  return db.prepare(
    `SELECT plan.*, p.period_start, p.period_end,
            s.code AS section_code, s.title AS section_title,
            d.code AS department_code, d.title AS department_title
     FROM (${selectMeasure} WHERE m.id=?) plan
     JOIN programs p ON p.id=plan.program_id
     JOIN sections s ON s.id=plan.section_id
     JOIN departments d ON d.id=plan.department_id`,
  ).get(id);
}

export function planForScope(db, user, id) {
  const plan = getMeasurePlan(db, uuid(id));
  if (!plan || !scope(db, user, plan.program_id, plan.department_id)) missing();
  return plan;
}

export function workInterval(plan, periodKey) {
  const start = plan.period_start > plan.effective_from ? plan.period_start : plan.effective_from;
  const end = plan.period_end;
  if (plan.schedule_type === "one_time" && periodKey === "once") return [start, end];
  if (plan.schedule_type !== "continuous" || typeof periodKey !== "string" || periodKey.length !== 7)
    return null;
  const half = halfYearKey.exec(periodKey);
  if (!half) return null;
  const [, year, number] = half;
  const halfStart = year + (number === "1" ? "-01-01" : "-07-01");
  const halfEnd = year + (number === "1" ? "-06-30" : "-12-31");
  const first = start > halfStart ? start : halfStart;
  const last = end < halfEnd ? end : halfEnd;
  return first <= last ? [first, last] : null;
}

export function assertPeriod(plan, periodKey) {
  const interval = workInterval(plan, periodKey);
  if (!interval) invalid("Період не належить заходу");
  return interval;
}

export function effectiveAssignment(db, plan, periodKey) {
  return db.prepare(
    "SELECT executor_id AS executorId, version FROM period_assignments WHERE measure_id=? AND period_key=?",
  ).get(plan.id, periodKey) ?? { executorId: plan.executor_id, version: 0 };
}

// This helper expects an authenticated user. Existing approved revisions are
// authorized independently from the current execution assignment.
export function canReadResult(db, user, result, plan) {
  if (!plan || !scope(db, user, plan.program_id, plan.department_id)) return false;
  if (user.role !== "executor") return true;
  return result.executor_id === user.id && (
    result.status === "approved" ||
    effectiveAssignment(db, plan, result.period_key).executorId === user.id
  );
}

export function readResultForUser(db, user, resultId) {
  const result = db.prepare("SELECT * FROM results WHERE id=?").get(uuid(resultId));
  if (!result || !canReadResult(db, user, result, getMeasurePlan(db, result.measure_id))) missing();
  return result;
}

export function assertResultEditor(db, user, result) {
  if (user.role !== "executor") forbidden();
  const plan = planForScope(db, user, result.measure_id);
  if (
    result.executor_id !== user.id ||
    effectiveAssignment(db, plan, result.period_key).executorId !== user.id
  ) missing();
  if (!["draft", "returned"].includes(result.status))
    throw new ApiError(409, "invalid_transition", "Редагування для цього стану недоступне");
}
