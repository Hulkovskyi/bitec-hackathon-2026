import { randomUUID } from "node:crypto";
import { access, audit, forbidden, missing, programAllowed, riskCatalogScope, scope } from "./registry.js";
import { hasPermission } from "./permissions.js";
import { ApiError, choice, date, flag, invalid, keys, text, uuid } from "./validation.js";

const passportMetadata = [
  "goals", "organization", "approvalReference", "nazkApprovalStatus", "notes",
  "restrictedInformation", "coordinatorDepartmentId",
];
const indicatorRequired = [
  "ownerDepartmentId", "title", "unit", "direction", "baseline", "baselineDate", "target", "targetDate",
];
const optionalText = (value, size) => value == null ? null : text(value, size, true) || null;

function number(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("Некоректне числове значення");
  return value;
}

async function assertDepartment(db, id, programId) {
  const found = await db.prepare("SELECT 1 FROM departments WHERE id=? AND program_id=?").get(id, programId);
  if (!found) invalid("Підрозділ не належить програмі");
}

async function readPassport(db, user, programId, today) {
  await programAllowed(db, user, programId);
  const row = await db.prepare(`
    SELECT p.id, p.code, p.title, p.period_start, p.period_end, pp.goals, pp.organization,
           pp.approval_reference, pp.nazk_approval_status, pp.notes, pp.restricted_information,
           pp.coordinator_department_id, d.title AS coordinator_department_title
    FROM programs p LEFT JOIN program_passports pp ON pp.program_id=p.id
    LEFT JOIN departments d ON d.id=pp.coordinator_department_id AND d.program_id=p.id
    WHERE p.id=?
  `).get(programId);
  const visible = access(user, { today });
  const sections = await db.prepare(`
    SELECT s.id, s.code, s.title,
      (SELECT count(*) FROM measures m WHERE m.section_id=s.id AND ${visible.sql}) AS measure_count
    FROM sections s WHERE s.program_id=? ORDER BY s.code, s.id
  `).all(...visible.params, programId);
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    goals: row.goals ?? "",
    organization: row.organization,
    approvalReference: row.approval_reference,
    nazkApprovalStatus: row.nazk_approval_status,
    notes: row.notes,
    restrictedInformation: Boolean(row.restricted_information),
    coordinatorDepartmentId: row.coordinator_department_id,
    coordinatorDepartmentTitle: row.coordinator_department_title,
    canEdit: hasPermission(user, "program.write"),
    sections: sections.map(({ id, code, title, measure_count }) => ({ id, code, title, measureCount: measure_count })),
  };
}

function passportInput(input) {
  keys(input, passportMetadata, ["goals"]);
  return {
    goals: text(input.goals, 4000),
    organization: optionalText(input.organization, 240),
    approvalReference: optionalText(input.approvalReference, 240),
    nazkApprovalStatus: optionalText(input.nazkApprovalStatus, 180),
    notes: optionalText(input.notes, 1200),
    restrictedInformation: input.restrictedInformation === undefined ? false : flag(input.restrictedInformation),
    coordinatorDepartmentId: input.coordinatorDepartmentId == null ? null : uuid(input.coordinatorDepartmentId),
  };
}

async function savePassport(db, user, programId, input, today) {
  if (!hasPermission(user, "program.write")) forbidden();
  const next = passportInput(input);
  const before = await readPassport(db, user, programId, today);
  if (next.coordinatorDepartmentId) {
    await assertDepartment(db, next.coordinatorDepartmentId, programId);
    if (!(await scope(db, user, programId, next.coordinatorDepartmentId))) forbidden();
  }
  await db.prepare(`
    INSERT INTO program_passports (
      program_id, goals, organization, approval_reference, nazk_approval_status,
      notes, restricted_information, coordinator_department_id
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (program_id) DO UPDATE SET
      goals=excluded.goals, organization=excluded.organization, approval_reference=excluded.approval_reference,
      nazk_approval_status=excluded.nazk_approval_status, notes=excluded.notes,
      restricted_information=excluded.restricted_information, coordinator_department_id=excluded.coordinator_department_id
  `).run(programId, next.goals, next.organization, next.approvalReference, next.nazkApprovalStatus,
    next.notes, Number(next.restrictedInformation), next.coordinatorDepartmentId);
  const previous = Object.fromEntries(passportMetadata.map((key) => [key, before[key]]));
  await audit(db, user.id, before.goals ? "update" : "create", "program_passport", programId, before.goals ? previous : null, next);
  return readPassport(db, user, programId, today);
}

function readingPayload(row) {
  return { id: row.id, readingDate: row.reading_on, value: row.value, source: row.source };
}

