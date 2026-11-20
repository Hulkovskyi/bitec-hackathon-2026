import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createFirstAdministrator } from "../apps/api/src/accounts.js";
import { createApp } from "../apps/api/src/app.js";
import { migrate } from "../apps/api/src/database.js";
import { seed } from "../apps/api/src/seed.js";

const host = "127.0.0.1";
const databasePath = process.env.DATABASE_PATH ||
  fileURLToPath(new URL("../data/offline.sqlite", import.meta.url));

async function prepareAdministrator(database) {
  const username = "demo-local";
  const password = randomBytes(18).toString("base64url");
  try {
    await createFirstAdministrator(database, {
      username,
      password,
      fullName: "Адміністратор офлайн-демо",
      department: "Команда BITEC",
      position: "Адміністратор",
    });
    console.log(`Логін: ${username}\nПочатковий пароль: ${password}`);
  } catch (error) {
    if (error.code !== "admin_exists") throw error;
    console.log("Увійдіть зі своїми локальними обліковими даними.");
  }
}

async function main() {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const server = createServer();
  try {
    migrate(database);
    const prepared = database.prepare(
      "SELECT 1 FROM programs UNION ALL SELECT 1 FROM seed_batches LIMIT 1",
    ).get();
    if (!prepared) await seed(database, { demoMode: true });
    await prepareAdministrator(database);

    server.listen(0, host);
    await once(server, "listening");
    const address = `http://${host}:${server.address().port}`;
    server.on("request", createApp(database, {
      evidenceDirectory: databasePath + ".evidence",
      allowedOrigins: [address],
    }));
    console.log(`Відкрийте застосунок: ${address}`);
  } catch (error) {
    server.close();
    database.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(`Не вдалося запустити офлайн: ${error.message}`);
  process.exitCode = 1;
});
