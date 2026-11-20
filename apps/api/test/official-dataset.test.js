import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { importOfficialDataset, verifyOfficialReport } from "../src/official-dataset.js";

const sectionTitles = [
  "Заходи з реалізації засад загальної відомчої політики, виконання антикорупційної стратегії та державної антикорупційної програми",
  "Заходи з усунення корупційних ризиків",
  "Навчання та заходи з поширення антикорупційної інформації",
];

function fixture() {
  const measure = {
    rozdil_kod: "R1", nomer_u_rozdili: 1, ryzyk_id: "", strok_typ: "data",
    strok_tekst: "до 31.03.2026", strok_data: "2026-03-31",
    indykator_vykonannia: "Частка виконання", indykator_odynytsia: "%",
    indykator_tsil: 100, potribni_pidtverdzhennia: "Навчальний документ", resursy: "Умовно",
  };
  const measures = [
    {
      ...measure, id: "Z-P", zmist: "Тестова щомісячна дія", vidpovidalnyi_pidrozdil_id: "P1",
      vykonavets_korystuvach_id: "U1", strok_typ: "periodychno", strok_tekst: "Щомісяця", strok_data: "",
    },
    {
      ...measure, id: "Z-L", zmist: "Тестова пізня дія", nomer_u_rozdili: 2,
      vidpovidalnyi_pidrozdil_id: "P2", vykonavets_korystuvach_id: "U2",
    },
    {
      ...measure, id: "Z-F", zmist: "Тестова майбутня дія", nomer_u_rozdili: 3,
      vidpovidalnyi_pidrozdil_id: "P1", vykonavets_korystuvach_id: "U1",
      strok_tekst: "до 31.12.2026", strok_data: "2026-12-31",
      indykator_odynytsia: "", indykator_tsil: "",
    },
  ];
  const baseResult = {
    period: "2026-H1", fakt_data: "", indykator_fakt: "", data_vnesennia: "",
    vnis_korystuvach_id: "", pohodzheno_koordynatorom: "ні",
  };
  return {
    meta: { syntetychni: true, period: "2026-H1", data_zrizu: "2026-07-06" },
    tablytsi: {
      prohrama: [{
        id: "TEST-OFFICIAL", nazva: "Тестовий синтетичний імпорт", organ: "Умовна організація",
        period_pochatok: "2026-01-01", period_kinets: "2026-12-31", zatverdzheno: "",
        stan_pohodzhennia_nazk: "", mistyt_informatsiiu_z_obmezhenym_dostupom: "ні",
        upovnovazhenyi_pidrozdil_id: "P1", tsili: "Перевірити імпорт", prymitka: "",
      }],
      rozdily: sectionTitles.map((title, i) => ({ kod: `R${i + 1}`, nomer: i + 1, nazva_portal: title })),
      pidrozdily: [{ id: "P1", nazva: "Перший тестовий" }, { id: "P2", nazva: "Другий тестовий" }],
      korystuvachi: [
        { id: "U1", rol: "VYK", pidrozdil_id: "P1", posada: "Виконавець А" },
        { id: "U2", rol: "VYK", pidrozdil_id: "P2", posada: "Виконавець Б" },
        { id: "UC", rol: "KOORD", pidrozdil_id: "P1", posada: "Координатор" },
        { id: "UL", rol: "KER", pidrozdil_id: "P1", posada: "Керівник підрозділу" },
      ],
      ryzyky: [], vymiriuvannia_indykatoriv: [],
      zakhody: measures,
      vykonannia_2026_h1: [
        {
          ...baseResult, zakhid_id: "Z-P", status: "chastkovo",
          opys_rezultatu: "Виконано 60 %.", indykator_fakt: 60,
          data_vnesennia: "2026-06-30T12:00", vnis_korystuvach_id: "U1", pohodzheno_koordynatorom: "так",
        },
        {
          ...baseResult, zakhid_id: "Z-L", status: "vykonano", fakt_data: "2026-07-03",
          opys_rezultatu: "Закрито із запізненням.", data_vnesennia: "2026-07-03T13:00", vnis_korystuvach_id: "U2",
        },
        { ...baseResult, zakhid_id: "Z-F", status: "v_roboti", opys_rezultatu: "Опис для майбутнього заходу." },
      ],
      pidtverdzhennia: [{
        id: "E1", zakhid_id: "Z-P", typ: "звіт", nazva: "Умовний документ",
        data_dokumenta: "2026-06-30", posylannia: "https://example.org/claim",
        zavantazheno: "2026-07-01T13:00", zavantazhyv_korystuvach_id: "U1", sha256: "a".repeat(64),
      }],
      perenesennia_strokiv: [],
      zvit_portal_2026_h1: measures.map((plan, i) => ({
        rozdil_portal: sectionTitles[0], nomer: i + 1, zakhid_id: plan.id, opys_zakhodu: plan.zmist,
        naimenuvannia_pidrozdilu: i === 1 ? "Другий тестовий" : "Перший тестовий",
        zaplanovanyi_strok: plan.strok_tekst, faktychnyi_strok_vykonannia: ["2026-06-30", "2026-07-03", ""][i],
        stan_vykonannia: ["Частково виконано", "Виконано", "Строк виконання заходу не настав"][i],
        opys_rezultatu_abo_prychyn: ["Виконано 60 %.", "Закрито із запізненням.", ""][i],
        pidtverdni_materialy: i === 0 ? "Умовний документ" : "",
      })),
    },
  };
}

