import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { createEvidenceStore } from "../src/evidence.js";
import {
  createSupabaseEvidenceStorage,
  hostedEvidenceLimit,
  OversizedEvidenceObject,
} from "../src/evidence-storage.js";
import { seed } from "../src/seed.js";

const origin = "https://synthetic.example";
const bucket = "private-evidence";
const secret = "sb_secret_synthetic-test-placeholder";
const key = "00000000-0000-4000-8000-000000000001";
const payload = Buffer.from("Синтетичний вміст доказу\n");

function storage(fetch) {
  return createSupabaseEvidenceStorage({ url: origin, secretKey: secret, bucket, fetch });
}

const privateBucket = () => Response.json({ id: bucket, public: false });
const isUnavailable = (error) => error.status === 503 && error.code === "evidence_storage_unavailable";

test("hosted evidence uses immutable private objects with server authentication", async () => {
  const calls = [];
  const files = new Map();
  const adapter = storage(async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.headers.apikey, secret);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    const path = new URL(url).pathname;
    if (path === "/storage/v1/bucket/" + bucket) return privateBucket();
    if (options.method === "POST") {
      assert.equal(path, "/storage/v1/object/" + bucket + "/" + key);
      assert.equal(options.headers["x-upsert"], "false");
      assert.equal(options.headers["Content-Type"], "text/plain");
      if (files.has(key)) return Response.json({ code: "KeyAlreadyExists" }, { status: 409 });
      files.set(key, Buffer.from(options.body));
      return Response.json({ Key: bucket + "/" + key });
    }
    if (options.method === "DELETE") {
      assert.equal(path, "/storage/v1/object/" + bucket);
      assert.deepEqual(JSON.parse(options.body), { prefixes: [key] });
      files.delete(key);
      return Response.json([]);
    }
    assert.equal(path, "/storage/v1/object/authenticated/" + bucket + "/" + key);
    return files.has(key)
      ? new Response(files.get(key))
      : Response.json({ code: "NoSuchKey" }, { status: 404 });
  });
  await adapter.put(key, payload, "text/plain");
  await assert.rejects(adapter.put(key, Buffer.from("replace"), "text/plain"), isUnavailable);
  assert.deepEqual(await adapter.get(key), payload);
  await adapter.delete(key);
  assert.equal(await adapter.get(key), null);
  assert.equal(calls.filter(({ url }) => url.endsWith("/bucket/" + bucket)).length, 1);
});

test("hosted evidence rejects public buckets and treats storage errors separately from missing objects", async () => {
  let bucketIsPublic = true;
  const paths = [];
  const adapter = storage(async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/storage/v1/bucket/" + bucket)
      return Response.json({ id: bucket, public: bucketIsPublic });
    return Response.json({ code: "NoSuchBucket" }, { status: 404 });
  });
  await assert.rejects(adapter.put(key, payload, "text/plain"), isUnavailable);
  assert.deepEqual(paths, ["/storage/v1/bucket/" + bucket]);
  bucketIsPublic = false;
  await assert.rejects(adapter.get(key), isUnavailable);
  assert.equal(paths.length, 3);
});

test("hosted evidence bounds upload and download bytes and validates storage keys before requests", async () => {
  let checkCount = 0;
  const adapter = storage(async (url) => {
    checkCount += 1;
    if (url.endsWith("/bucket/" + bucket)) return privateBucket();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(hostedEvidenceLimit));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }));
  });
  await assert.rejects(adapter.get("../different-object"), /Invalid evidence storage key/);
  await assert.rejects(adapter.put(key, Buffer.alloc(hostedEvidenceLimit + 1), "text/plain"), OversizedEvidenceObject);
  assert.equal(checkCount, 0);
  await assert.rejects(adapter.get(key), OversizedEvidenceObject);
  assert.equal(checkCount, 2);
});

test("verified object download returns exactly the bytes that passed the digest check", async () => {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const row = { id: "synthetic-evidence", storage_key: key, byte_size: payload.length, sha256 };
  let reply = payload;
  const adapter = storage(async (url) => {
    if (url.endsWith("/bucket/" + bucket)) return privateBucket();
    return reply
      ? new Response(reply)
      : Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
  });
  const store = createEvidenceStore({ dialect: "postgres" }, { storage: adapter });
  assert.equal(store.maxBytes, hostedEvidenceLimit);
  assert.deepEqual(await store.download(row), payload);
  assert.equal(await store.verify(row), true);
  reply = Buffer.from(payload);
  reply[0] ^= 1;
  assert.equal((await store.integrity(row)).intact, false);
  await assert.rejects(store.download(row), { status: 409, code: "evidence_integrity_failed" });
  reply = null;
  assert.equal((await store.integrity(row)).missingFile, true);
  await assert.rejects(store.download(row), { status: 404, code: "not_found" });
});

