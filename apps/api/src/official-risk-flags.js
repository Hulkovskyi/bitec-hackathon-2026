import { hasPermission } from "./permissions.js";
import { measureScope } from "./registry.js";
import { meetsIndicatorTarget } from "./risk-flags.js";

const rules = {
  RF1: [
    "Звітний строк минув, а захід не виконано повністю.",
    "Уточніть причину прострочення та визначте строк завершення.",
  ],
  RF2: [
    "У синтетичному архіві для заявленого виконання немає жодного запису про доказ.",
    "Запитайте у виконавця підтвердження результату.",
  ],
  RF3: [
    "Захід другого розділу позначено виконаним, а індикатор ризику пройшов менш ніж 10% шляху до цілі.",
    "Перевірте, чи вплинув захід на ризик, і визначте додаткові дії.",
  ],
  RF4: [
    "Опис повторює зміст заходу і не містить чисел або посилань.",
    "Уточніть вимірюваний результат і додайте посилання на підтвердження.",
  ],
  RF5: [
    "На кінець звітного періоду фактичне значення індикатора не досягло цілі.",
    "Звірте фактичне значення з цільовим та погодьте подальшу дію.",
  ],
  RF6: [
    "Строк заходу переносили щонайменше двічі.",
    "Перевірте причини повторних перенесень і погодьте реалістичний строк.",
  ],
  RF7a: [
    "Фактична дата виконання пізніша за кінець звітного періоду.",
    "Звірте дату виконання та віднесіть результат до належного періоду.",
  ],
  RF7b: [
    "Усі підтвердні документи датовані після фактичного виконання.",
    "Перевірте, який доказ підтверджував результат на дату виконання.",
  ],
  RF7c: [
    "Для невиконаного заходу не зазначено причину.",
    "Запропонуйте виконавцю додати пояснення до звіту.",
  ],
  RF7d: [
    "Високий або критичний ризик не має жодного заходу впливу в архіві.",
    "Розгляньте захід для зниження ризику та призначте відповідального.",
  ],
  RF7e: [
    "Для заходу з майбутнім строком заповнено опис результату.",
    "Звірте строк і стан виконання перед перенесенням даних до звіту.",
  ],
};

export const officialRiskRuleCodes = Object.keys(rules);
const outcomeNames = {
  vykonano: "Виконано",
  chastkovo: "Частково виконано",
  ne_vykonano: "Не виконано",
  v_roboti: "У роботі",
  ne_rozpochato: "Не розпочато",
};
const fallbackSource = "Поточні довідники — дані архіву недоступні";

