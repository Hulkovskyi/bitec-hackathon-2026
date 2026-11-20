import { createHash } from "node:crypto";
import { adaptDatabase } from "./database.js";
import { importRegistry } from "./registry.js";
import { ApiError, choice, date, invalid, positive, text } from "./validation.js";

const sourceRoles = {
  ADMIN: "admin",
  KOORD: "coordinator",
  VYK: "executor",
  KER: "leader",
  ANAL: "analyst",
};
const statusValues = ["vykonano", "chastkovo", "ne_vykonano", "v_roboti", "ne_rozpochato"];
const auditObjectTypes = new Map([
  ["zakhid", "measure"],
  ["vykonannia", "result"],
  ["pidtverdzhennia", "evidence"],
]);
const recurrenceValues = new Map([
  ["Щотижня", "weekly"],
  ["Щомісяця", "monthly"],
  ["Щокварталу", "quarterly"],
  ["Щороку, квітень–травень", "annual_april_may"],
]);
const tableNames = [
  "prohrama", "rozdily", "pidrozdily", "korystuvachi", "ryzyky",
  "vymiriuvannia_indykatoriv", "zakhody", "vykonannia_2026_h1",
  "pidtverdzhennia", "perenesennia_strokiv",
];

function sourceId(program, table, id) {
  const hash = createHash("sha256")
    .update(JSON.stringify(["bitec-task-2", program, table, id])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function index(rows, field, name) {
  const records = new Map();
  for (const row of rows) {
    const key = text(row?.[field], 64);
    if (records.has(key)) invalid(`Повторний ідентифікатор у ${name}: ${key}`);
    records.set(key, row);
  }
  return records;
}

function referenced(index, key, label) {
  if (!index.has(key)) invalid(`Невідомий запис ${label}: ${key}`);
  return index.get(key);
}

const optionalDate = (value) => value === "" ? null : date(value);
const optionalText = (value, limit = 4000) => text(value, limit, true) || null;

function number(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("Очікується скінченне число");
  return value;
}

const optionalNumber = (value) => value === "" ? null : number(value);
const sourceFlag = (value) => choice(value, ["так", "ні"]) === "так";

function sourceTimestamp(value, empty = false) {
  if (value === "" && empty) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    invalid("Некоректний локальний час у джерелі");
  }
  date(value.slice(0, 10));
  return value;
}

function sourceUrl(value) {
  const url = optionalText(value, 2000);
  if (url === null) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid("Некоректне довідкове посилання");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    invalid("Некоректне довідкове посилання");
  }
  return url;
}

