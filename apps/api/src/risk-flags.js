import { kyivDate } from "./registry.js";
import { workInterval } from "./result-access.js";

const millisecondsPerDay = 86_400_000;

// Dates are Kyiv calendar labels. UTC here gives a fixed length to each
// calendar day, including days when the local clocks change.
function daysBetween(today, deadline) {
  return (Date.parse(deadline) - Date.parse(today)) / millisecondsPerDay;
}

export function startedDeadlines(plan, today) {
  if (plan.schedule_type === "one_time") {
    const [start] = workInterval(plan, "once");
    return start <= today ? [{ periodKey: "once", deadline: plan.planned_date }] : [];
  }

  const deadlines = [];
  const firstDate = plan.period_start > plan.effective_from ? plan.period_start : plan.effective_from;
  const lastDate = plan.period_end < today ? plan.period_end : today;
  const firstYear = Number(firstDate.slice(0, 4));
  const lastYear = Number(lastDate.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (const half of [1, 2]) {
      const periodKey = `${String(year).padStart(4, "0")}-H${half}`;
      const interval = workInterval(plan, periodKey);
      if (interval && interval[0] <= today) {
        deadlines.push({ periodKey, deadline: interval[1] });
      }
    }
  }
  return deadlines;
}

export function selectRevisions(measureId, revisions) {
  const byPeriod = new Map();
  for (const revision of revisions) {
    const { measure_id, period_key, status } = revision;
    if (measure_id !== measureId) continue;

    let selected = byPeriod.get(period_key);
    if (!selected) {
      selected = {};
      byPeriod.set(period_key, selected);
    }
    if (!selected.latest || selected.latest.revision < revision.revision) selected.latest = revision;
    if (
      (status === "approved" || status === "submitted") &&
      (!selected[status] || selected[status].revision < revision.revision)
    ) {
      selected[status] = revision;
    }
  }
  return byPeriod;
}

export function deadlineFlag(source, { active, deadline, today, completed }) {
  if (completed) return null;

  const remaining = daysBetween(today, deadline);
  if (remaining < 0) {
    return {
      ...source,
      ruleCode: "overdue",
      sourceValues: { deadline, today, daysOverdue: -remaining },
      explanation: "Строк виконання минув, а погодженого повного результату немає.",
      suggestedAction: "Уточніть причину прострочення й узгодьте подальші дії.",
    };
  }
  if (active && remaining <= 7) {
    return {
      ...source,
      ruleCode: "due_soon",
      sourceValues: { deadline, today, daysRemaining: remaining },
      explanation: remaining === 0 ? "Строк виконання спливає сьогодні." : "Наближається строк виконання.",
      suggestedAction: "Нагадайте виконавцю подати результат до завершення строку.",
    };
  }
  return null;
}

function evidenceFlag(source, result, evidenceByResult) {
  const evidence = evidenceByResult.get(result.id);
  if (!Array.isArray(evidence)) {
    throw new TypeError("Current evidence must be checked for the selected result");
  }

  let issue;
  let explanation;
  if (evidence.length === 0) {
    issue = "no_current_evidence";
    explanation = "До результату не додано актуального доказу.";
  } else if (evidence.some((file) => file.missingFile)) {
    issue = "missing_file";
    explanation = "Файл актуального доказу відсутній у сховищі.";
  } else if (evidence.some((file) => !file.intact)) {
    issue = "integrity_failed";
    explanation = "Не вдалося підтвердити цілісність актуального доказу.";
  } else {
    return null;
  }
  return {
    ...source,
    resultId: result.id,
    ruleCode: "missing_evidence",
    sourceValues: { revision: result.revision, issue },
    explanation,
    suggestedAction: result.status === "submitted"
      ? "Перевірте доказ і за потреби поверніть результат для додавання справного файла."
      : "Перевірте сховище доказів і зафіксуйте причину відсутності або порушення цілісності файла.",
  };
}

function indicatorFlags(source, plan, result) {
  if (result.outcome !== "completed" && result.outcome !== "partial") return [];
  if (!Number.isFinite(result.measured_value)) return [];

  const actual = Number(result.measured_value.toFixed(6));
  const target = Number(plan.target.toFixed(6));
  const baseline = Number(plan.baseline.toFixed(6));
  const { direction } = plan;
  const comparison = {
    ...source,
    resultId: result.id,
    sourceValues: { revision: result.revision, baseline, target, actual, direction },
  };
  const targetMissed = {
    increase: actual < target,
    decrease: actual > target,
    maintain: actual !== target,
  }[direction];
  const noImprovement = {
    increase: actual <= baseline,
    decrease: actual >= baseline,
  }[direction];

  const flags = [];
  if (targetMissed) {
    flags.push({
      ...comparison,
      ruleCode: "target_not_met",
      explanation: "Виміряне значення не відповідає цілі індикатора.",
      suggestedAction: "Звірте вимірювання з ціллю й уточніть потрібні дії.",
    });
  }
  if (result.outcome === "completed" && noImprovement) {
    flags.push({
      ...comparison,
      ruleCode: "closed_without_improvement",
      explanation: "Захід погоджено як виконаний, але індикатор не покращився відносно базового значення.",
      suggestedAction: "Перевірте, чи виміряний результат відповідає очікуваному покращенню.",
    });
  }
  return flags;
}

// Callers supply authorized periods, result IDs and, when selected, evidence integrity.
export function evaluateRiskFlags(entries, { today = kyivDate, ruleCode } = {}) {
  const asOf = today();
  const includes = (code) => ruleCode === undefined || ruleCode === code;
  const items = [];
  let overdue = 0;
  const overdueMeasureIds = new Set();

  for (const {
    plan,
    revisions = [],
    evidenceByResult = new Map(),
    allowedPeriodKeys,
    allowedResultIds,
  } of entries) {
    const byPeriod = selectRevisions(plan.id, revisions);
    for (const { periodKey, deadline } of startedDeadlines(plan, asOf)) {
      if (allowedPeriodKeys && !allowedPeriodKeys.has(periodKey)) continue;

      const { approved, submitted } = byPeriod.get(periodKey) ?? {};
      const source = { measureId: plan.id, periodKey };
      const timing = deadlineFlag(source, {
        active: plan.active,
        deadline,
        today: asOf,
        completed: approved?.outcome === "completed",
      });
      if (timing) {
        if (includes(timing.ruleCode)) items.push(timing);
        if (timing.ruleCode === "overdue") {
          overdue += 1;
          overdueMeasureIds.add(plan.id);
        }
      }
      const evidenceResult = submitted ?? approved;
      if (includes("missing_evidence") && evidenceResult &&
          (!allowedResultIds || allowedResultIds.has(evidenceResult.id))) {
        const flag = evidenceFlag(source, evidenceResult, evidenceByResult);
        if (flag) items.push(flag);
      }
      if ((includes("target_not_met") || includes("closed_without_improvement")) &&
          approved && (!allowedResultIds || allowedResultIds.has(approved.id))) {
        items.push(...indicatorFlags(source, plan, approved).filter((flag) => includes(flag.ruleCode)));
      }
    }
  }
  return { asOf, counts: { overdue, overdueMeasures: overdueMeasureIds.size }, items };
}