function inMemory(t) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  t.after(() => db.close());
  return db;
}

async function http(t, db, today) {
  const server = createApp(db, { demoMode: true, serveWeb: false, today }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = "http://127.0.0.1:3001";
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const { items } = await (await fetch(base + "/demo/users")).json();
  return async (role, query, { method = "GET", body } = {}) => {
    const actor = items.find((user) => user.role === role);
    const session = await fetch(base + "/demo/session", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: actor.id }),
    });
    assert.equal(session.status, 201);
    return fetch(base + query, {
      method,
      headers: {
        Cookie: session.headers.get("set-cookie").split(";")[0],
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
}

test("organizer import is atomic, repeatable and does not create workflow approvals or files", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  await assert.rejects(importOfficialDataset(db, input), /DEMO_MODE/);
  db.exec(`
    CREATE TEMP TRIGGER reject_source_evidence BEFORE INSERT ON official_evidence_claims
    BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END;
  `);
  await assert.rejects(importOfficialDataset(db, input, { demoMode: true }), /synthetic import failure/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM programs").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM official_dataset_batches").get().n, 0);
  db.exec("DROP TRIGGER reject_source_evidence");

  const first = await importOfficialDataset(db, input, { demoMode: true });
  assert.equal(first.measures, 3);
  assert.equal(first.results, 3);
  assert.equal(first.evidenceClaims, 1);
  assert.equal(first.alreadyImported, false);
  assert.deepEqual(await importOfficialDataset(db, input, { demoMode: true }), { ...first, alreadyImported: true });
  const changed = structuredClone(input);
  changed.tablytsi.vykonannia_2026_h1[0].indykator_fakt = 70;
  await assert.rejects(importOfficialDataset(db, changed, { demoMode: true }), { code: "official_dataset_conflict" });

  assert.equal(db.prepare("SELECT recurrence FROM measures WHERE code='Z-P'").get().recurrence, "monthly");
  assert.equal(db.prepare("SELECT count(*) AS n FROM indicators WHERE baseline IS NULL").get().n, 3);
  for (const table of ["results", "result_reviews", "evidence_versions"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(db.prepare("SELECT source_checksum FROM official_evidence_claims").get().source_checksum, "a".repeat(64));
});

test("H1 reproduces organizer fields and keeps historical report evidence scoped and unverified", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  const { programId } = await importOfficialDataset(db, input, { demoMode: true });
  const request = await http(t, db, () => input.meta.data_zrizu);
  const path = `/reports/half-year?programId=${programId}&year=2026&half=1`;
  const response = await request("coordinator", path);
  assert.equal(response.status, 200);
  const report = await response.json();
  const rows = report.sections.flatMap((section) => section.rows);
  assert.deepEqual(verifyOfficialReport(input, report), { rows: 3, referenceRows: 3, differences: [] });
  assert.equal(rows[0].sourceResult.markedApproved, true);
  assert.deepEqual(rows[0].sourceEvidence, [{ title: "Умовний документ", referenceUrl: "https://example.org/claim" }]);
  assert.equal(rows[0].resultId, null);
  assert.equal(rows[1].sourceResult.markedApproved, false);
  assert.equal(rows[1].actualDate, "2026-07-03");
  assert.equal(rows[2].indicator.target, null);
  assert.equal(rows[2].resultDescription, "");

  const leader = await request("leader", path);
  assert.equal(leader.status, 200);
  assert.deepEqual((await leader.json()).sections.flatMap((section) => section.rows.map((row) => row.code)), ["Z-P", "Z-F"]);
  const executor = await request("executor", path);
  assert.equal(executor.status, 403);
});

test("expected evidence is available on an accessible measure detail", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  input.tablytsi.zakhody[1].potribni_pidtverdzhennia = "Документ іншого підрозділу";
  input.tablytsi.zakhody[2].potribni_pidtverdzhennia = "";
  const { programId } = await importOfficialDataset(db, input, { demoMode: true });
  const request = await http(t, db, () => input.meta.data_zrizu);
  const idFor = db.prepare("SELECT id FROM measures WHERE code=?");
  const detail = await request("leader", `/measures/${idFor.get("Z-P").id}?periodKey=2026-H1`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).expectedEvidence, "Навчальний документ");
  const blank = await request("leader", `/measures/${idFor.get("Z-F").id}`);
  assert.equal(blank.status, 200);
  assert.equal((await blank.json()).expectedEvidence, undefined);
  const outsideScope = await request("leader", `/measures/${idFor.get("Z-L").id}`);
  assert.equal(outsideScope.status, 404);
  assert.equal(JSON.stringify(await outsideScope.json()).includes("Документ іншого підрозділу"), false);
  const listed = await request("leader", `/measures?programId=${programId}`);
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).items.every((item) => !Object.hasOwn(item, "expectedEvidence")));
});