function normalizeOfficialDataset(input) {
  const tables = input?.tablytsi;
  if (input?.meta?.syntetychni !== true || input?.meta?.period !== "2026-H1" ||
      !tables || tableNames.some((name) => !Array.isArray(tables[name]))) {
    invalid("Потрібен офіційний синтетичний JSON BITEC, завдання 2, за 2026-H1");
  }
  const sourceAudit = tables.zhurnal_dii;
  if (tables.prohrama.length !== 1 || tables.rozdily.length !== 3 ||
      tableNames.some((name) => tables[name].length > 1000) ||
      (sourceAudit !== undefined && (!Array.isArray(sourceAudit) || sourceAudit.length > 1000))) {
    invalid("Некоректний розмір офіційного набору");
  }
  const sourceAsOf = date(input.meta.data_zrizu);
  if (sourceAsOf < "2026-06-30") invalid("Зріз набору має охоплювати І півріччя 2026");
  const source = tables.prohrama[0];
  const programCode = text(source?.id, 50);
  const idFor = (table, id) => sourceId(programCode, table, id);
  const program = {
    id: idFor("program", programCode), code: programCode, title: text(source.nazva),
    periodStart: date(source.period_pochatok), periodEnd: date(source.period_kinets),
  };
  if (program.periodStart > "2026-01-01" || program.periodEnd < "2026-06-30") {
    invalid("Півріччя джерела поза межами програми");
  }
  const inputDepartments = index(tables.pidrozdily, "id", "pidrozdily");
  const inputUsers = index(tables.korystuvachi, "id", "korystuvachi");
  const inputMeasures = index(tables.zakhody, "id", "zakhody");
  const inputSections = index(tables.rozdily, "kod", "rozdily");
  const inputRisks = index(tables.ryzyky, "id", "ryzyky");
  const departmentId = (key) => idFor("department", referenced(inputDepartments, key, "pidrozdily").id);
  const userId = (key) => idFor("user", referenced(inputUsers, key, "korystuvachi").id);
  const measureId = (key) => idFor("measure", referenced(inputMeasures, key, "zakhody").id);
  const riskId = (key) => idFor("risk", referenced(inputRisks, key, "ryzyky").id);
  const reportPeriod = input.meta.period;

  const passport = [
    program.id, text(source.tsili, 4000), optionalText(source.organ), optionalText(source.zatverdzheno),
    optionalText(source.stan_pohodzhennia_nazk), optionalText(source.prymitka),
    Number(sourceFlag(source.mistyt_informatsiiu_z_obmezhenym_dostupom)),
    departmentId(source.upovnovazhenyi_pidrozdil_id),
  ];
  const sections = tables.rozdily.map((row) => {
    const code = choice(row.nomer, [1, 2, 3]);
    if (row.kod !== `R${code}`) invalid("Код і номер розділу не збігаються");
    return { id: idFor("section", row.kod), programId: program.id, code, title: text(row.nazva_portal) };
  });
  const departments = [...inputDepartments.values()].map((row) => ({
    id: departmentId(row.id), programId: program.id, code: text(row.id, 50), title: text(row.nazva),
  }));
  const users = [...inputUsers.values()].map((row) => ({
    id: userId(row.id), displayName: text(`${row.posada} · ${row.id}`),
    role: choice(sourceRoles[row.rol], Object.values(sourceRoles)), active: true,
  }));
  const scopes = [...inputUsers.values()].flatMap((row) => {
    const role = sourceRoles[row.rol];
    if (role === "admin") return [];
    // A program coordinator and an organization leader have program-wide
    // assignments. A department leader, analyst or executor is scoped to that unit.
    const allowed = role === "coordinator" || (role === "leader" && row.pidrozdil_id === "")
      ? departments.map(({ id }) => id)
      : [departmentId(row.pidrozdil_id)];
    return allowed.map((departmentId) => ({
      userId: userId(row.id), programId: program.id, departmentId,
    }));
  });
  const risks = [...inputRisks.values()].map((row) => ({
    id: riskId(row.id), programId: program.id, code: text(row.id, 50), title: text(row.nazva),
  }));
  const readings = tables.vymiriuvannia_indykatoriv.map((row) => {
    const readingOn = date(row.data);
    return [
      idFor("risk-reading", [row.ryzyk_id, readingOn]), riskId(row.ryzyk_id), readingOn,
      number(row.znachennia), text(row.dzherelo, 1000), null,
    ];
  });
  const endOfPeriodReadings = new Map();
  for (const [, id, readingOn, actual] of readings) {
    if (readingOn > "2026-06-30") continue;
    const previous = endOfPeriodReadings.get(id);
    if (!previous || readingOn > previous.readingOn) {
      endOfPeriodReadings.set(id, { readingOn, actual });
    }
  }
  const riskMetadata = [];
  const riskIndicators = [...inputRisks.values()].map((row) => {
    const id = riskId(row.id);
    const baseline = number(row.indykator_bazove);
    const baselineReading = readings.find((reading) => reading[1] === id && reading[3] === baseline);
    if (!baselineReading) invalid(`Немає базового вимірювання ризику: ${row.id}`);
    const target = number(row.indykator_tsil);
    const direction = choice(row.napriam, ["більше", "менше"]) === "більше" ? "increase" : "decrease";
    const targetOn = date(row.data_tsili);
    if (targetOn < baselineReading[2] || (direction === "increase" ? target < baseline : target > baseline)) {
      invalid(`Некоректна ціль ризику: ${row.id}`);
    }
    const owner = departmentId(row.vlasnyk_pidrozdil_id);
    const unit = text(row.odynytsia, 50);
    const likelihood = choice(row.imovirnist_x, [1, 2, 3, 4]);
    const impact = choice(row.naslidky_y, [1, 2, 3, 4]);
    const reading = endOfPeriodReadings.get(id);
    riskMetadata.push([
      id, program.id, owner, text(row.id, 50), text(row.nazva), baseline, baselineReading[2],
      target, unit, likelihood, impact, reading?.actual ?? null, reading?.readingOn ?? null,
    ]);
    return [
      id, program.id, owner, text(row.indykator_ryzyku), unit, direction, baseline, baselineReading[2],
      target, targetOn, text(row.zmist, 4000), likelihood, impact,
    ];
  });

  const metadata = [];
  const measures = [...inputMeasures.values()].map((row) => {
    const section = referenced(inputSections, row.rozdil_kod, "rozdily");
    const department = referenced(inputDepartments, row.vidpovidalnyi_pidrozdil_id, "pidrozdily");
    const planText = text(row.strok_tekst);
    const scheduleType = { data: "one_time", postiino: "continuous", periodychno: "periodic" }[
      choice(row.strok_typ, ["data", "postiino", "periodychno"])
    ];
    const recurrence = scheduleType === "periodic" ? recurrenceValues.get(planText) : null;
    if (scheduleType === "periodic" && !recurrence) invalid(`Невідома періодичність: ${planText}`);
    const plannedDate = optionalDate(row.strok_data);
    if ((scheduleType === "one_time") !== (plannedDate !== null)) invalid(`Некоректний строк: ${row.id}`);
    const target = optionalNumber(row.indykator_tsil);
    const unit = optionalText(row.indykator_odynytsia, 50);
    const direction = target === null ? null : "increase";
    const title = text(row.zmist);
    const indicatorTitle = text(row.indykator_vykonannia);
    const id = measureId(row.id);
    const code = text(row.id, 50);
    const linkedRiskId = row.ryzyk_id === "" ? null : riskId(row.ryzyk_id);
    const executor = referenced(inputUsers, row.vykonavets_korystuvach_id, "korystuvachi");
    if (executor.rol !== "VYK" || executor.pidrozdil_id !== department.id) {
      invalid(`Виконавець заходу поза підрозділом: ${row.id}`);
    }
    metadata.push([
      id, program.id, positive(row.nomer_u_rozdili), planText, scheduleType, plannedDate,
      title, departmentId(department.id), department.nazva, section.nomer, indicatorTitle, target, unit,
      text(row.potribni_pidtverdzhennia, 4000, true), text(row.resursy, 4000, true),
      linkedRiskId, code, department.id, direction,
    ]);
    return {
      id, sectionId: idFor("section", row.rozdil_kod), departmentId: departmentId(department.id),
      executorId: userId(executor.id), riskId: linkedRiskId,
      code, title, description: "", scheduleType, plannedDate,
      ...(recurrence ? { recurrence } : {}),
      effectiveFrom: program.periodStart,
      indicator: { title: indicatorTitle, unit, baseline: null, target, direction },
    };
  });

  const reportRows = index(tables.vykonannia_2026_h1, "zakhid_id", "vykonannia_2026_h1");
  if (reportRows.size !== measures.length) invalid("Потрібен один запис джерела для кожного заходу");
  const results = [...reportRows.values()].map((row) => {
    const measure = referenced(inputMeasures, row.zakhid_id, "zakhody");
    const approved = Number(sourceFlag(row.pohodzheno_koordynatorom));
    const enteredAt = sourceTimestamp(row.data_vnesennia, true);
    if (row.period !== reportPeriod ||
        (row.vnis_korystuvach_id && row.vnis_korystuvach_id !== measure.vykonavets_korystuvach_id) ||
        (enteredAt && enteredAt.slice(0, 10) > sourceAsOf)) {
      invalid(`Некоректні відомості про виконання заходу ${row.zakhid_id}`);
    }
    return [
      measureId(row.zakhid_id), program.id, reportPeriod, choice(row.status, statusValues),
      approved, optionalDate(row.fakt_data), text(row.opys_rezultatu, 4000, true),
      optionalNumber(row.indykator_fakt), row.vnis_korystuvach_id === "" ? null : userId(row.vnis_korystuvach_id), enteredAt,
    ];
  });

  const evidenceIndex = index(tables.pidtverdzhennia, "id", "pidtverdzhennia");
  const evidence = [...evidenceIndex.values()].map((row) => {
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      invalid(`Некоректна контрольна сума джерела: ${row.id}`);
    }
    return [
      idFor("evidence-claim", row.id), measureId(row.zakhid_id), program.id, row.id, text(row.nazva),
      text(row.typ, 100), date(row.data_dokumenta), sourceUrl(row.posylannia),
      sourceTimestamp(row.zavantazheno), userId(row.zavantazhyv_korystuvach_id), row.sha256,
    ];
  });

  const deadlineChanges = tables.perenesennia_strokiv.map((row) => {
    const decidedOn = date(row.data_rishennia);
    return [
      idFor("deadline-change", [row.zakhid_id, decidedOn]), measureId(row.zakhid_id), program.id,
      decidedOn, date(row.staryi_strok), date(row.novyi_strok),
      text(row.prychyna, 4000), userId(row.pohodyv_korystuvach_id),
    ];
  });

  const auditEvents = sourceAudit === undefined ? null : [...index(sourceAudit, "id", "zhurnal_dii")]
    .map(([sourceId, row]) => {
      const occurredAt = sourceTimestamp(row.chas);
      if (occurredAt.slice(0, 10) > sourceAsOf) invalid(`Подія після дати зрізу: ${sourceId}`);
      const actor = referenced(inputUsers, text(row.korystuvach_id, 64), "korystuvachi");
      const objectType = auditObjectTypes.get(row.obiekt);
      if (!objectType) invalid(`Невідомий вид об’єкта журналу: ${sourceId}`);
      const objectCode = text(row.obiekt_id, 64);
      const measureCode = objectType === "evidence"
        ? referenced(evidenceIndex, objectCode, "pidtverdzhennia").zakhid_id
        : objectCode;
      return [
        program.id, measureId(measureCode), sourceId, occurredAt, text(`${actor.posada} · ${actor.id}`),
        text(row.diia, 200), objectType, objectCode, optionalText(row.pole, 100),
        optionalText(row.stare_znachennia), optionalText(row.nove_znachennia),
      ];
    });

  return {
    sourceAsOf, reportPeriod, programId: program.id, passport, riskIndicators, readings, riskMetadata,
    metadata, results, evidence, deadlineChanges, auditEvents,
    registry: {
      schemaVersion: 1, synthetic: true, programs: [program],
      sections, departments, users, scopes, risks, measures,
    },
  };
}

