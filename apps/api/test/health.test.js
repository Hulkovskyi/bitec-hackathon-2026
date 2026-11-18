import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApp } from "../src/app.js";

test("health reports whether the SQLite connection is ready", async (context) => {
  const database = new DatabaseSync(":memory:");
  const server = createApp(database).listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    if (database.isOpen) database.close();
  }));
  await once(server, "listening");

  const url = "http://127.0.0.1:" + server.address().port + "/api/health";
  const healthy = await fetch(url);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { status: "ok", database: "ready" });

  database.close();
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "unavailable", database: "unavailable" });
});
