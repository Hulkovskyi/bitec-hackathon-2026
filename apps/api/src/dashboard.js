import { measureScope, missing, programAllowed, scope, selectMeasure } from "./registry.js";
import { canReadResult, effectiveAssignment } from "./result-access.js";
import { currentEvidence } from "./result-workflow.js";
import { deadlineFlag, evaluateRiskFlags, selectRevisions, startedDeadlines } from "./risk-flags.js";
import { choice, keys, pagination, uuid } from "./validation.js";

const metrics = ["measures", "completed", "overdue", "overdueMeasures", "dueSoon", "pendingReview"];
const ruleCodes = ["overdue", "due_soon", "missing_evidence", "target_not_met", "closed_without_improvement"];

async function readQuery(db, user, query, selector, values) {
  keys(query, ["programId", "departmentId", selector, "page", "pageSize"], ["programId"]);
  const programId = uuid(query.programId);
  const departmentId = query.departmentId === undefined ? null : uuid(query.departmentId);
  const filter = query[selector] === undefined ? undefined : choice(query[selector], values);
  const paging = pagination(query);
  await programAllowed(db, user, programId);
  if (departmentId && (
    !(await db.prepare("SELECT 1 FROM departments WHERE id=? AND program_id=?").get(departmentId, programId)) ||
    !(await scope(db, user, programId, departmentId))
  )) missing();
  return { programId, departmentId, filter, ...paging };
}

