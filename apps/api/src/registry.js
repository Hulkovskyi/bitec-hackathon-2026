import { randomUUID, createHash } from "node:crypto";
import { adaptDatabase } from "./database.js";
import { hasPermission } from "./permissions.js";
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
const recurrences = ["weekly", "monthly", "quarterly", "annual_april_may"];
export const roles = ["executor", "coordinator", "leader", "analyst", "admin"];
export const missing = () => {
  throw new ApiError(404, "not_found", "Запис не знайдено");
};
export const forbidden = () => {
  throw new ApiError(403, "forbidden", "Дія недоступна");
};
export async function scope(database, user, programId, departmentId) {
  if (user.role === "admin") return true;
  const row = await adaptDatabase(database).prepare(
    "SELECT 1 FROM user_scopes WHERE user_id=? AND program_id=? AND department_id=?",
  ).get(user.id, programId, departmentId);
  return Boolean(row);
}
export async function programAllowed(database, user, id) {
  const admin = user.role === "admin";
  const value = await adaptDatabase(database).prepare(`
    SELECT p.id FROM programs p WHERE p.id=?
    ${admin ? "" : "AND EXISTS (SELECT 1 FROM user_scopes us WHERE us.program_id=p.id AND us.user_id=?)"}
  `).get(...(admin ? [id] : [id, user.id]));
  if (!value) missing();
}

export function measureScope(user) {
  return user.role === "admin" ? { sql: "1=1", params: [] } : {
    sql: `EXISTS (
      SELECT 1 FROM user_scopes us
      WHERE us.user_id=? AND us.program_id=s.program_id AND us.department_id=m.department_id
    )`,
    params: [user.id],
  };
}

export function access(user, { periodKey, today = kyivDate() } = {}) {
  const { sql, params } = measureScope(user);
  const conditions = [sql];

  const currentHalf = `${today.slice(0, 4)}-H${today.slice(5, 7) <= "06" ? "1" : "2"}`;
  const period = periodKey === undefined ? currentHalf : periodKey;
  if (typeof period !== "string" || (period !== "once" && !/^\d{4}-H[12]$/.test(period)))
    invalid("Некоректний період заходу");

  const year = period.slice(0, 4);
  const halfStart = year + (period.endsWith("H1") ? "-01-01" : "-07-01");
  const halfEnd = year + (period.endsWith("H1") ? "-06-30" : "-12-31");
  const firstHalf = period.endsWith("H1");
  const annualWindow = firstHalf ? `OR (m.effective_from<=? AND p.period_end>=?)` : "";
  const continuous = `(m.schedule_type='continuous' AND m.effective_from<=?
    AND EXISTS (SELECT 1 FROM programs p WHERE p.id=s.program_id AND p.period_end>=?
      AND (m.recurrence IS NULL OR m.recurrence<>'annual_april_may' ${annualWindow})))`;

  if (periodKey === "once") {
    conditions.push("m.schedule_type='one_time'");
  } else if (periodKey !== undefined || user.role === "executor") {
    conditions.push(periodKey === undefined
      ? `(m.schedule_type='one_time' OR ${continuous})`
      : continuous);
    params.push(halfEnd, halfStart);
    if (firstHalf) params.push(`${year}-05-31`, `${year}-04-01`);
  }
  const executor = `COALESCE((
    SELECT a.executor_id FROM period_assignments a WHERE a.measure_id=m.id
    AND a.period_key=CASE WHEN m.schedule_type='one_time' THEN 'once' ELSE ? END
  ), m.executor_id)`;
  if (user.role === "executor") {
    conditions.push(`${executor}=?`);
    params.push(period, user.id);
  }
  return { sql: conditions.join(" AND "), params, executor, period };
}
const measureColumns = "m.*,s.program_id,i.id AS indicator_id,i.title AS indicator_title,i.unit,i.baseline,i.target,i.direction";
const measureTables = "FROM measures m JOIN sections s ON s.id=m.section_id JOIN indicators i ON i.measure_id=m.id";
export const selectMeasure = `SELECT ${measureColumns} ${measureTables}`;
export const selectPeriodMeasure = (rule) =>
  `SELECT ${measureColumns}, ${rule.executor} AS effective_executor_id ${measureTables}`;

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
    scheduleType: row.recurrence ? "periodic" : row.schedule_type,
    ...(row.recurrence ? { recurrence: row.recurrence } : {}),
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
export async function getMeasure(database, user, id, options) {
  const db = adaptDatabase(database);
  const rule = access(user, options);
  const row = await db
    .prepare(`${selectPeriodMeasure(rule)} WHERE m.id=? AND ${rule.sql}`)
    .get(rule.period, id, ...rule.params);
  if (!row) missing();
  const value = periodMeasure(row, user, rule.period);
  return hasPermission(user, "registry.write")
    ? { ...value, planFrozen: await planIsFrozen(db, id) }
    : value;
}