function indicatorPayload(row) {
  if (!row.owner_department_id) return null;
  return {
    title: row.indicator_title,
    unit: row.unit,
    direction: row.direction,
    baseline: row.baseline,
    baselineDate: row.baseline_on,
    target: row.target,
    targetDate: row.target_on,
  };
}

function riskPayload(row, readings, user) {
  const score = row.likelihood === null ? null : row.likelihood * row.impact;
  let level = null;
  if (score !== null) {
    level = score <= 2 ? "low" : score <= 4 ? "medium" : score <= 9 ? "high" : "critical";
  }
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description ?? "",
    ownerDepartmentId: row.owner_department_id,
    ownerDepartmentTitle: row.owner_department_title,
    indicator: indicatorPayload(row),
    likelihood: row.likelihood,
    impact: row.impact,
    score,
    level,
    readings,
    latestReading: readings[0] ?? null,
    canMeasure: Boolean(row.owner_department_id && row.owns_department && hasPermission(user, "risks.measure")),
    canEditIndicator: (!row.owner_department_id || Boolean(row.owns_department)) && hasPermission(user, "risks.write"),
  };
}

async function readRisks(db, user, programId, riskId = null) {
  if (!hasPermission(user, "risks.read")) forbidden();
  await programAllowed(db, user, programId);
  const admin = user.role === "admin";
  const ownerScope = `EXISTS (
    SELECT 1 FROM user_scopes us
    WHERE us.user_id=? AND us.program_id=r.program_id AND us.department_id=ri.owner_department_id
  )`;
  const visible = riskCatalogScope(user);
  const rows = await db.prepare(`
    SELECT r.id, r.code, r.title, ri.title AS indicator_title, ri.unit, ri.direction, ri.baseline,
           ri.baseline_on, ri.target, ri.target_on, ri.description, ri.likelihood, ri.impact,
           ri.owner_department_id, d.title AS owner_department_title,
           ${admin ? "1" : ownerScope} AS owns_department
    FROM risks r LEFT JOIN risk_indicators ri ON ri.risk_id=r.id
    LEFT JOIN departments d ON d.id=ri.owner_department_id AND d.program_id=r.program_id
    WHERE r.program_id=? ${riskId === null ? "" : "AND r.id=?"}
      AND ${visible.sql}
    ORDER BY r.code, r.id
  `).all(...(admin ? [] : [user.id]), programId, ...(riskId === null ? [] : [riskId]),
    ...visible.params);
  if (!rows.length && riskId !== null) missing();
  const readingsForRisk = db.prepare(`
    SELECT id, reading_on, value, source FROM risk_measurements
    WHERE risk_id=? ORDER BY reading_on DESC, id
  `);
  const items = [];
  for (const row of rows) {
    const readings = row.owner_department_id ? (await readingsForRisk.all(row.id)).map(readingPayload) : [];
    items.push(riskPayload(row, readings, user));
  }
  return items;
}

function indicatorInput(input, today) {
  keys(input, [...indicatorRequired, "description", "likelihood", "impact"], indicatorRequired);
  const direction = choice(input.direction, ["increase", "decrease"]);
  const baseline = number(input.baseline);
  const target = number(input.target);
  const baselineDate = date(input.baselineDate);
  const targetDate = date(input.targetDate);
  if (baselineDate > today || targetDate < baselineDate ||
      (direction === "increase" ? target < baseline : target > baseline)) {
    invalid("Базове й цільове значення або їхні дати не відповідають напряму індикатора");
  }
  const likelihood = input.likelihood ?? null;
  const impact = input.impact ?? null;
  if ((likelihood !== null || impact !== null) &&
      ![likelihood, impact].every((value) => Number.isInteger(value) && value >= 1 && value <= 4)) {
    invalid("Вкажіть імовірність і наслідки від 1 до 4");
  }
  return {
    ownerDepartmentId: uuid(input.ownerDepartmentId),
    title: text(input.title, 240),
    unit: text(input.unit, 50),
    direction,
    baseline,
    baselineDate,
    target,
    targetDate,
    description: optionalText(input.description, 1200) ?? "",
    likelihood,
    impact,
  };
}