async function scopedEntries(db, user, { programId, departmentId }, asOf) {
  const visible = measureScope(user);
  const plans = await db.prepare(`
    SELECT plan.*, p.period_start, p.period_end
    FROM (
      ${selectMeasure}
      WHERE s.program_id=? AND ${visible.sql} ${departmentId ? "AND m.department_id=?" : ""}
    ) plan JOIN programs p ON p.id=plan.program_id
  `).all(programId, ...visible.params, ...(departmentId ? [departmentId] : []));
  const readRevisions = db.prepare(`
    SELECT id, measure_id, period_key, revision, status, executor_id, outcome, measured_value
    FROM results WHERE measure_id=?
  `);
  const entries = [];
  for (const plan of plans) {
    const deadlines = new Map();
    for (const { periodKey, deadline } of startedDeadlines(plan, asOf)) {
      if (user.role !== "executor" || (await effectiveAssignment(db, plan, periodKey)).executorId === user.id)
        deadlines.set(periodKey, deadline);
    }
    if (deadlines.size === 0) continue;

    const revisions = (await readRevisions.all(plan.id)).filter(({ period_key }) => deadlines.has(period_key));
    const byPeriod = selectRevisions(plan.id, revisions);
    const allowedResultIds = new Set();
    for (const candidates of byPeriod.values()) {
      for (const result of new Set(Object.values(candidates))) {
        if (await canReadResult(db, user, result, plan)) allowedResultIds.add(result.id);
      }
    }
    entries.push({ plan, deadlines, revisions, byPeriod, allowedResultIds });
  }
  return entries;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePeriods(left, right) {
  return compareText(left.deadline, right.deadline) ||
    compareText(left.code, right.code) ||
    compareText(left.measureId, right.measureId) ||
    compareText(left.periodKey, right.periodKey);
}

function periodLists(entries, asOf) {
  const periods = [];
  for (const { plan, deadlines, byPeriod, allowedResultIds } of entries) {
    for (const [periodKey, deadline] of deadlines) {
      const { approved, latest } = byPeriod.get(periodKey) ?? {};
      const item = { measureId: plan.id, periodKey, code: plan.code, title: plan.title, deadline };
      const completed = approved?.outcome === "completed";
      const timing = deadlineFlag({ measureId: plan.id, periodKey }, {
        active: plan.active,
        deadline,
        today: asOf,
        completed,
      });
      periods.push({
        item,
        active: plan.active && (periodKey === "once" || asOf <= deadline),
        completed,
        overdue: timing?.ruleCode === "overdue",
        dueSoon: timing?.ruleCode === "due_soon",
        approved: allowedResultIds.has(approved?.id) ? approved : undefined,
        latest: allowedResultIds.has(latest?.id) ? latest : undefined,
      });
    }
  }
  periods.sort((left, right) => comparePeriods(left.item, right.item));

  const measures = periods.filter(({ active }) => active);
  const completed = measures.filter((period) => period.completed);
  const overdue = periods.filter((period) => period.overdue);
  const dueSoon = periods.filter((period) => period.dueSoon);
  const pendingReview = periods.filter(({ latest }) => latest?.status === "submitted");
  const overdueMeasures = [];
  const seen = new Set();
  for (const period of overdue) {
    const { measureId } = period.item;
    if (seen.has(measureId)) continue;
    seen.add(measureId);
    overdueMeasures.push(period);
  }
  return { measures, completed, overdue, overdueMeasures, dueSoon, pendingReview };
}

function pageOf(items, { page, pageSize }) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

async function dashboard(db, entries, asOf, paging) {
  const lists = periodLists(entries, asOf);
  const metric = paging.filter ?? "measures";
  const rows = lists[metric];
  const counts = Object.fromEntries(metrics.map((key) => [key, lists[key].length]));
  const readReturnComment = db.prepare(`
    SELECT comment FROM result_reviews WHERE result_id=? AND decision='return'
    ORDER BY result_version DESC LIMIT 1
  `);
  const items = [];
  for (const { item, latest, approved } of pageOf(rows, paging)) {
    const result = metric === "completed" ? approved : latest;
    if (!result) {
      items.push(item);
      continue;
    }
    const reviewComment = result.status === "returned" ? (await readReturnComment.get(result.id))?.comment : undefined;
    items.push({
      ...item,
      resultId: result.id,
      resultStatus: result.status,
      outcome: result.outcome,
      ...(reviewComment === undefined ? {} : { reviewComment }),
    });
  }
  return {
    asOf,
    counts,
    completionRate: counts.measures === 0 ? null : counts.completed / counts.measures,
    items,
    total: rows.length,
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

async function checkEvidence(evidence, file) {
  try {
    return await evidence.integrity(file);
  } catch (error) {
    // A filesystem read error leaves integrity unconfirmed. Keep unexpected
    // errors visible instead of misreporting them as file problems.
    if (["EACCES", "EPERM", "EIO", "EBUSY"].includes(error?.code)) return { intact: false };
    throw error;
  }
}

async function riskFlags(db, evidence, entries, asOf, paging) {
  const ruleCode = paging.filter;
  const needsEvidence = ruleCode === undefined || ruleCode === "missing_evidence";
  const ruleEntries = [];
  for (const { plan, deadlines, revisions, byPeriod, allowedResultIds } of entries) {
    const evidenceByResult = new Map();
    if (needsEvidence) {
      for (const { submitted, approved } of byPeriod.values()) {
        const result = submitted ?? approved;
        if (result && allowedResultIds.has(result.id)) {
          const files = [];
          for (const file of await currentEvidence(db, result))
            files.push(await checkEvidence(evidence, file));
          evidenceByResult.set(result.id, files);
        }
      }
    }
    ruleEntries.push({ plan, revisions, allowedResultIds, evidenceByResult, allowedPeriodKeys: new Set(deadlines.keys()) });
  }
  const byMeasureId = new Map(entries.map((entry) => [entry.plan.id, entry]));
  const rows = evaluateRiskFlags(ruleEntries, { today: () => asOf, ruleCode }).items
    .map((flag) => {
      const { plan, deadlines } = byMeasureId.get(flag.measureId);
      return { ...flag, code: plan.code, title: plan.title, deadline: deadlines.get(flag.periodKey) };
    })
    .sort((left, right) => comparePeriods(left, right) || compareText(left.ruleCode, right.ruleCode));
  return {
    asOf,
    items: pageOf(rows, paging),
    total: rows.length,
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export function mountDashboardRoutes(app, db, { today, evidence }) {
  app.get("/api/dashboard", async (req, res) => {
    const asOf = today();
    const body = await db.transaction(async (db) => {
      const query = await readQuery(db, req.user, req.query, "metric", metrics);
      const entries = await scopedEntries(db, req.user, query, asOf);
      return dashboard(db, entries, asOf, query);
    }, { readOnly: true });
    res.json(body);
  });
  app.get("/api/risk-flags", async (req, res) => {
    const asOf = today();
    const body = await db.transaction(async (db) => {
      const query = await readQuery(db, req.user, req.query, "ruleCode", ruleCodes);
      const entries = await scopedEntries(db, req.user, query, asOf);
      return riskFlags(db, evidence, entries, asOf, query);
    }, { readOnly: true });
    res.json(body);
  });
}