export function periodMeasure(row, user, period) {
  return {
    ...measure(row),
    executorId: row.effective_executor_id,
    periodKey: row.schedule_type === "one_time" ? "once" : period,
    ...(hasPermission(user, "registry.write") || hasPermission(user, "workflow.assign")
      ? { baseExecutorId: row.executor_id } : {}),
  };
}

// Plan writes and their audit use the stored assignment, independent of the
// current half-year or a coordinator's period filter.
async function getBaseMeasure(db, user, id) {
  const rule = access(user);
  const row = await db.prepare(`${selectMeasure} WHERE m.id=? AND ${rule.sql}`)
    .get(id, ...rule.params);
  return row ? measure(row) : missing();
}

async function planIsFrozen(db, id) {
  const row = await db.prepare(
    "SELECT 1 FROM results WHERE measure_id=? AND status IN ('submitted','approved') LIMIT 1",
  ).get(id);
  return Boolean(row);
}
export async function audit(database, actor, action, entityType, entityId, before, after) {
  await adaptDatabase(database).prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)").run(
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
export async function validateMeasure(
  database,
  input,
  user,
  oldProgram,
  today = kyivDate(),
  { allowUnspecifiedIndicators = false } = {},
) {
  const db = adaptDatabase(database);
  const value = {
    ...input,
    sectionId: uuid(input.sectionId),
    departmentId: uuid(input.departmentId),
    executorId: uuid(input.executorId),
    riskId: input.riskId === null ? null : uuid(input.riskId),
    code: text(input.code, 50),
    title: text(input.title),
    description: text(input.description, 4000, true),
    scheduleType: choice(input.scheduleType, ["one_time", "continuous", "periodic"]),
  };
  const section = await db
    .prepare(
      "SELECT s.*,p.period_start,p.period_end FROM sections s JOIN programs p ON p.id=s.program_id WHERE s.id=?",
    )
    .get(value.sectionId);
  if (!section || (oldProgram && oldProgram !== section.program_id))
    invalid("Некоректний розділ");
  const department = await db
    .prepare("SELECT * FROM departments WHERE id=?")
    .get(value.departmentId);
  if (!department || department.program_id !== section.program_id)
    invalid("Некоректний підрозділ");
  if (user && !(await scope(db, user, section.program_id, value.departmentId)))
    forbidden();
  const executor = await db
    .prepare(
      "SELECT 1 FROM users u JOIN user_scopes us ON us.user_id=u.id WHERE u.id=? AND u.active=1 AND u.role='executor' AND us.program_id=? AND us.department_id=?",
    )
    .get(value.executorId, section.program_id, value.departmentId);
  if (!executor) invalid("Виконавець недоступний у вибраному підрозділі");
  if (section.code === 2) {
    if (
      !value.riskId ||
      !(await db
        .prepare("SELECT 1 FROM risks WHERE id=? AND program_id=?")
        .get(value.riskId, section.program_id))
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
  } else if (input.plannedDate !== null) {
    invalid("Для повторюваного заходу планова дата визначається за періодом");
  }
  if (value.scheduleType === "periodic") {
    value.recurrence = choice(input.recurrence, recurrences);
    if (user && value.recurrence === "annual_april_may") {
      const end = section.period_end;
      const firstYear = Number(value.effectiveFrom.slice(0, 4)) + Number(value.effectiveFrom.slice(5) > "05-31");
      const lastYear = Number(end.slice(0, 4)) - Number(end.slice(5) < "04-01");
      if (firstYear > lastYear) invalid("У межах програми немає доступного періоду квітень–травень");
    }
  } else {
    if (input.recurrence != null) invalid("Повторюваність доступна лише для періодичного заходу");
    value.recurrence = null;
  }
  const i = input.indicator;
  keys(
    i,
    ["title", "unit", "baseline", "target", "direction"],
    ["title", "unit", "baseline", "target", "direction"],
  );
  if (
    ![i.baseline, i.target].every(
      (n) => Number.isFinite(n) || (allowUnspecifiedIndicators && n === null),
    )
  )
    invalid("Значення індикатора мають бути скінченними числами");
  if (!allowUnspecifiedIndicators || i.direction !== null)
    choice(i.direction, ["increase", "decrease", "maintain"]);
  if (i.baseline !== null && i.target !== null && (
    (i.direction === "increase" && i.target < i.baseline) ||
    (i.direction === "decrease" && i.target > i.baseline) ||
    (i.direction === "maintain" && i.target !== i.baseline)
  ))
    invalid("Ціль не відповідає напряму індикатора");
  value.indicator = {
    ...i,
    title: text(i.title),
    unit: allowUnspecifiedIndicators && i.unit === null ? null : text(i.unit, 50),
  };
  return value;
}
export function stableIndicatorId(measureId) {
  const hex = createHash("sha256")
    .update("indicator:" + measureId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function insertMeasure(
  db,
  value,
  id = randomUUID(),
  indicatorId = randomUUID(),
) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO measures (
    id,section_id,department_id,executor_id,risk_id,code,title,description,schedule_type,
    planned_date,active,version,effective_from,created_at,updated_at,recurrence
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    value.sectionId,
    value.departmentId,
    value.executorId,
    value.riskId,
    value.code,
    value.title,
    value.description,
    value.scheduleType === "periodic" ? "continuous" : value.scheduleType,
    value.plannedDate,
    1,
    1,
    value.effectiveFrom,
    now,
    now,
    value.recurrence,
  );
  const i = value.indicator;
  await db.prepare("INSERT INTO indicators VALUES (?,?,?,?,?,?,?)").run(
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
export async function saveMeasure(database, user, input, id, { today = kyivDate } = {}) {
  if (!hasPermission(user, "registry.write")) forbidden();
  keys(
    input,
    [...measureFields, "recurrence", ...(id ? ["version", "active"] : [])],
    id ? ["version"] : measureFields,
  );
  if (id) positive(input.version);
  if (Object.hasOwn(input, "active")) flag(input.active);
  return adaptDatabase(database).transaction(async (db) => {
    const dateToday = today();
    const before = id ? await getBaseMeasure(db, user, id) : null;
    if (before && before.version !== input.version)
      throw new ApiError(
        409,
        "version_conflict",
        "Запис змінено. Оновіть картку та повторіть редагування.",
      );
    if (before && await planIsFrozen(db, id)) {
      throw new ApiError(409, "plan_frozen", "План заходу зафіксовано після подання результату");
    }
    const combined = before
      ? { ...before, indicator: { ...before.indicator }, ...input }
      : input;
    if (before && !Object.hasOwn(input, "indicator"))
      delete combined.indicator.id;
    const indicatorFields = ["unit", "baseline", "target", "direction"];
    const preservesMissingValues = before != null && indicatorFields.every((field) =>
      combined.indicator?.[field] !== null || before.indicator[field] === null
    );
    const value = await validateMeasure(
      db,
      combined,
      user,
      before?.programId,
      dateToday,
      { allowUnspecifiedIndicators: preservesMissingValues },
    );
    if (before && (
      value.departmentId !== before.departmentId ||
      value.executorId !== before.executorId ||
      value.scheduleType !== before.scheduleType ||
      value.recurrence !== (before.recurrence ?? null)
    ) && await db.prepare(
      `SELECT 1 FROM results WHERE measure_id=?
       UNION ALL SELECT 1 FROM period_assignments WHERE measure_id=? LIMIT 1`,
    ).get(id, id)) {
      throw new ApiError(
        409,
        "plan_frozen",
        "Результат або призначення вже існує. Змінюйте виконавця через призначення на період.",
      );
    }
    const persistedId = id ?? await insertMeasure(db, value);
    if (id) {
      const result = await db
        .prepare(
          "UPDATE measures SET section_id=?,department_id=?,executor_id=?,risk_id=?,code=?,title=?,description=?,schedule_type=?,planned_date=?,recurrence=?,active=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        )
        .run(
          value.sectionId,
          value.departmentId,
          value.executorId,
          value.riskId,
          value.code,
          value.title,
          value.description,
          value.scheduleType === "periodic" ? "continuous" : value.scheduleType,
          value.plannedDate,
          value.recurrence,
          Number(value.active),
          new Date().toISOString(),
          id,
          input.version,
        );
      if (!result.changes)
        throw new ApiError(409, "version_conflict", "Запис змінено");
      const i = value.indicator;
      await db.prepare(
        "UPDATE indicators SET title=?,unit=?,baseline=?,target=?,direction=? WHERE measure_id=?",
      ).run(i.title, i.unit, i.baseline, i.target, i.direction, id);
    }
    const after = await getBaseMeasure(db, user, persistedId);
    await audit(
      db,
      user.id,
      before ? "update" : "create",
      "measure",
      persistedId,
      before,
      after,
    );
    return getMeasure(db, user, persistedId, { today: dateToday });
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
export async function importRegistry(
  database,
  actor,
  payload,
  { seed = false, inTransaction = false, allowUnspecifiedIndicators = false } = {},
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
  const db = adaptDatabase(database);
  const perform = async (db) => {
    if (!seed) {
      for (const id of ids)
        for (const table of [
          ...importGroups.filter((g) => g !== "scopes"),
          "indicators",
        ]) {
          if (await db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id))
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
    const record = async (group, insert) => {
      await insert();
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
      await record("programs", () =>
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
      await record("users", () =>
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
        await record(group, () =>
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
      await db.prepare("INSERT INTO user_scopes VALUES (?,?,?)").run(...args);
      created.scopes++;
    }
    for (const r of payload.measures) {
      keys(
        r,
        ["id", "effectiveFrom", "recurrence", ...measureFields],
        ["id", "effectiveFrom", ...measureFields],
      );
      await record("measures", async () => {
        const value = await validateMeasure(db, r, null, null, undefined, {
          allowUnspecifiedIndicators,
        });
        await insertMeasure(
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
              ? await getBaseMeasure(db, { id: actor, role: "admin" }, uuid(row.id))
              : row;
          await audit(
            db,
            actor,
            "import_create",
            group === "measures" ? "measure" : group,
            row.id || `${row.userId}/${row.programId}/${row.departmentId}`,
            null,
            after,
          );
          if (group === "measures")
            await audit(
              db,
              actor,
              "import_create",
              "indicator",
              after.indicator.id,
              null,
              after.indicator,
            );
        }
      await audit(db, actor, "import", "registry", randomUUID(), null, created);
    }
    return { created };
  };
  return inTransaction ? perform(db) : db.transaction(perform);
}