test("an archive signal can open its source result only within archive and registry scope", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  await importOfficialDataset(db, input, { demoMode: true });
  let today = "2026-07-06";
  const request = await http(t, db, () => today);
  const find = db.prepare("SELECT id, department_id FROM measures WHERE code=?");
  const visible = find.get("Z-P");
  const hidden = find.get("Z-L");
  const path = `/measures/${visible.id}`;
  assert.equal((await (await request("leader", path)).json()).officialResult, undefined);
  const archive = await request("leader", path + "?source=official");
  assert.equal(archive.status, 200);
  assert.deepEqual((await archive.json()).officialResult, {
    periodKey: "2026-H1", asOf: today, status: "chastkovo", markedApproved: true, actualDate: null,
    description: "Виконано 60 %.", actual: 60, target: 100, unit: "%", evidence: ["Умовний документ"],
  });
  assert.equal((await request("leader", `/measures/${hidden.id}?source=official`)).status, 404);
  today = "2026-07-05";
  assert.equal((await request("leader", path + "?source=official")).status, 404);
  today = "2026-07-06";
  db.prepare("UPDATE measures SET department_id=? WHERE id=?").run(visible.department_id, hidden.id);
  assert.equal((await request("leader", `/measures/${hidden.id}`)).status, 200);
  assert.equal((await request("leader", `/measures/${hidden.id}?source=official`)).status, 404);
});

test("organizer deadlines honor the available H1 archive and keep other periods and live approvals", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  const { zakhody, vykonannia_2026_h1 } = input.tablytsi;
  zakhody.push({ ...zakhody[1], id: "Z-D", nomer_u_rozdili: 4, zmist: "Умовна прострочена дія" });
  vykonannia_2026_h1.push({
    ...vykonannia_2026_h1[1], zakhid_id: "Z-D", status: "v_roboti",
    fakt_data: "", opys_rezultatu: "Робота триває.",
  });
  const { programId } = await importOfficialDataset(db, input, { demoMode: true });
  let asOf = "2026-07-05";
  const request = await http(t, db, () => asOf);
  const query = "?programId=" + programId;
  const riskPath = "/risk-flags" + query + "&ruleCode=overdue";
  const dashboardPath = "/dashboard" + query + "&metric=overdue";
  const rowKeys = ({ items }) => items.map(({ code, periodKey }) => [code, periodKey]);

  const beforeArchive = await (await request("coordinator", riskPath)).json();
  assert.deepEqual(rowKeys(beforeArchive), [["Z-D", "once"], ["Z-L", "once"], ["Z-P", "2026-H1"]]);

  asOf = input.meta.data_zrizu;
  const risks = await (await request("coordinator", riskPath)).json();
  const dashboard = await (await request("coordinator", dashboardPath)).json();
  assert.deepEqual(rowKeys(risks), [["Z-D", "once"]]);
  assert.deepEqual(rowKeys(dashboard), rowKeys(risks));
  assert.equal(dashboard.counts.overdue, risks.total);
  assert.equal(dashboard.counts.overdueMeasures, risks.total);
  assert.equal(dashboard.counts.completed, 0);
  assert.equal((await (await request("coordinator", "/risk-flags" + query)).json()).total, 1);
  assert.deepEqual(rowKeys(await (await request("leader", riskPath)).json()), []);

  asOf = "2027-01-01";
  const later = await (await request("coordinator", riskPath)).json();
  assert.deepEqual(rowKeys(later), [["Z-D", "once"], ["Z-F", "once"], ["Z-P", "2026-H2"]]);

  asOf = input.meta.data_zrizu;
  db.prepare(`
    INSERT INTO results (id, measure_id, period_key, revision, status, outcome, executor_id, created_at, updated_at)
    SELECT ?, id, 'once', 1, 'approved', 'partial', executor_id, ?, ? FROM measures WHERE code='Z-L'
  `).run(randomUUID(), asOf, asOf);
  const afterApproval = await (await request("coordinator", riskPath)).json();
  assert.deepEqual(rowKeys(afterApproval), [["Z-D", "once"], ["Z-L", "once"]]);
});

