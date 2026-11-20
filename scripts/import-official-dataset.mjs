import { once } from "node:events";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/src/app.js";
import { migrate } from "../apps/api/src/database.js";
import { importOfficialDataset, verifyOfficialReport } from "../apps/api/src/official-dataset.js";
import { formatReportCsv } from "../shared/half-year-report.mjs";

async function verifySignals(base, headers, programId, riskKey) {
  const subjectTypes = { zakhid: "measure", pidrozdil: "department", ryzyk: "risk" };
  const [header, ...lines] = riskKey.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (header !== "kod,obiekt,id,sygnal,poiasnennia") throw new Error("Невідомий формат ключа сигналів");
  const expected = new Set();
  for (const line of lines) {
    // The first three fields are unquoted identifiers. The explanations may contain commas.
    const match = /^(RF(?:[1-6]|7[a-e])),(zakhid|pidrozdil|ryzyk),([A-Za-z0-9-]+),/.exec(line);
    if (!match) throw new Error("Невідомий запис у ключі сигналів");
    const [, ruleCode, subject, code] = match;
    const key = [ruleCode, subjectTypes[subject], code].join(":");
    if (expected.has(key)) throw new Error(`Повторюваний запис у ключі сигналів: ${key}`);
    expected.add(key);
  }
  const query = new URLSearchParams({ programId, source: "official", pageSize: "100" });
  const observed = new Set();
  const duplicate = [];
  let total;
  let page = 1;
  do {
    query.set("page", String(page));
    const response = await fetch(base + "/risk-flags?" + query, { headers });
    if (!response.ok) throw new Error(`Архівні сигнали: HTTP ${response.status}`);
    const data = await response.json();
    total = data.total;
    for (const { ruleCode, subjectType, code } of data.items) {
      const key = [ruleCode, subjectType, code].join(":");
      if (observed.has(key)) duplicate.push(key);
      observed.add(key);
    }
  } while (page++ * 100 < total);
  return {
    expected: expected.size, observed: total, matched: [...observed].filter((key) => expected.has(key)).length,
    missing: [...expected].filter((key) => !observed.has(key)),
    unexpected: [...observed].filter((key) => !expected.has(key)), duplicate,
  };
}

async function verifyAudit(base, headers, input, report) {
  const tables = input.tablytsi;
  if (!tables.zhurnal_dii) return undefined;
  const objectTypes = { zakhid: "measure", vykonannia: "result", pidtverdzhennia: "evidence" };
  const evidenceMeasures = new Map(tables.pidtverdzhennia.map(({ id, zakhid_id }) => [id, zakhid_id]));
  const actors = new Map(tables.korystuvachi.map(({ id, posada }) => [id, `${posada.trim()} · ${id}`]));
  const optional = (value) => value === "" ? null : String(value);
  const pending = new Map(tables.zhurnal_dii.map((event) => [event.id, {
    measureCode: event.obiekt === "pidtverdzhennia" ? evidenceMeasures.get(event.obiekt_id) : event.obiekt_id,
    occurredAt: event.chas, actorLabel: actors.get(event.korystuvach_id), action: event.diia.trim(),
    objectType: objectTypes[event.obiekt], objectCode: event.obiekt_id,
    field: optional(event.pole), before: optional(event.stare_znachennia), after: optional(event.nove_znachennia),
  }]));
  const expected = pending.size;
  const differences = [];
  let matched = 0;
  let observed = 0;
  for (const { measureId, code } of report.sections.flatMap(({ rows }) => rows)) {
    let page = 1;
    let total;
    do {
      const query = new URLSearchParams({ page: String(page), pageSize: "100" });
      const response = await fetch(`${base}/measures/${measureId}/official-audit?${query}`, { headers });
      if (!response.ok) throw new Error(`Архівний журнал ${code} · HTTP ${response.status}`);
      const journal = await response.json();
      if (!journal.available) differences.push({ code, issue: "missing_audit" });
      total = journal.total;
      for (const { sourceId, ...fields } of journal.items) {
        observed++;
        const reference = pending.get(sourceId);
        if (!reference) {
          differences.push({ sourceId, issue: "unexpected_or_duplicate" });
          continue;
        }
        const received = { ...fields, measureCode: code };
        const changed = Object.keys(reference).filter((field) => received[field] !== reference[field]);
        if (changed.length) differences.push({ sourceId, fields: changed });
        else matched++;
        pending.delete(sourceId);
      }
    } while (page++ * 100 < total);
  }
  for (const sourceId of pending.keys()) differences.push({ sourceId, issue: "missing" });
  return { expected, observed, matched, differences };
}