async function insertRows(db, sql, rows) {
  const statement = db.prepare(sql);
  for (const row of rows) await statement.run(...row);
}

async function saveOfficialAudit(db, { programId, auditEvents }, retainExistingMeasures = false) {
  if (auditEvents === null) return 0;
  let events = auditEvents;
  if (retainExistingMeasures) {
    // An upgrade of a local archive must respect measures already removed from it.
    const rows = await db.prepare("SELECT measure_id FROM official_measure_metadata WHERE program_id=?").all(programId);
    const measureIds = new Set(rows.map(({ measure_id }) => measure_id));
    events = auditEvents.filter(([, measureId]) => measureIds.has(measureId));
  }
  await insertRows(db, `
    INSERT INTO official_audit_events
      (program_id,measure_id,source_id,occurred_at,actor_label,action,object_type,object_code,field,before_value,after_value)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, events);
  await db.prepare("UPDATE official_dataset_batches SET source_audit=1 WHERE program_id=?").run(programId);
  return events.length;
}

export async function importOfficialDataset(database, input, { demoMode = false } = {}) {
  if (!demoMode) throw new Error("Official synthetic import requires DEMO_MODE=true");
  const data = normalizeOfficialDataset(input);
  const { programId, reportPeriod, sourceAsOf } = data;
  const sourceHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const info = {
    programId, reportPeriod, sourceAsOf, measures: data.metadata.length,
    results: data.results.length, evidenceClaims: data.evidence.length,
    deadlineChanges: data.deadlineChanges.length, riskMeasurements: data.readings.length,
  };
  return adaptDatabase(database).transaction(async (db) => {
    const already = await db.prepare(
      "SELECT source_hash,source_audit FROM official_dataset_batches WHERE program_id=?",
    ).get(programId);
    if (already) {
      if (already.source_hash !== sourceHash) {
        throw new ApiError(409, "official_dataset_conflict", "Інший пакет джерела вже імпортовано");
      }
      const auditEvents = already.source_audit
        ? (await db.prepare("SELECT count(*) AS n FROM official_audit_events WHERE program_id=?").get(programId)).n
        : await saveOfficialAudit(db, data, true);
      return { ...info, auditEvents, alreadyImported: true };
    }
    await importRegistry(db, null, data.registry, {
      seed: true, inTransaction: true, allowUnspecifiedIndicators: true,
    });
    await insertRows(db, `
      INSERT INTO program_passports
        (program_id, goals, organization, approval_reference, nazk_approval_status, notes,
         restricted_information, coordinator_department_id)
      VALUES (?,?,?,?,?,?,?,?)`, [data.passport]);
    await insertRows(db, `
      INSERT INTO risk_indicators
        (risk_id, program_id, owner_department_id, title, unit, direction, baseline, baseline_on,
         target, target_on, description, likelihood, impact)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.riskIndicators);
    await insertRows(db, `
      INSERT INTO risk_measurements (id, risk_id, reading_on, value, source, actor_id)
      VALUES (?,?,?,?,?,?)`, data.readings);
    await insertRows(db, `
      INSERT INTO official_dataset_batches
        (program_id, source_period, source_as_of, source_hash, imported_at, source_signals)
      VALUES (?,?,?,?,?,1)`, [[programId, reportPeriod, sourceAsOf, sourceHash, new Date().toISOString()]]);
    await insertRows(db, `
      INSERT INTO official_risk_metadata
        (risk_id, program_id, owner_department_id, code, title, baseline, baseline_on, target,
         unit, likelihood, impact, actual, reading_on)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.riskMetadata);
    await insertRows(db, `
      INSERT INTO official_measure_metadata
        (measure_id, program_id, section_order, plan_text, source_schedule_type, source_planned_date,
         source_title, source_department_id, source_department_title, source_section_code,
         indicator_title, indicator_target, indicator_unit, expected_evidence, resources, source_risk_id,
         source_code, source_department_code, source_indicator_direction)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.metadata);
    await insertRows(db, `
      INSERT INTO official_measure_results
        (measure_id, program_id, source_period, source_status, source_approved, source_actual_date,
         description, measured_value, source_user_id, source_entered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, data.results);
    await insertRows(db, `
      INSERT INTO official_evidence_claims
        (id, measure_id, program_id, source_id, title, kind, document_date, reference_url,
         source_uploaded_at, source_user_id, source_checksum)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, data.evidence);
    await insertRows(db, `
      INSERT INTO official_deadline_changes
        (id, measure_id, program_id, decision_date, old_deadline, new_deadline, reason, source_user_id)
      VALUES (?,?,?,?,?,?,?,?)`, data.deadlineChanges);
    const auditEvents = await saveOfficialAudit(db, data);
    return { ...info, auditEvents, alreadyImported: false };
  });
}

