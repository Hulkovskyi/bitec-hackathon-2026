import { forbidden, measureScope, missing, programAllowed, scope, selectMeasure } from "./registry.js";
import { hasPermission } from "./permissions.js";
import { canReadResult, effectiveAssignment, workInterval } from "./result-access.js";
import { currentEvidence } from "./result-workflow.js";
import { officialRiskRuleCodes, readOfficialRiskFlags } from "./official-risk-flags.js";
import { mountRecommendationDecisionRoutes } from "./recommendation-decisions.js";
import { deadlineFlag, evaluateRiskFlags, selectRevisions, startedDeadlines } from "./risk-flags.js";
import { choice, keys, pagination, uuid } from "./validation.js";

const metrics = ["measures", "completed", "overdue", "overdueMeasures", "dueSoon", "pendingReview"];
const ruleCodes = ["overdue", "due_soon", "missing_evidence", "target_not_met", "closed_without_improvement"];

async function readQuery(db, user, query, selector, values, extra = []) {
  keys(query, ["programId", "departmentId", selector, "page", "pageSize", ...extra], ["programId"]);
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

async function scopedEntries(db, user, { programId, departmentId, measureId }, asOf) {
  const visible = measureScope(user);
  const plans = await db.prepare(`
    SELECT plan.*, p.period_start, p.period_end, source.source_period,
           source.source_status, source_plan.source_schedule_type
    FROM (
      ${selectMeasure}
      WHERE s.program_id=? AND ${visible.sql} ${departmentId ? "AND m.department_id=?" : ""} ${measureId ? "AND m.id=?" : ""}
    ) plan JOIN programs p ON p.id=plan.program_id
    LEFT JOIN official_dataset_batches batch ON batch.program_id=plan.program_id AND batch.source_as_of<=?
    LEFT JOIN official_measure_results source ON source.measure_id=plan.id
      AND source.program_id=plan.program_id AND source.source_period=batch.source_period
    LEFT JOIN official_measure_metadata source_plan ON source_plan.measure_id=source.measure_id
  `).all(programId, ...visible.params, ...(departmentId ? [departmentId] : []), ...(measureId ? [measureId] : []), asOf);
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
      const timing = deadlineFlag(plan, periodKey, deadline, asOf, approved);
      periods.push({
        item,
        active: plan.active && (periodKey === "once" || asOf <= workInterval(plan, periodKey)?.[1]),
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

async function liveRiskFlags(db, evidence, entries, asOf, ruleCode) {
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
  return evaluateRiskFlags(ruleEntries, { today: () => asOf, ruleCode }).items
    .map((flag) => {
      const { plan, deadlines } = byMeasureId.get(flag.measureId);
      return {
        ...flag, subjectType: "measure", subjectId: flag.measureId, departmentId: plan.department_id,
        code: plan.code, title: plan.title, deadline: deadlines.get(flag.periodKey),
      };
    })
    .sort((left, right) => comparePeriods(left, right) || compareText(left.ruleCode, right.ruleCode));
}

async function flagsForSource(db, user, evidence, query, now) {
  if (query.source === "official") {
    const archive = await db.prepare(`
      SELECT source_as_of AS asOf, source_period AS periodKey
      FROM official_dataset_batches WHERE program_id=? AND source_as_of <= ?
    `).get(query.programId, now);
    if (!archive) return { asOf: now, archive: null, rows: [] };
    const rows = await readOfficialRiskFlags(db, user, {
      programId: query.programId, departmentId: query.departmentId ?? null,
      asOf: archive.asOf, ruleCode: query.filter,
    });
    return { asOf: archive.asOf, archive, rows };
  }
  const entries = await scopedEntries(db, user, query, now);
  return { asOf: now, rows: await liveRiskFlags(db, evidence, entries, now, query.filter) };
}

export function mountDashboardRoutes(app, db, { today, evidence }) {
  app.get("/api/dashboard", async (req, res) => {
    const canReadAnalytics = hasPermission(req.user, "analytics.read");
    if (!canReadAnalytics && !(req.query.metric === "pendingReview" &&
        hasPermission(req.user, "workflow.review"))) forbidden();
    const asOf = today();
    const body = await db.transaction(async (db) => {
      const query = await readQuery(db, req.user, req.query, "metric", metrics);
      const entries = await scopedEntries(db, req.user, query, asOf);
      return dashboard(db, entries, asOf, query);
    }, { readOnly: true });
    res.json(canReadAnalytics ? body : { ...body, counts: { pendingReview: body.total }, completionRate: null });
  });
  app.get("/api/risk-flags", async (req, res) => {
    if (!hasPermission(req.user, "analytics.read")) forbidden();
    const asOf = today();
    const body = await db.transaction(async (db) => {
      const source = req.query.source === undefined ? "live" : choice(req.query.source, ["live", "official"]);
      const codes = source === "official" ? officialRiskRuleCodes : ruleCodes;
      const query = await readQuery(db, req.user, req.query, "ruleCode", codes, ["source"]);
      const { asOf: snapshotDate, rows, archive } = await flagsForSource(db, req.user, evidence, { ...query, source }, asOf);
      return {
        asOf: snapshotDate, items: pageOf(rows, query), total: rows.length,
        page: query.page, pageSize: query.pageSize,
        ...(source === "official" ? { archive } : {}),
      };
    }, { readOnly: true });
    res.json(body);
  });
  mountRecommendationDecisionRoutes(app, db, {
    today,
    async getVisibleSignal(tx, user, { programId, source, ruleCode, subjectType, subjectId, periodKey }) {
      if (source === "live" && subjectType !== "measure") return undefined;
      const query = { programId, source, filter: ruleCode, ...(source === "live" ? { measureId: subjectId } : {}) };
      const { rows } = await flagsForSource(tx, user, evidence, query, today());
      return rows.find((row) => row.ruleCode === ruleCode && row.subjectType === subjectType &&
        row.subjectId === subjectId && row.periodKey === periodKey);
    },
  });
}
