import {
  executionStateLabels,
  formatReportCsv,
  reportFilename,
} from "../../../shared/half-year-report.mjs";
import { forbidden, kyivDate, measureScope, programAllowed, selectMeasure } from "./registry.js";
import { workDeadline, workInterval } from "./result-access.js";
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
    today,
    period: { key: `${year}-H${half}`, year, half, start, end, cutoff: today < end ? today : end },
  };
}

function selectResults(revisions, cutoff) {
  // Revisions arrive newest first. A report prefers result date, then revision.
  let approved = null;
  for (const result of revisions) {
    if (result.status === "approved" && result.result_date != null &&
        (approved === null || result.result_date > approved.result_date)) {
      approved = result;
    }
  }
  const latest = revisions.find((result) =>
    result.result_date !== null || kyivDate(new Date(result.created_at)) <= cutoff);
  return { approved, reviewStatus: latest?.status ?? null };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function reportEntry(plan, period, readRevisions) {
  const recurrent = plan.schedule_type === "continuous";
  const periodKey = recurrent ? period.key : "once";
  const interval = recurrent ? workInterval(plan, periodKey) : null;
  if (recurrent ? !interval : plan.effective_from > period.end) return null;

  const deadline = workDeadline(plan, periodKey, interval);
  const revisions = await readRevisions.all(plan.id, periodKey, period.cutoff);
  const { approved, reviewStatus } = selectResults(revisions, period.cutoff);
  if (!recurrent && approved?.outcome === "completed" && approved.actual_date < period.start)
    return null;

  const future = period.cutoff < period.start;
  const result = future ? null : approved;
  const snapshot = result?.plan_snapshot_json ? JSON.parse(result.plan_snapshot_json) : null;
  const indicator = snapshot?.indicator ?? plan;
  const actual = result?.measured_value ?? null;
  const historicalDeadline = recurrent ? deadline : snapshot?.plannedDate ?? deadline;
  const executionState = result?.outcome ?? (historicalDeadline > period.cutoff ? "not_due" : "not_approved");
  let details = "";
  if (result) {
    details = [result.description, result.outcome === "completed" ? null : result.non_completion_reason]
      .filter(Boolean).join("\n");
  } else if (executionState !== "not_due") {
    details = "Погоджений результат відсутній";
  }

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
      actualDate: recurrent ? period.end : result?.actual_date ?? null,
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

async function officialReportEntries(db, plans, departmentIds, period, programId) {
  const sourceRows = await db.prepare(`
    SELECT m.*, r.source_status, r.source_approved, r.source_actual_date,
           r.source_entered_at, r.description, r.measured_value
    FROM official_measure_metadata m
    JOIN official_measure_results r ON r.measure_id=m.measure_id AND r.program_id=m.program_id
    WHERE m.program_id=? AND r.source_period=?
  `).all(programId, period.key);
  const claims = await db.prepare(`
    SELECT measure_id, title, reference_url FROM official_evidence_claims
    WHERE program_id=? ORDER BY source_id
  `).all(programId);
  const evidenceByMeasure = new Map();
  for (const { measure_id, title, reference_url } of claims) {
    if (!evidenceByMeasure.has(measure_id)) evidenceByMeasure.set(measure_id, []);
    evidenceByMeasure.get(measure_id).push({ title, referenceUrl: reference_url });
  }

  const plansById = new Map(plans.map((plan) => [plan.id, plan]));
  const entries = [];
  for (const source of sourceRows) {
    const plan = plansById.get(source.measure_id);
    if (!plan || !departmentIds.has(source.source_department_id)) continue;
    const recurring = source.source_schedule_type !== "one_time";
    const completed = source.source_status === "vykonano";
    const dueLater = !recurring && source.source_planned_date > period.end && !completed;
    const sourceOutcome = { vykonano: "completed", chastkovo: "partial" }[source.source_status];
    const executionState = dueLater ? "not_due" : sourceOutcome ?? "not_completed";
    entries.push({
      sectionCode: source.source_section_code,
      departmentCode: plan.department_code,
      row: {
        measureId: plan.id,
        periodKey: recurring ? period.key : "once",
        departmentId: source.source_department_id,
        departmentTitle: source.source_department_title,
        code: plan.code,
        title: source.source_title,
        sectionOrder: source.section_order,
        effectiveFrom: plan.effective_from,
        plannedDate: recurring ? period.end : source.source_planned_date,
        plannedText: source.plan_text,
        actualDate: recurring ? period.end : completed ? source.source_actual_date : null,
        executionState,
        resultDescription: dueLater ? "" : source.description,
        resultId: null,
        resultRevision: null,
        resultDate: null,
        carriedForward: false,
        reviewStatus: null,
        sourceResult: {
          status: source.source_status,
          markedApproved: Boolean(source.source_approved),
          enteredAt: source.source_entered_at,
        },
        sourceEvidence: evidenceByMeasure.get(plan.id) ?? [],
        indicator: {
          unit: source.indicator_unit,
          baseline: null,
          target: source.indicator_target,
          actual: source.measured_value,
          targetReached: meetsIndicatorTarget(source.measured_value, source.indicator_target, "increase"),
        },
      },
    });
  }
  return entries;
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

async function buildReport(db, user, { programId, period, today }) {
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
  const readRevisions = db.prepare(`
    SELECT id, revision, status, outcome, result_date, actual_date, created_at, description,
           non_completion_reason, measured_value, plan_snapshot_json
    FROM results WHERE measure_id=? AND period_key=?
      AND (result_date <= ? OR result_date IS NULL)
    ORDER BY revision DESC
  `);
  const sections = sectionTitles.map((title, index) => ({ code: index + 1, title, rows: [] }));
  const archive = await db.prepare(`
    SELECT source_as_of FROM official_dataset_batches
    WHERE program_id=? AND source_period=? AND source_as_of<=?
  `).get(programId, period.key, today);
  const departmentIds = departments.map(({ id }) => id);
  let entries;
  if (archive) {
    entries = await officialReportEntries(db, plans, new Set(departmentIds), period, programId);
  } else {
    entries = [];
    for (const plan of plans) {
      const entry = await reportEntry(plan, period, readRevisions);
      if (entry) entries.push(entry);
    }
  }
  entries.sort((a, b) => a.sectionCode - b.sectionCode ||
    (archive ? a.row.sectionOrder - b.row.sectionOrder : compareText(a.departmentCode, b.departmentCode)) ||
    compareText(a.row.code, b.row.code) || compareText(a.row.measureId, b.row.measureId));
  for (const { sectionCode, row } of entries) sections[sectionCode - 1].rows.push(row);
  const generatedAt = new Date().toISOString();
  return {
    program,
    period,
    generatedAt,
    dataAsOf: archive?.source_as_of ?? generatedAt,
    ...(archive ? { source: { type: "organizer_synthetic", asOf: archive.source_as_of } } : {}),
    scope: { programId, departmentIds },
    sections,
    summary: summarize(entries.map(({ row }) => row)),
  };
}

export function mountReportRoutes(app, db, { today }) {
  app.get("/api/reports/half-year", async (req, res) => {
    if (req.user.role === "executor") forbidden();
    const query = reportQuery(req.query, today());
    const report = await db.transaction(
      (snapshot) => buildReport(snapshot, req.user, query),
      { readOnly: true },
    );
    res.set("Cache-Control", "no-store");
    if (query.format === "csv") {
      res.attachment(reportFilename(report)).type("text/csv").send(formatReportCsv(report));
      return;
    }
    res.json(report);
  });
}
