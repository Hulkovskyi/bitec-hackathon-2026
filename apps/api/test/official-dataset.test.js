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
  return async (role, query) => {
    const actor = items.find((user) => user.role === role);
    const session = await fetch(base + "/demo/session", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: actor.id }),
    });
    assert.equal(session.status, 201);
    return fetch(base + query, { headers: { Cookie: session.headers.get("set-cookie").split(";")[0] } });
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
