import { once } from "node:events";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/src/app.js";
import { migrate } from "../apps/api/src/database.js";
import { importOfficialDataset, verifyOfficialReport } from "../apps/api/src/official-dataset.js";
import { formatReportCsv } from "../shared/half-year-report.mjs";

async function verify(database, input, imported) {
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
      return parity;
    } finally {
      await fetch(base + "/session", { method: "DELETE", headers: { ...headers, Origin: origin } });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const [inputPath, databasePath, verification, extra] = process.argv.slice(2);
  if (!inputPath || !databasePath || (verification && verification !== "--verify") || extra) {
    throw new Error("Використання: DEMO_MODE=true node scripts/import-official-dataset.mjs nabir.json demo.sqlite [--verify]");
  }
  if (process.env.DEMO_MODE !== "true") throw new Error("Потрібне DEMO_MODE=true");
  if ((await stat(inputPath)).size > 5 * 1024 * 1024) throw new Error("JSON завеликий");
  const input = JSON.parse((await readFile(inputPath, "utf8")).replace(/^\uFEFF/, ""));
  const localPath = resolve(databasePath);
  if (resolve(inputPath) === localPath) throw new Error("Вкажіть окремий файл SQLite");
  await mkdir(dirname(localPath), { recursive: true });
  const database = new DatabaseSync(localPath);
  try {
    migrate(database);
    const imported = await importOfficialDataset(database, input, { demoMode: true });
    console.log(JSON.stringify(imported, null, 2));
    if (verification) {
      const parity = await verify(database, input, imported);
      console.log(JSON.stringify(parity, null, 2));
      if (parity.differences.length) process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