test("official signal totals and repeated overdue cases use only accessible archive records", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  const { zakhody, vykonannia_2026_h1 } = input.tablytsi;
  for (const [index, deadline] of ["2026-06-30", "2026-06-29", "2026-07-01"].entries()) {
    const code = `Z-B${index}`;
    zakhody.push({
      ...zakhody[1], id: code, nomer_u_rozdili: index + 4,
      strok_data: deadline, zmist: `Перевірка межі ${index}`,
    });
    vykonannia_2026_h1.push({
      ...vykonannia_2026_h1[1], zakhid_id: code, status: "v_roboti",
      fakt_data: "", opys_rezultatu: "Робота триває.",
    });
  }
  const { programId } = await importOfficialDataset(db, input, { demoMode: true });
  const request = await http(t, db, () => "2027-01-01");
  const path = `/risk-flags?programId=${programId}&source=official`;
  const flags = async (role, query = "") => {
    const response = await request(role, path + query);
    assert.equal(response.status, 200);
    return response.json();
  };
  const overview = await flags("coordinator", "&ruleCode=RF1&pageSize=1");
  assert.equal(overview.asOf, input.meta.data_zrizu);
  assert.equal(overview.total, 2);
  assert.deepEqual(overview.items.map(({ code, deadline }) => [code, deadline]), [["Z-B0", "2026-06-30"]]);
  const leader = await flags("leader", "&ruleCode=RF1&pageSize=1");
  assert.equal(leader.total, 0);
  const aggregate = await flags("coordinator", "&ruleCode=RF6");
  assert.deepEqual(aggregate.items.map(({ subjectType, code, sourceValues }) => [
    subjectType, code, sourceValues.overdueCount, sourceValues.overdueCodes,
  ]), [["department", "P2", 2, "Z-B0, Z-B1"]]);
  assert.equal((await flags("leader", "&ruleCode=RF6")).total, 0);
  assert.deepEqual((await flags("coordinator", "&ruleCode=RF7e")).items.map(({ code }) => code), ["Z-F", "Z-B2"]);
  assert.deepEqual((await flags("coordinator", "&ruleCode=RF5")).items.map(({ sourceValues }) => [
    sourceValues.actual, sourceValues.target, sourceValues.unit, sourceValues.direction,
  ]), [[60, 100, "%", "increase"]]);
  assert.deepEqual((await flags("coordinator", "&ruleCode=RF2")).items.map(({ code }) => code), ["Z-L"]);
});

