import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { migrate } from "./database.js";
import { createApp } from "./app.js";

const databasePath =
  process.env.DATABASE_PATH ||
  fileURLToPath(new URL("../../../data/demo.sqlite", import.meta.url));
const host = "127.0.0.1";
const port = 3001;

mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);

migrate(database);

createApp(database, {
  demoMode: process.env.DEMO_MODE === "true",
  evidenceDirectory: databasePath + ".evidence",
}).listen(
  port,
  host,
  () => {
    console.log("Digital Anti-Corruption Monitor: http://" + host + ":" + port);
  },
);