async function saveIndicator(db, user, programId, riskId, input, today) {
  if (!hasPermission(user, "risks.write")) forbidden();
  const next = indicatorInput(input, today);
  const [before] = await readRisks(db, user, programId, riskId);
  if (before.ownerDepartmentId && !(await scope(db, user, programId, before.ownerDepartmentId))) missing();
  await assertDepartment(db, next.ownerDepartmentId, programId);
  if (!(await scope(db, user, programId, next.ownerDepartmentId))) forbidden();
  if (before.readings.length > 0 &&
      ["unit", "direction", "baseline", "baselineDate"].some((key) => before.indicator[key] !== next[key])) {
    throw new ApiError(409, "indicator_has_readings", "Індикатор уже має вимірювання. Одиницю, напрям і базове значення з датою змінювати не можна.");
  }
  await db.prepare(`
    INSERT INTO risk_indicators (
      risk_id, program_id, owner_department_id, title, unit, direction, baseline, baseline_on,
      target, target_on, description, likelihood, impact
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (risk_id) DO UPDATE SET
      owner_department_id=excluded.owner_department_id, title=excluded.title, unit=excluded.unit,
      direction=excluded.direction, baseline=excluded.baseline, baseline_on=excluded.baseline_on,
      target=excluded.target, target_on=excluded.target_on, description=excluded.description,
      likelihood=excluded.likelihood, impact=excluded.impact
  `).run(riskId, programId, next.ownerDepartmentId, next.title, next.unit, next.direction,
    next.baseline, next.baselineDate, next.target, next.targetDate, next.description, next.likelihood, next.impact);
  const previous = before.indicator && {
    ...before.indicator, ownerDepartmentId: before.ownerDepartmentId, description: before.description,
    likelihood: before.likelihood, impact: before.impact,
  };
  await audit(db, user.id, previous ? "update" : "create", "risk_indicator", riskId, previous, next);
  return (await readRisks(db, user, programId, riskId))[0];
}

async function addReading(db, user, programId, riskId, input, today) {
  if (!hasPermission(user, "risks.measure")) forbidden();
  keys(input, ["readingDate", "value", "source"], ["readingDate", "value", "source"]);
  await programAllowed(db, user, programId);
  const row = await db.prepare(`
    SELECT ri.owner_department_id, ri.baseline_on
    FROM risks r LEFT JOIN risk_indicators ri ON ri.risk_id=r.id
    WHERE r.id=? AND r.program_id=?
  `).get(riskId, programId);
  if (!row || (user.role !== "admin" &&
      (!row.owner_department_id || !await scope(db, user, programId, row.owner_department_id)))) missing();
  if (!row.owner_department_id) {
    throw new ApiError(409, "risk_indicator_required", "Спочатку налаштуйте індикатор ризику");
  }
  const next = {
    id: randomUUID(), readingDate: date(input.readingDate), value: number(input.value),
    source: text(input.source, 400),
  };
  if (next.readingDate < row.baseline_on || next.readingDate > today) {
    invalid("Вимірювання має бути між базовою датою і сьогодні");
  }
  const write = await db.prepare(`
    INSERT INTO risk_measurements (id,risk_id,reading_on,value,source,actor_id)
    VALUES (?,?,?,?,?,?) ON CONFLICT (risk_id, reading_on) DO NOTHING
  `).run(next.id, riskId, next.readingDate, next.value, next.source, user.id);
  if (!write.changes) throw new ApiError(409, "reading_exists", "На цю дату вже зафіксовано вимірювання ризику");
  await audit(db, user.id, "create", "risk_measurement", next.id, null, { riskId, ...next });
  return next;
}

export function mountProgramRiskRoutes(app, db, { today }) {
  app.get("/api/programs/:id/passport", async (req, res) => {
    keys(req.query, []);
    const programId = uuid(req.params.id);
    const asOf = today();
    res.json(await db.transaction((tx) => readPassport(tx, req.user, programId, asOf), { readOnly: true }));
  });
  app.put("/api/programs/:id/passport", async (req, res) => {
    keys(req.query, []);
    res.json(await db.transaction((tx) => savePassport(tx, req.user, uuid(req.params.id), req.body, today())));
  });
  app.get("/api/programs/:id/corruption-risks", async (req, res) => {
    keys(req.query, []);
    const programId = uuid(req.params.id);
    res.json({ items: await db.transaction((tx) => readRisks(tx, req.user, programId), { readOnly: true }) });
  });
  app.put("/api/programs/:id/corruption-risks/:riskId/indicator", async (req, res) => {
    keys(req.query, []);
    const { id, riskId } = req.params;
    res.json(await db.transaction((tx) => saveIndicator(tx, req.user, uuid(id), uuid(riskId), req.body, today())));
  });
  app.post("/api/programs/:id/corruption-risks/:riskId/readings", async (req, res) => {
    keys(req.query, []);
    const { id, riskId } = req.params;
    res.status(201).json(await db.transaction((tx) => addReading(tx, req.user, uuid(id), uuid(riskId), req.body, today())));
  });
}
