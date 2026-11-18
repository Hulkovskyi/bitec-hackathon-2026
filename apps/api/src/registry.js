import { randomUUID, createHash } from "node:crypto";
import { transaction } from "./database.js";
import {
  ApiError,
  invalid,
  keys,
  text,
  uuid,
  date,
  choice,
  flag,
  positive,
} from "./validation.js";

export const measureFields = [
  "sectionId",
  "departmentId",
  "executorId",
  "riskId",
  "code",
  "title",
  "description",
  "scheduleType",
  "plannedDate",
  "indicator",
];
export const roles = ["executor", "coordinator", "leader", "analyst", "admin"];
export const missing = () => {
  throw new ApiError(404, "not_found", "Запис не знайдено");
};
export const forbidden = () => {
  throw new ApiError(403, "forbidden", "Дія недоступна");
};
export function scope(db, user, programId, departmentId) {
  return (
    user.role === "admin" ||
    !!db
      .prepare(
        "SELECT 1 FROM user_scopes WHERE user_id=? AND program_id=? AND department_id=?",
      )
      .get(user.id, programId, departmentId)
  );
}
export function access(user) {
  if (user.role === "admin") return { sql: "1=1", params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM user_scopes us WHERE us.user_id=? AND us.program_id=s.program_id AND us.department_id=m.department_id)${user.role === "executor" ? " AND m.executor_id=?" : ""}`,
    params: user.role === "executor" ? [user.id, user.id] : [user.id],
  };
}
export const selectMeasure = `SELECT m.*,s.program_id,i.id AS indicator_id,i.title AS indicator_title,i.unit,i.baseline,i.target,i.direction FROM measures m JOIN sections s ON s.id=m.section_id JOIN indicators i ON i.measure_id=m.id`;
export function measure(row) {
  return {
    id: row.id,
    programId: row.program_id,
    sectionId: row.section_id,
    departmentId: row.department_id,
    executorId: row.executor_id,
    riskId: row.risk_id,
    code: row.code,
    title: row.title,
    description: row.description,
    scheduleType: row.schedule_type,
    plannedDate: row.planned_date,
    active: !!row.active,
    effectiveFrom: row.effective_from,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    indicator: {
      id: row.indicator_id,
      title: row.indicator_title,
      unit: row.unit,
      baseline: row.baseline,
      target: row.target,
      direction: row.direction,
    },
  };
}
export function getMeasure(db, user, id) {
  const rule = access(user);
  const row = db
    .prepare(`${selectMeasure} WHERE m.id=? AND ${rule.sql}`)
    .get(id, ...rule.params);
  return row ? measure(row) : missing();
}
export function audit(db, actor, action, entityType, entityId, before, after) {
  db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)").run(
    randomUUID(),
    actor,
    action,
    entityType,
    entityId,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    new Date().toISOString(),
  );
}
export function kyivDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function validateMeasure(
  db,
  input,
  user,
  oldProgram,
  today = kyivDate(),
) {
  const value = {
    ...input,
    sectionId: uuid(input.sectionId),
    departmentId: uuid(input.departmentId),
    executorId: uuid(input.executorId),
    riskId: input.riskId === null ? null : uuid(input.riskId),
    code: text(input.code, 50),
    title: text(input.title),
    description: text(input.description, 4000, true),
    scheduleType: choice(input.scheduleType, ["one_time", "continuous"]),
  };
  const section = db
    .prepare(
      "SELECT s.*,p.period_start,p.period_end FROM sections s JOIN programs p ON p.id=s.program_id WHERE s.id=?",
    )
    .get(value.sectionId);
  if (!section || (oldProgram && oldProgram !== section.program_id))
    invalid("Некоректний розділ");
  const department = db
    .prepare("SELECT * FROM departments WHERE id=?")
    .get(value.departmentId);
  if (!department || department.program_id !== section.program_id)
    invalid("Некоректний підрозділ");
  if (user && !scope(db, user, section.program_id, value.departmentId))
    forbidden();
  const executor = db
    .prepare(
      "SELECT 1 FROM users u JOIN user_scopes us ON us.user_id=u.id WHERE u.id=? AND u.active=1 AND u.role='executor' AND us.program_id=? AND us.department_id=?",
    )
    .get(value.executorId, section.program_id, value.departmentId);
  if (!executor) invalid("Виконавець недоступний у вибраному підрозділі");
  if (section.code === 2) {
    if (
      !value.riskId ||
      !db
        .prepare("SELECT 1 FROM risks WHERE id=? AND program_id=?")
        .get(value.riskId, section.program_id)
    )
      invalid("Оберіть ризик цієї програми");
  } else if (value.riskId !== null)
    invalid("Ризик дозволений лише для розділу 2");
  value.effectiveFrom =
    input.effectiveFrom === undefined
      ? today > section.period_start
        ? today
        : section.period_start
      : date(input.effectiveFrom);
  if (
    value.effectiveFrom < section.period_start ||
    value.effectiveFrom > section.period_end
  )
    invalid("Початок дії поза періодом програми");
  if (value.scheduleType === "one_time") {
    value.plannedDate = date(input.plannedDate);
    if (
      value.plannedDate < value.effectiveFrom ||
      value.plannedDate > section.period_end
    )
      invalid("Дата поза періодом програми");
  } else if (input.plannedDate !== null)
    invalid("Постійний захід не має планової дати");
  const i = input.indicator;
  keys(
    i,
    ["title", "unit", "baseline", "target", "direction"],
    ["title", "unit", "baseline", "target", "direction"],
  );
  if (
    ![i.baseline, i.target].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  )
    invalid("Значення індикатора мають бути скінченними числами");
  choice(i.direction, ["increase", "decrease", "maintain"]);
  if (
    (i.direction === "increase" && i.target < i.baseline) ||
    (i.direction === "decrease" && i.target > i.baseline) ||
    (i.direction === "maintain" && i.target !== i.baseline)
  )
    invalid("Ціль не відповідає напряму індикатора");
  value.indicator = { ...i, title: text(i.title), unit: text(i.unit, 50) };
  return value;
}
export function stableIndicatorId(measureId) {
  const hex = createHash("sha256")
    .update("indicator:" + measureId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function insertMeasure(
  db,
  value,
  id = randomUUID(),
  indicatorId = randomUUID(),
) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO measures VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    value.sectionId,
    value.departmentId,
    value.executorId,
    value.riskId,
    value.code,
    value.title,
    value.description,
    value.scheduleType,
    value.plannedDate,
    1,
    1,
    value.effectiveFrom,
    now,
    now,
  );
  const i = value.indicator;
  db.prepare("INSERT INTO indicators VALUES (?,?,?,?,?,?,?)").run(
    indicatorId,
    id,
    i.title,
    i.unit,
    i.baseline,
    i.target,
    i.direction,
  );
  return id;
}
export function saveMeasure(db, user, input, id, { today = kyivDate } = {}) {
  if (user.role !== "coordinator") forbidden();
  keys(
    input,
    id ? [...measureFields, "version", "active"] : measureFields,
    id ? ["version"] : measureFields,
  );
  if (id) positive(input.version);
  if (Object.hasOwn(input, "active")) flag(input.active);
  return transaction(db, () => {
    const before = id ? getMeasure(db, user, id) : null;
    if (before && before.version !== input.version)
      throw new ApiError(
        409,
        "version_conflict",
        "Запис змінено. Оновіть картку та повторіть редагування.",
      );
    const combined = before
      ? { ...before, indicator: { ...before.indicator }, ...input }
      : input;
    if (before && !Object.hasOwn(input, "indicator"))
      delete combined.indicator.id;
    const value = validateMeasure(
      db,
      combined,
      user,
      before?.programId,
      today(),
    );
    if (!id) id = insertMeasure(db, value);
    else {
      const result = db
        .prepare(
          "UPDATE measures SET section_id=?,department_id=?,executor_id=?,risk_id=?,code=?,title=?,description=?,schedule_type=?,planned_date=?,active=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        )
        .run(
          value.sectionId,
          value.departmentId,
          value.executorId,
          value.riskId,
          value.code,
          value.title,
          value.description,
          value.scheduleType,
          value.plannedDate,
          Number(value.active),
          new Date().toISOString(),
          id,
          input.version,
        );
      if (!result.changes)
        throw new ApiError(409, "version_conflict", "Запис змінено");
      const i = value.indicator;
      db.prepare(
        "UPDATE indicators SET title=?,unit=?,baseline=?,target=?,direction=? WHERE measure_id=?",
      ).run(i.title, i.unit, i.baseline, i.target, i.direction, id);
    }
    const after = getMeasure(db, user, id);
    audit(
      db,
      user.id,
      before ? "update" : "create",
      "measure",
      id,
      before,
      after,
    );
    return after;
  });
}

const importGroups = [
  "programs",
  "sections",
  "departments",
  "users",
  "scopes",
  "risks",
  "measures",
];
export function importRegistry(
  db,
  actor,
  payload,
  { seed = false, inTransaction = false } = {},
) {
  keys(
    payload,
    ["schemaVersion", "synthetic", ...importGroups],
    ["schemaVersion", "synthetic", ...importGroups],
  );
  if (
    payload.schemaVersion !== 1 ||
    payload.synthetic !== true ||
    importGroups.some((g) => !Array.isArray(payload[g]))
  )
    invalid("Потрібен синтетичний пакет v1");
  if (
    importGroups.reduce((sum, g) => sum + payload[g].length, 0) +
      payload.measures.length >
    1000
  )
    throw new ApiError(413, "payload_too_large", "Не більше 1000 записів");
  const ids = new Set();
  for (const group of importGroups.filter((g) => g !== "scopes"))
    for (const row of payload[group]) {
      const id = uuid(row?.id);
      if (ids.has(id))
        throw new ApiError(409, "duplicate_code", "Повторний ідентифікатор");
      ids.add(id);
    }
  const perform = () => {
    if (!seed) {
      for (const id of ids)
        for (const table of [
          ...importGroups.filter((g) => g !== "scopes"),
          "indicators",
        ]) {
          if (db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id))
            throw new ApiError(
              409,
              "duplicate_code",
              "Ідентифікатор уже існує",
            );
        }
    }
    const created = Object.fromEntries(
      [...importGroups, "indicators"].map((g) => [g, 0]),
    );
    const record = (group, row, insert) => {
      insert();
      created[group]++;
    };
    for (const r of payload.programs) {
      keys(
        r,
        ["id", "code", "title", "periodStart", "periodEnd"],
        ["id", "code", "title", "periodStart", "periodEnd"],
      );
      const start = date(r.periodStart),
        end = date(r.periodEnd);
      if (start > end) invalid();
      if (payload.sections.filter((s) => s.programId === r.id).length !== 3)
        invalid("Для програми потрібні три розділи");
      record("programs", r, () =>
        db
          .prepare("INSERT INTO programs VALUES (?,?,?,?,?)")
          .run(uuid(r.id), text(r.code, 50), text(r.title), start, end),
      );
    }
    for (const r of payload.users) {
      keys(
        r,
        ["id", "displayName", "role", "active"],
        ["id", "displayName", "role", "active"],
      );
      record("users", r, () =>
        db
          .prepare("INSERT INTO users VALUES (?,?,?,?)")
          .run(
            uuid(r.id),
            text(r.displayName),
            choice(r.role, roles),
            Number(flag(r.active)),
          ),
      );
    }
    for (const group of ["sections", "departments", "risks"])
      for (const r of payload[group]) {
        keys(
          r,
          ["id", "programId", "code", "title"],
          ["id", "programId", "code", "title"],
        );
        record(group, r, () =>
          db
            .prepare(`INSERT INTO ${group} VALUES (?,?,?,?)`)
            .run(
              uuid(r.id),
              uuid(r.programId),
              group === "sections"
                ? choice(r.code, [1, 2, 3])
                : text(r.code, 50),
              text(r.title),
            ),
        );
      }
    for (const r of payload.scopes) {
      keys(
        r,
        ["userId", "programId", "departmentId"],
        ["userId", "programId", "departmentId"],
      );
      const args = [uuid(r.userId), uuid(r.programId), uuid(r.departmentId)];
      db.prepare("INSERT INTO user_scopes VALUES (?,?,?)").run(...args);
      created.scopes++;
    }
    for (const r of payload.measures) {
      keys(
        r,
        ["id", "effectiveFrom", ...measureFields],
        ["id", "effectiveFrom", ...measureFields],
      );
      record("measures", r, () => {
        const value = validateMeasure(db, r, null);
        insertMeasure(
          db,
          value,
          uuid(r.id),
          seed ? stableIndicatorId(r.id) : randomUUID(),
        );
        created.indicators++;
      });
    }
    if (!seed) {
      for (const group of importGroups)
        for (const row of payload[group]) {
          const after =
            group === "measures"
              ? getMeasure(db, { id: actor, role: "admin" }, uuid(row.id))
              : row;
          audit(
            db,
            actor,
            "import_create",
            group === "measures" ? "measure" : group,
            row.id || `${row.userId}/${row.programId}/${row.departmentId}`,
            null,
            after,
          );
          if (group === "measures")
            audit(
              db,
              actor,
              "import_create",
              "indicator",
              after.indicator.id,
              null,
              after.indicator,
            );
        }
      audit(db, actor, "import", "registry", randomUUID(), null, created);
    }
    return { created };
  };
  return inTransaction ? perform() : transaction(db, perform);
}