const portalStates = {
  completed: "Виконано",
  partial: "Частково виконано",
  not_completed: "Не виконано",
  not_due: "Строк виконання заходу не настав",
};

export function verifyOfficialReport(input, report) {
  const expected = input?.tablytsi?.zvit_portal_2026_h1;
  if (!Array.isArray(expected)) invalid("У наборі немає еталонного звіту H1");
  const rows = report.sections.flatMap(({ title, rows }) => rows.map((row) => ({
    rozdil_portal: title,
    nomer: row.sectionOrder,
    zakhid_id: row.code,
    opys_zakhodu: row.title,
    naimenuvannia_pidrozdilu: row.departmentTitle,
    zaplanovanyi_strok: row.plannedText,
    faktychnyi_strok_vykonannia: row.actualDate ?? "",
    stan_vykonannia: portalStates[row.executionState],
    opys_rezultatu_abo_prychyn: row.resultDescription,
    pidtverdni_materialy: row.sourceEvidence?.map(({ title }) => title).join("; ") ?? "",
  })));
  const actual = index(rows, "zakhid_id", "звіті застосунку");
  const reference = index(expected, "zakhid_id", "еталонному звіті");
  const differences = [];
  for (const [code, row] of reference) {
    const match = actual.get(code);
    if (!match) {
      differences.push({ code, issue: "missing" });
      continue;
    }
    for (const [field, value] of Object.entries(match)) {
      if (value !== row[field]) differences.push({ code, field, expected: row[field], actual: value });
    }
  }
  for (const code of actual.keys()) {
    if (!reference.has(code)) differences.push({ code, issue: "unexpected" });
  }
  if (rows.length === expected.length) {
    const firstOrderDifference = rows.findIndex((row, i) => row.zakhid_id !== expected[i].zakhid_id);
    if (firstOrderDifference !== -1) {
      differences.push({
        issue: "order", row: firstOrderDifference + 1,
        expected: expected[firstOrderDifference].zakhid_id,
        actual: rows[firstOrderDifference].zakhid_id,
      });
    }
  }
  return { rows: rows.length, referenceRows: expected.length, differences };
}