async function verify(database, input, imported, riskKey) {
  const origin = "http://127.0.0.1:3001";
  const server = createApp(database, {
    demoMode: true, today: () => imported.sourceAsOf, serveWeb: false,
  }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const users = await fetch(base + "/demo/users");
    if (!users.ok) throw new Error(`Демокористувачі: HTTP ${users.status}`);
    const sourceCoordinator = input.tablytsi.korystuvachi.find(({ rol }) => rol === "KOORD");
    const { items } = await users.json();
    const actor = sourceCoordinator && items.find((user) => user.role === "coordinator" &&
      user.displayName === `${sourceCoordinator.posada} · ${sourceCoordinator.id}`);
    if (!actor) throw new Error("Не знайдено координатора імпортованої програми");
    const session = await fetch(base + "/demo/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: actor.id }),
    });
    if (!session.ok) throw new Error(`Демовхід: HTTP ${session.status}`);
    const headers = { Cookie: session.headers.get("set-cookie").split(";")[0] };
    try {
      const query = new URLSearchParams({ programId: imported.programId, year: "2026", half: "1" });
      const endpoint = base + "/reports/half-year?" + query;
      const response = await fetch(endpoint, { headers });
      if (!response.ok) throw new Error(`Звіт H1: HTTP ${response.status}`);
      const report = await response.json();
      const csv = await fetch(endpoint + "&format=csv", { headers });
      if (!csv.ok) throw new Error(`CSV H1: HTTP ${csv.status}`);
      const parity = verifyOfficialReport(input, report);
      const csvBytes = Buffer.from(await csv.arrayBuffer());
      if (!csvBytes.equals(Buffer.from(formatReportCsv(report)))) {
        parity.differences.push({ issue: "csv_json_mismatch" });
      }
      const signals = riskKey === undefined ? undefined : await verifySignals(base, headers, imported.programId, riskKey);
      const audit = await verifyAudit(base, headers, input, report);
      return { parity, signals, audit };
    } finally {
      await fetch(base + "/session", { method: "DELETE", headers: { ...headers, Origin: origin } });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const [inputPath, databasePath, verification, riskKeyOption, riskKeyPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !databasePath || (verification && verification !== "--verify") ||
    (riskKeyOption && (riskKeyOption !== "--risk-key" || !riskKeyPath)) || extra.length) {
    throw new Error("Використання: DEMO_MODE=true node scripts/import-official-dataset.mjs nabir.json demo.sqlite [--verify [--risk-key ochikuvani-sygnaly.csv]]");
  }
  if (process.env.DEMO_MODE !== "true") throw new Error("Потрібне DEMO_MODE=true");
  if ((await stat(inputPath)).size > 5 * 1024 * 1024) throw new Error("JSON завеликий");
  const input = JSON.parse((await readFile(inputPath, "utf8")).replace(/^\uFEFF/, ""));
  const riskKey = riskKeyPath === undefined ? undefined : await readFile(riskKeyPath, "utf8");
  const localPath = resolve(databasePath);
  if (resolve(inputPath) === localPath) throw new Error("Вкажіть окремий файл SQLite");
  await mkdir(dirname(localPath), { recursive: true });
  const database = new DatabaseSync(localPath);
  try {
    migrate(database);
    const imported = await importOfficialDataset(database, input, { demoMode: true });
    console.log(JSON.stringify(imported, null, 2));
    if (verification) {
      const { parity, signals, audit } = await verify(database, input, imported, riskKey);
      console.log(JSON.stringify(parity, null, 2));
      if (signals) console.log(JSON.stringify(signals, null, 2));
      if (audit) console.log(JSON.stringify(audit, null, 2));
      if (parity.differences.length || audit?.differences.length || (signals && (signals.matched !== signals.expected || signals.observed !== signals.expected ||
        signals.missing.length || signals.unexpected.length || signals.duplicate.length))) process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
