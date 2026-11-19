import {
  executionStateLabels,
  formatReportCsv,
  reportFilename,
} from "../../../shared/half-year-report.mjs";
import { forbidden, measureScope, programAllowed, selectMeasure } from "./registry.js";
import { workInterval } from "./result-access.js";
import { meetsIndicatorTarget } from "./risk-flags.js";
import { choice, invalid, keys, uuid } from "./validation.js";

const sectionTitles = [
  "Заходи з реалізації засад загальної відомчої політики, виконання антикорупційної стратегії та державної антикорупційної програми",
  "Заходи з усунення корупційних ризиків",
  "Навчання та заходи з поширення антикорупційної інформації",
];

function reportQuery(query, today) {
  keys(query, ["programId", "year", "half", "format"], ["programId", "year", "half"]);
  const programId = uuid(query.programId);
  if (typeof query.year !== "string" || !/^[1-9]\d{3}$/.test(query.year)) {
    invalid("Некоректний рік звіту");
  }
  const year = Number(query.year);
  const half = Number(choice(query.half, ["1", "2"]));
  const format = choice(query.format ?? "json", ["json", "csv"]);
  const start = `${year}-${half === 1 ? "01-01" : "07-01"}`;
  const end = `${year}-${half === 1 ? "06-30" : "12-31"}`;
  return {
    programId,
    format,
    period: { key: `${year}-H${half}`, year, half, start, end, cutoff: today < end ? today : end },
  };
}