function stems(value) {
  return new Set((value.toLowerCase().match(/[а-щьюяґєіїʼ'a-z]+/g) ?? [])
    .filter((word) => word.length >= 4)
    .map((word) => word.slice(0, 5)));
}

function similarity(description, plan) {
  const left = stems(description);
  const right = stems(plan);
  if (!left.size || !right.size) return 0;
  const common = [...left].filter((word) => right.has(word)).length;
  return common / (left.size + right.size - common);
}

function riskProgressPercent({ riskBaseline, riskTarget, riskActual }) {
  if (![riskBaseline, riskTarget, riskActual].every(Number.isFinite)) return null;
  const gap = riskTarget - riskBaseline;
  if (gap === 0) return 100;
  const percent = 100 * (riskActual - riskBaseline) / gap;
  return Number(percent.toFixed(6));
}

function subjectFlags(rows, { sourcePeriod, sourceAsOf, periodEnd, sourceSignals }, selectedRule) {
  const items = [];
  const overdueDepartments = new Map();
  const add = (subject, ruleCode, values, wording = rules[ruleCode]) => {
    if (selectedRule && selectedRule !== ruleCode) return;
    const [explanation, suggestedAction] = wording;
    items.push({
      ...subject, ruleCode, sourceValues: { ...values, periodEnd, sourceAsOf },
      explanation, suggestedAction,
    });
  };

  for (const row of rows) {
    const {
      id: measureId, code, title, departmentId, departmentCode, departmentTitle, dateBased,
      deadline, status: statusCode, actualDate, sectionCode, evidenceCount, firstEvidenceDate,
      deadlineChangeCount, measuredValue, indicatorTarget, indicatorUnit, indicatorDirection, description,
    } = row;
    const periodKey = row.currentScheduleType === "one_time" ? "once" : sourcePeriod;
    const subject = {
      measureId, subjectType: "measure", subjectId: measureId, code, title, departmentId,
      periodKey, deadline: dateBased ? deadline : periodEnd,
    };
    const status = outcomeNames[statusCode];
    const completed = statusCode === "vykonano";
    const reportedProgress = completed || statusCode === "chastkovo";
    const dueInPeriod = !dateBased || (deadline != null && deadline <= periodEnd);
    const notDue = dateBased && deadline > periodEnd && !completed;
    const hasDescription = Boolean(description.trim());

    if (dateBased && dueInPeriod && !completed) {
      add(subject, "RF1", { deadline, status });
      if (!overdueDepartments.has(departmentId)) {
        overdueDepartments.set(departmentId, { code: departmentCode, title: departmentTitle, measures: [] });
      }
      overdueDepartments.get(departmentId).measures.push(code);
    }
    if (reportedProgress && evidenceCount === 0) add(subject, "RF2", { evidenceCount, status });
    if (sectionCode === 2 && completed) {
      const progressPercent = riskProgressPercent(row);
      if (progressPercent !== null && progressPercent < 10) {
        add({ ...subject, riskId: row.riskId, riskOwnerDepartmentId: row.riskOwnerDepartmentId }, "RF3", {
          riskCode: row.riskCode, baseline: row.riskBaseline, target: row.riskTarget,
          actual: row.riskActual, unit: row.riskUnit, readingDate: row.riskReadingDate,
          progressPercent, thresholdPercent: 10,
          ...(!sourceSignals ? { riskDataSource: fallbackSource } : {}),
        });
      }
    }
    if (reportedProgress && hasDescription && !/\p{Decimal_Number}|https?:|www\./iu.test(description)) {
      const score = similarity(description, title);
      if (score >= 0.6) {
        add(subject, "RF4", { similarityPercent: Math.round(score * 100), thresholdPercent: 60, hasNumber: false, hasLink: false });
      }
    }
    if (reportedProgress && dueInPeriod && meetsIndicatorTarget(measuredValue, indicatorTarget, indicatorDirection) === false) {
      add(subject, "RF5", {
        actual: measuredValue, target: indicatorTarget, unit: indicatorUnit, direction: indicatorDirection,
        status, deadline: subject.deadline, ...(!sourceSignals ? { indicatorDataSource: fallbackSource } : {}),
      });
    }
    if (deadlineChangeCount >= 2) add(subject, "RF6", { deadlineChangeCount });
    if (actualDate && actualDate > periodEnd) add(subject, "RF7a", { actualDate });
    if (dateBased && actualDate && firstEvidenceDate && firstEvidenceDate > actualDate) {
      add(subject, "RF7b", { actualDate, firstEvidenceDate, evidenceCount });
    }
    if (!reportedProgress && !notDue && !hasDescription) add(subject, "RF7c", { status, descriptionPresent: false });
    if (notDue && hasDescription) add(subject, "RF7e", { status, deadline, descriptionPresent: true });
  }

  for (const [departmentId, { code, title, measures }] of overdueDepartments) {
    if (measures.length < 2) continue;
    add({
      subjectType: "department", subjectId: departmentId, departmentId, code, title,
      periodKey: sourcePeriod, deadline: periodEnd,
    }, "RF6", { overdueCount: measures.length, overdueCodes: measures.sort().join(", ") }, [
      "У підрозділі є щонайменше два доступні прострочені заходи.",
      "Уточніть спільні причини прострочень із керівником підрозділу.",
    ]);
  }
  return items;
}

function riskOwnerScope(user, sourceSignals) {
  if (!hasPermission(user, "risks.read")) return { sql: "AND 1=0", params: [] };
  if (user.role === "admin") return { sql: "", params: [] };
  const sql = `
    AND EXISTS (
      SELECT 1 FROM user_scopes owner WHERE owner.user_id=? AND owner.program_id=ri.program_id
        AND owner.department_id=ri.owner_department_id
    )
    ${sourceSignals ? `AND EXISTS (
      SELECT 1 FROM risk_indicators current_indicator
      JOIN user_scopes current_owner ON current_owner.program_id=current_indicator.program_id
        AND current_owner.department_id=current_indicator.owner_department_id
      WHERE current_indicator.risk_id=ri.risk_id AND current_owner.user_id=?
    )` : ""}
  `;
  return { sql, params: sourceSignals ? [user.id, user.id] : [user.id] };
}

async function readArchiveMeasures(db, user, {
  programId, departmentId, sourcePeriod, sourceAsOf, periodEnd, sourceSignals,
}) {
  const visible = measureScope(user);
  const riskAccess = riskOwnerScope(user, sourceSignals);
  const historicalDepartmentAccess = user.role === "admin" ? "" : `AND EXISTS (
    SELECT 1 FROM user_scopes historic
    WHERE historic.user_id=? AND historic.program_id=o.program_id
      AND historic.department_id=o.source_department_id
  )`;
  const executorRestriction = user.role !== "executor" ? "" : `
    AND COALESCE(
      (SELECT assigned.executor_id FROM period_assignments assigned
       WHERE assigned.measure_id=m.id AND assigned.period_key=CASE WHEN m.schedule_type='one_time' THEN 'once' ELSE oresult.source_period END),
      m.executor_id
    )=? AND (oresult.source_user_id IS NULL OR oresult.source_user_id=?)`;
  const riskColumns = sourceSignals ?
    'ri.code AS "riskCode", ri.actual AS "riskActual", ri.reading_on AS "riskReadingDate"' :
    'r.code AS "riskCode", rm.value AS "riskActual", rm.reading_on AS "riskReadingDate"';
  const riskJoin = sourceSignals ? `
    LEFT JOIN official_risk_metadata ri ON ri.risk_id=o.source_risk_id AND ri.program_id=o.program_id
      AND ri.baseline_on<=? ${riskAccess.sql}` : `
    LEFT JOIN risks r ON r.id=m.risk_id AND r.program_id=o.program_id
    LEFT JOIN risk_indicators ri ON ri.risk_id=r.id AND ri.baseline_on<=? ${riskAccess.sql}
    LEFT JOIN risk_measurements rm ON rm.id=(
      SELECT reading.id FROM risk_measurements reading WHERE reading.risk_id=ri.risk_id AND reading.reading_on<=?
        AND reading.actor_id IS NULL
      ORDER BY reading.reading_on DESC LIMIT 1
    )`;
  return db.prepare(`
    SELECT m.id, COALESCE(o.source_code,m.code) AS code, o.source_title AS "title",
      o.source_section_code AS "sectionCode",
      m.schedule_type AS "currentScheduleType", o.source_schedule_type='one_time' AS "dateBased",
      o.source_department_id AS "departmentId", COALESCE(o.source_department_code,d.code) AS "departmentCode",
      o.source_department_title AS "departmentTitle", o.source_planned_date AS "deadline",
      oresult.source_status AS "status", oresult.source_actual_date AS "actualDate",
      oresult.description, oresult.measured_value AS "measuredValue", o.indicator_target AS "indicatorTarget",
      o.indicator_unit AS "indicatorUnit", ${sourceSignals ? "o.source_indicator_direction" : "i.direction"} AS "indicatorDirection",
      (SELECT count(*) FROM official_evidence_claims e WHERE e.measure_id=m.id) AS "evidenceCount",
      (SELECT min(e.document_date) FROM official_evidence_claims e WHERE e.measure_id=m.id) AS "firstEvidenceDate",
      (SELECT count(*) FROM official_deadline_changes c WHERE c.measure_id=m.id AND c.decision_date<=?) AS "deadlineChangeCount",
      ri.risk_id AS "riskId", ri.owner_department_id AS "riskOwnerDepartmentId",
      ri.baseline AS "riskBaseline", ri.target AS "riskTarget", ri.unit AS "riskUnit", ${riskColumns}
    FROM official_measure_metadata o
    JOIN official_measure_results oresult ON oresult.measure_id=o.measure_id AND oresult.program_id=o.program_id
    JOIN measures m ON m.id=o.measure_id
    JOIN sections s ON s.id=m.section_id AND s.program_id=o.program_id
    JOIN departments d ON d.id=o.source_department_id AND d.program_id=o.program_id
    ${sourceSignals ? "" : "LEFT JOIN indicators i ON i.measure_id=m.id"}
    ${riskJoin}
    WHERE o.program_id=? AND oresult.source_period=? AND ${visible.sql}
      ${historicalDepartmentAccess} ${executorRestriction}
      ${departmentId ? "AND o.source_department_id=?" : ""}
    ORDER BY o.section_order, COALESCE(o.source_code,m.code), m.id
  `).all(
    sourceAsOf, periodEnd, ...riskAccess.params, ...(sourceSignals ? [] : [periodEnd]),
    programId, sourcePeriod, ...visible.params,
    ...(user.role === "admin" ? [] : [user.id]),
    ...(user.role === "executor" ? [user.id, user.id] : []),
    ...(departmentId ? [departmentId] : []),
  );
}

async function readUnaddressedRisks(db, user, {
  programId, departmentId, sourcePeriod, sourceAsOf, periodEnd, sourceSignals,
}) {
  if (!hasPermission(user, "risks.read")) return [];
  const ownership = riskOwnerScope(user, sourceSignals);
  const riskTable = sourceSignals ? "official_risk_metadata" : "risk_indicators";
  const link = sourceSignals ? "o.source_risk_id" : "m.risk_id";
  const rows = await db.prepare(`
    SELECT r.id, ${sourceSignals ? "ri.code, ri.title" : "r.code, r.title"}, ri.owner_department_id AS "departmentId",
      ri.likelihood*ri.impact AS score
    FROM risks r JOIN ${riskTable} ri ON ri.risk_id=r.id AND ri.program_id=r.program_id
    WHERE r.program_id=? AND ri.likelihood*ri.impact>=6 AND ri.baseline_on<=?
      ${ownership.sql} ${departmentId ? "AND ri.owner_department_id=?" : ""}
      AND NOT EXISTS (
        SELECT 1 FROM official_measure_metadata o ${sourceSignals ? "" : "JOIN measures m ON m.id=o.measure_id"}
        WHERE o.program_id=r.program_id AND ${link}=r.id
      )
    ORDER BY ${sourceSignals ? "ri.code" : "r.code"},r.id
  `).all(
    programId, periodEnd, ...ownership.params,
    ...(departmentId ? [departmentId] : []),
  );
  return rows.map(({ id, code, title, departmentId: owner, score }) => ({
    subjectType: "risk", subjectId: id, code, title, departmentId: owner, periodKey: sourcePeriod,
    deadline: periodEnd, ruleCode: "RF7d",
    sourceValues: {
      riskScore: score, riskLevel: score >= 12 ? "Критичний" : "Високий",
      linkedMeasureCount: 0, periodEnd, sourceAsOf,
      ...(!sourceSignals ? { riskDataSource: fallbackSource } : {}),
    },
    explanation: rules.RF7d[0], suggestedAction: rules.RF7d[1],
  }));
}

// Archive rules deliberately use the source half-year and never reclassify historical
// claims as live workflow decisions. The caller authorizes the requested program.
export async function readOfficialRiskFlags(db, user, { programId, departmentId, asOf, ruleCode }) {
  const batch = await db.prepare(`
    SELECT source_period AS "sourcePeriod",source_as_of AS "sourceAsOf",source_signals AS "sourceSignals"
    FROM official_dataset_batches WHERE program_id=? AND source_as_of<=?
  `).get(programId, asOf);
  if (!batch) return [];
  const year = batch.sourcePeriod.slice(0, 4);
  const periodEnd = year + (batch.sourcePeriod.endsWith("H1") ? "-06-30" : "-12-31");
  const archive = { ...batch, periodEnd, programId, departmentId };
  const items = ruleCode === "RF7d" ? [] : subjectFlags(await readArchiveMeasures(db, user, archive), archive, ruleCode);
  if (!ruleCode || ruleCode === "RF7d") items.push(...await readUnaddressedRisks(db, user, archive));
  return items;
}