test("evidence deletion queue retries storage failures and handles already removed objects", async (t) => {
  const alreadyRemoved = "00000000-0000-4000-8000-000000000002";
  const later = "00000000-0000-4000-8000-000000000003";
  const files = new Set([key, later]);
  let unavailable = true;
  const adapter = storage(async (url, options) => {
    if (url.endsWith("/bucket/" + bucket)) return privateBucket();
    assert.equal(options.method, "DELETE");
    const { prefixes: [name] } = JSON.parse(options.body);
    if (name === key && unavailable) return Response.json({}, { status: 503 });
    return Response.json(files.delete(name) ? [{ name }] : []);
  });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  const enqueue = db.prepare("INSERT INTO evidence_deletions (storage_key) VALUES (?)");
  for (const name of [key, alreadyRemoved, later]) enqueue.run(name);
  const store = createEvidenceStore(db, { storage: adapter });

  assert.equal(await store.pendingDeletions(), 3);
  assert.equal(await store.drainDeletions(1), 3, "A storage failure leaves the entry pending");
  assert.equal(db.prepare("SELECT attempts FROM evidence_deletions WHERE storage_key=?").get(key).attempts, 1);
  assert.equal(await store.drainDeletions(2), 1, "A failed entry does not prevent untried deletions");
  assert.deepEqual([...files], [key]);
  unavailable = false;
  assert.equal(await store.drainDeletions(), 0);
  assert.equal(files.size, 0);
  assert.equal(await store.drainDeletions(), 0);
});

test("hosted evidence HTTP route keeps access, limit and rollback rules with object storage", async (t) => {
  const files = new Map();
  const adapter = storage(async (url, { method, body }) => {
    if (url.endsWith("/bucket/" + bucket)) return privateBucket();
    if (method === "DELETE") {
      const { prefixes } = JSON.parse(body);
      for (const name of prefixes) files.delete(name);
      return Response.json([]);
    }
    const name = url.split("/").at(-1);
    if (method === "POST") {
      files.set(name, Buffer.from(body));
      return Response.json({ Key: bucket + "/" + name });
    }
    return files.has(name)
      ? new Response(files.get(name))
      : Response.json({ code: "NoSuchKey" }, { status: 404 });
  });
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seed(db, { demoMode: true });
  const browserOrigin = "http://127.0.0.1:3001";
  const app = createApp(db, {
    demoMode: true,
    today: () => "2026-11-18",
    evidenceStore: createEvidenceStore(db, { storage: adapter }),
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const syntheticId = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  async function login(n) {
    const response = await fetch(base + "/api/demo/session", {
      method: "POST",
      headers: { Origin: browserOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: syntheticId(n) }),
    });
    assert.equal(response.status, 201);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const executor = await login(201);
  const anotherExecutor = await login(202);
  const creation = await fetch(base + "/api/measures/" + syntheticId(501) + "/results", {
    method: "POST",
    headers: { Origin: browserOrigin, Cookie: executor, "Content-Type": "application/json" },
    body: JSON.stringify({ periodKey: "once" }),
  });
  assert.equal(creation.status, 201);
  const { id, version } = await creation.json();
  const resultPath = "/api/results/" + id;
  function upload(bytes, resultVersion) {
    const body = new FormData();
    body.append("file", new Blob([bytes], { type: "text/plain" }), "synthetic.txt");
    body.append("version", String(resultVersion));
    return fetch(base + resultPath + "/evidence", {
      method: "POST",
      headers: { Origin: browserOrigin, Cookie: executor },
      body,
    });
  }

  assert.equal((await upload(Buffer.alloc(hostedEvidenceLimit + 1, 32), version)).status, 413);
  assert.equal(files.size, 0);
  const stored = await upload(payload, version);
  assert.equal(stored.status, 201);
  const { evidence, resultVersion } = await stored.json();
  assert.equal(files.size, 1);
  const download = base + "/api/evidence/" + evidence.id + "/download";
  const allowed = await fetch(download, { headers: { Cookie: executor } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), payload);
  assert.equal((await fetch(download, { headers: { Cookie: anotherExecutor } })).status, 404);

  db.exec(`CREATE TEMP TRIGGER reject_cloud_evidence_audit BEFORE INSERT ON audit_events
    WHEN NEW.entity_type='evidence'
    BEGIN SELECT RAISE(ABORT, 'synthetic cloud audit failure'); END;`);
  assert.equal((await upload(payload, resultVersion)).status, 500);
  assert.equal(db.prepare("SELECT count(*) AS n FROM evidence_versions").get().n, 1);
  assert.equal(db.prepare("SELECT version FROM results WHERE id=?").get(id).version, resultVersion);
  assert.equal(files.size, 1);
});