test("official risk metrics use snapshot values and honor current ownership", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  const { ryzyky, vymiriuvannia_indykatoriv, zakhody, vykonannia_2026_h1 } = input.tablytsi;
  for (const [id, baseline, target, actual] of [["KR-X", 0, 100, 9], ["KR-Y", 10, 9, 9.9], ["KR-Z", 0, 100, 0]]) {
    ryzyky.push({
      id, nazva: `Синтетичний ризик ${id}`, zmist: "Умовний ризик", vlasnyk_pidrozdil_id: "P1",
      indykator_ryzyku: "Частка", odynytsia: "%", indykator_bazove: baseline, indykator_tsil: target,
      napriam: target >= baseline ? "більше" : "менше", data_tsili: "2026-12-31", imovirnist_x: 3, naslidky_y: 2,
    });
    vymiriuvannia_indykatoriv.push(
      { ryzyk_id: id, data: "2026-01-01", znachennia: baseline, dzherelo: "База" },
      { ryzyk_id: id, data: "2026-06-28", znachennia: actual, dzherelo: "Вимірювання" },
    );
  }
  Object.assign(zakhody[0], { rozdil_kod: "R2", ryzyk_id: "KR-X" });
  Object.assign(zakhody[1], { rozdil_kod: "R2", ryzyk_id: "KR-Y" });
  vykonannia_2026_h1[0].status = "vykonano";
  const { programId } = await importOfficialDataset(db, input, { demoMode: true });
  const request = await http(t, db, () => input.meta.data_zrizu);
  const flags = async (rule, role = "coordinator") => {
    const response = await request(role, `/risk-flags?programId=${programId}&source=official&ruleCode=${rule}`);
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  const [weak] = await flags("RF3");
  assert.equal(weak.code, "Z-P");
  assert.equal(weak.sourceValues.progressPercent, 9);
  assert.equal((await flags("RF3")).length, 1);
  assert.equal((await flags("RF3", "leader")).length, 1);
  assert.equal((await flags("RF3", "executor")).length, 0);
  const withoutMeasure = await flags("RF7d");
  assert.deepEqual(withoutMeasure.map(({ code }) => code), ["KR-Z"]);
  db.exec("UPDATE official_dataset_batches SET source_signals=0");
  assert.match((await flags("RF3"))[0].sourceValues.riskDataSource, /Поточні довідники/);
  assert.match((await flags("RF7d"))[0].sourceValues.riskDataSource, /Поточні довідники/);
  db.exec("UPDATE official_dataset_batches SET source_signals=1");

  const { subjectType, subjectId, periodKey, ruleCode } = weak;
  const key = { programId, source: "official", subjectType, subjectId, periodKey, ruleCode };
  const path = "/risk-flag-decisions";
  const available = await request("coordinator", `${path}/assignees?${new URLSearchParams(key)}`);
  assert.equal(available.status, 200);
  const { items, signalVersion } = await available.json();
  const saved = await request("coordinator", path, { method: "PUT", body: {
    ...key, signalVersion, version: 0, action: "Перевірити прогрес індикатора",
    assigneeId: items[0].id, dueDate: input.meta.data_zrizu,
  } });
  assert.equal(saved.status, 200);
  const decision = await saved.json();
  const decisions = async (role) => {
    const response = await request(role, `${path}?programId=${programId}`);
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  assert.deepEqual(await decisions("leader"), [decision]);

  db.exec(`
    UPDATE risk_indicators SET owner_department_id=(SELECT id FROM departments WHERE code='P2'),
      target=baseline, likelihood=1, impact=1;
    UPDATE measures SET risk_id=(SELECT id FROM risks WHERE code='KR-Z'), code='changed-' || code;
    UPDATE risks SET code='changed-' || code;
  `);
  assert.deepEqual(await flags("RF3"), [weak]);
  assert.deepEqual(await flags("RF7d"), withoutMeasure);
  assert.deepEqual(await flags("RF3", "leader"), []);
  assert.deepEqual(await flags("RF7d", "leader"), []);
  assert.deepEqual(await decisions("leader"), []);
  assert.deepEqual(await decisions("coordinator"), [decision]);

  db.exec(`
    UPDATE measures SET risk_id=NULL;
    DELETE FROM risk_measurements;
    DELETE FROM risk_indicators;
    DELETE FROM risks;
  `);
  assert.deepEqual(await flags("RF3"), []);
  assert.deepEqual(await flags("RF7d"), []);
  assert.deepEqual(await decisions("coordinator"), []);
  assert.equal(db.prepare("SELECT count(*) AS total FROM official_risk_metadata").get().total, 0);
});

test("RF4 includes the similarity threshold and excludes results with numbers or links", async (t) => {
  const db = inMemory(t);
  const input = fixture();
  const { zakhody, vykonannia_2026_h1 } = input.tablytsi;
  const title = "Перевірка комісія стандарти експерти реєстри";
  const words = "Перевірка комісія стандарти";
  const cases = [words, words + " 7", words + " https://example.org", "Перевірка комісія"];
  zakhody.push({ ...zakhody[0], id: "Z-Q", nomer_u_rozdili: 4 });
  vykonannia_2026_h1.push({ ...vykonannia_2026_h1[0], zakhid_id: "Z-Q" });
  for (const [index, description] of cases.entries()) {
    zakhody[index].zmist = title;
    Object.assign(vykonannia_2026_h1[index], { status: "vykonano", opys_rezultatu: description });
  }
  const { programId } = await importOfficialDataset(db, input, { demoMode: true });
  const request = await http(t, db, () => input.meta.data_zrizu);
  const response = await request("coordinator", `/risk-flags?programId=${programId}&source=official&ruleCode=RF4`);
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.deepEqual(items.map(({ code, sourceValues }) => [code, sourceValues.similarityPercent]), [["Z-P", 60]]);
});