function selectResults(revisions) {
  // Revisions arrive newest first. A report prefers result date, then revision.
  let approved = null;
  for (const result of revisions) {
    if (result.status === "approved" && result.result_date != null &&
        (approved === null || result.result_date > approved.result_date)) {
      approved = result;
    }
  }
  return { approved, reviewStatus: revisions[0]?.status ?? null };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reportEntry(plan, period, revisions) {
  const recurrent = plan.schedule_type === "continuous";
  const periodKey = recurrent ? period.key : "once";
  const interval = recurrent ? workInterval(plan, periodKey) : null;
  if (recurrent ? !interval : plan.effective_from > period.end) return null;

  const deadline = recurrent ? interval[1] : plan.planned_date;
  const { approved, reviewStatus } = selectResults(revisions);
  if (!recurrent && (
    (deadline > period.end && !approved) ||
    (approved?.outcome === "completed" && approved.actual_date < period.start)
  )) return null;

  const future = period.cutoff < period.start;
  const result = future ? null : approved;
  const snapshot = result?.plan_snapshot_json ? JSON.parse(result.plan_snapshot_json) : null;
  const indicator = snapshot?.indicator ?? plan;
  const actual = result?.measured_value ?? null;
  const historicalDeadline = recurrent ? deadline : snapshot?.plannedDate ?? deadline;
  const executionState = result?.outcome ?? (historicalDeadline > period.cutoff ? "not_due" : "not_approved");
  const details = result
    ? [result.description, result.outcome === "completed" ? null : result.non_completion_reason]
        .filter(Boolean).join("\n")
    : "Погоджений результат відсутній";

  return {
    sectionCode: snapshot?.sectionCode ?? plan.section_code,
    departmentCode: snapshot?.departmentCode ?? plan.department_code,
    row: {
      measureId: plan.id,
      periodKey,
      departmentId: snapshot?.departmentId ?? plan.department_id,
      departmentTitle: snapshot?.departmentTitle ?? plan.department_title,
      code: snapshot?.code ?? plan.code,
      title: snapshot?.title ?? plan.title,
      effectiveFrom: snapshot?.effectiveFrom ?? plan.effective_from,
      plannedDate: historicalDeadline,
      actualDate: result ? (recurrent ? period.end : result.actual_date) : null,
      executionState,
      resultDescription: details,
      resultId: result?.id ?? null,
      resultRevision: result?.revision ?? null,
      resultDate: result?.result_date ?? null,
      carriedForward: !recurrent && result !== null && result.result_date < period.start,
      reviewStatus: future ? null : reviewStatus,
      indicator: {
        unit: indicator.unit,
        baseline: indicator.baseline,
        target: indicator.target,
        actual,
        targetReached: meetsIndicatorTarget(actual, indicator.target, indicator.direction),
      },
    },
  };
}

function summarize(rows) {
  const counts = Object.fromEntries(Object.keys(executionStateLabels).map((state) => [state, 0]));
  const problemRows = [];
  for (const row of rows) {
    counts[row.executionState] += 1;
    if (["partial", "not_completed", "not_approved"].includes(row.executionState) ||
        (row.executionState === "completed" && row.indicator.targetReached === false)) {
      const { measureId, periodKey, resultId, code, title, departmentTitle, executionState } = row;
      problemRows.push({
        measureId, periodKey, resultId, code, title, departmentTitle, executionState,
        targetReached: row.indicator.targetReached,
      });
    }
  }
  return {
    total: rows.length,
    counts,
    completionRate: rows.length ? counts.completed / rows.length : null,
    problemRows,
  };
}

async function buildReport(db, user, { programId, period }) {
  await programAllowed(db, user, programId);
  const program = await db.prepare(`
    SELECT id, code, title, period_start AS periodStart, period_end AS periodEnd
    FROM programs WHERE id=?
  `).get(programId);
  if (period.start > program.periodEnd || period.end < program.periodStart) {
    invalid("Півріччя не перетинається з періодом програми");
  }
  const departmentFilter = user.role === "admin" ? "" : `AND EXISTS (
    SELECT 1 FROM user_scopes u WHERE u.user_id=? AND u.program_id=d.program_id AND u.department_id=d.id
  )`;
  const departments = await db.prepare(`
    SELECT d.id FROM departments d WHERE d.program_id=? ${departmentFilter} ORDER BY d.code, d.id
  `).all(programId, ...(user.role === "admin" ? [] : [user.id]));
  const visible = measureScope(user);
  const plans = await db.prepare(`
    SELECT plan.*, p.period_start, p.period_end, s.code AS section_code,
           d.code AS department_code, d.title AS department_title
    FROM (${selectMeasure} WHERE s.program_id=? AND ${visible.sql}) plan
    JOIN programs p ON p.id=plan.program_id
    JOIN sections s ON s.id=plan.section_id
    JOIN departments d ON d.id=plan.department_id
  `).all(programId, ...visible.params);
  const revisions = await db.prepare(`
    SELECT r.id, r.measure_id, r.revision, r.status, r.outcome, r.result_date, r.actual_date,
           r.description, r.non_completion_reason, r.measured_value, r.plan_snapshot_json
    FROM results r
    JOIN measures m ON m.id=r.measure_id
    JOIN sections s ON s.id=m.section_id
    WHERE s.program_id=? AND ${visible.sql}
      AND m.effective_from <= ?
      AND r.period_key = CASE WHEN m.schedule_type='continuous' THEN ? ELSE 'once' END
      AND COALESCE(r.result_date, substr(r.created_at, 1, 10)) <= ?
    ORDER BY r.revision DESC
  `).all(programId, ...visible.params, period.end, period.key, period.cutoff);
  const revisionsByMeasure = new Map();
  for (const result of revisions) {
    const history = revisionsByMeasure.get(result.measure_id) ?? [];
    history.push(result);
    revisionsByMeasure.set(result.measure_id, history);
  }
  const sections = sectionTitles.map((title, index) => ({ code: index + 1, title, rows: [] }));
  const entries = plans
    .map((plan) => reportEntry(plan, period, revisionsByMeasure.get(plan.id) ?? []))
    .filter(Boolean);
  entries.sort((a, b) => a.sectionCode - b.sectionCode ||
    compareText(a.departmentCode, b.departmentCode) || compareText(a.row.code, b.row.code) ||
    compareText(a.row.measureId, b.row.measureId));
  for (const { sectionCode, row } of entries) sections[sectionCode - 1].rows.push(row);
  const generatedAt = new Date().toISOString();
  return {
    program,
    period,
    generatedAt,
    dataAsOf: generatedAt,
    scope: { programId, departmentIds: departments.map(({ id }) => id) },
    sections,
    summary: summarize(entries.map(({ row }) => row)),
  };
}

export function mountReportRoutes(app, db, { today }) {
  app.get("/api/reports/half-year", async (req, res) => {
    if (req.user.role === "executor") forbidden();
    const query = reportQuery(req.query, today());
    const report = await db.transaction((tx) => buildReport(tx, req.user, query), { readOnly: true });
    res.set("Cache-Control", "no-store");
    if (query.format === "csv") {
      res.attachment(reportFilename(report)).type("text/csv").send(formatReportCsv(report));
      return;
    }
    res.json(report);
  });
}
