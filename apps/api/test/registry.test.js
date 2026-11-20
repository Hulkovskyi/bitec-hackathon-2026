import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { kyivDate } from "../src/registry.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { seed, fixture } from "../src/seed.js";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "http://127.0.0.1:3001";
async function setup(t, { demoMode = true } = {}) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seed(db, { demoMode: true });
  const server = createApp(db, { demoMode, today: () => "2026-11-17" }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const url = "http://127.0.0.1:" + server.address().port;
  const request = async (
    path,
    { cookie, body, method = "GET", headers = {} } = {},
  ) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      data: response.status === 204 ? null : await response.json(),
    };
  };
  const login = async (n) => {
    const response = await request("/api/demo/session", {
      method: "POST",
      body: { userId: id(n) },
    });
    assert.equal(response.status, 201);
    return response.headers.get("set-cookie").split(";")[0];
  };
  return { db, request, login };
}
const createBody = () => {
  const {
    id: _,
    effectiveFrom: _effectiveFrom,
    ...value
  } = structuredClone(fixture.measures[0]);
  return { ...value, code: "NEW-1" };
};
const counts = (db) =>
  Object.fromEntries(
    [
      "programs",
      "sections",
      "departments",
      "users",
      "user_scopes",
      "risks",
      "measures",
      "indicators",
      "audit_events",
      "seed_batches",
    ].map((table) => [
      table,
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    ]),
  );
const importBody = () => {
  const copy = structuredClone(fixture),
    map = new Map();
  for (const group of [
    "programs",
    "sections",
    "departments",
    "users",
    "risks",
    "measures",
  ])
    for (const row of copy[group]) map.set(row.id, randomUUID());
  const replace = (value) =>
    Array.isArray(value)
      ? value.map(replace)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, replace(v)]),
          )
        : map.get(value) || value;
  const result = replace(copy);
  result.programs.forEach((p) => (p.code += "-" + randomUUID()));
  return result;
};

test("migration and explicit seed are repeatable without overwriting data", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    await assert.rejects(() => seed(db), /DEMO_MODE/);
    await seed(db, { demoMode: true });
    const before = counts(db);
    const indicatorIds = db
      .prepare("SELECT id FROM indicators ORDER BY id")
      .all();
    db.prepare("UPDATE measures SET title=? WHERE id=?").run(
      "Збережена зміна",
      id(501),
    );
    migrate(db);
    await seed(db, { demoMode: true });
    assert.deepEqual(counts(db), before);
    assert.deepEqual(
      db.prepare("SELECT id FROM indicators ORDER BY id").all(),
      indicatorIds,
    );
    assert.equal(
      db.prepare("SELECT title FROM measures WHERE id=?").get(id(501)).title,
      "Збережена зміна",
    );
    assert.deepEqual(
      db.prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all().map(({ version }) => version),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  } finally {
    db.close();
  }
});

test("all five roles: scoped lists, pagination/count, options and foreign IDs", async (t) => {
  const { request, login } = await setup(t);
  for (const [user, expected] of [
    [201, [501]],
    [202, [502]],
    [203, [503]],
    [205, [501, 502]],
    [206, [501, 502, 503]],
    [207, [501, 502]],
    [208, [501, 502, 503]],
  ]) {
    const cookie = await login(user);
    const list = await request(`/api/measures?programId=${id(1)}`, { cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.data.items.map((m) => m.id),
      expected.map(id),
    );
    assert.equal(list.data.total, expected.length);
    const page = await request(
      `/api/measures?programId=${id(1)}&pageSize=1&page=2`,
      { cookie },
    );
    assert.equal(page.data.total, expected.length);
    assert.equal(page.data.items.length, Math.min(1, expected.length - 1));
    const other = await request("/api/measures/" + id(504), { cookie });
    assert.equal(other.status, user === 208 ? 200 : 404);
    const programs = await request("/api/programs", { cookie });
    assert.equal(programs.data.items.length, user === 208 ? 2 : 1);
    const options = await request(`/api/programs/${id(1)}/registry-options`, {
      cookie,
    });
    assert.equal(
      options.data.departments.length,
      [206, 208].includes(user) ? 2 : 1,
    );
    assert.equal(
      options.data.executors.length,
      [205, 208].includes(user) ? (user === 208 ? 3 : 2) : 0,
    );
    if (![205, 208].includes(user)) {
      const write = await request("/api/measures", {
        cookie,
        method: "POST",
        body: createBody(),
      });
      assert.equal(write.status, 403);
    }
    const audit = await request("/api/measures/" + id(501) + "/audit", {
      cookie,
    });
    assert.equal(
      audit.status,
      [206, 207].includes(user) ? 403 : [202, 203].includes(user) ? 404 : 200,
    );
  }
  const cookie = await login(201);
  for (const path of [
    "/api/measures/" + id(502),
    "/api/measures/" + id(502) + "/audit",
    "/api/programs/" + id(2) + "/registry-options",
  ])
    assert.equal((await request(path, { cookie })).status, 404);
  const filtered = await request(
    `/api/measures?programId=${id(1)}&executorId=${id(202)}`,
    { cookie },
  );
  assert.equal(filtered.data.total, 0);
  assert.equal(
    (await request(`/api/measures?programId=${id(1)}&role=admin`, { cookie }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("/api/measures/" + id(502), {
        cookie,
        headers: { "X-Role": "admin", "X-User-Id": id(208) },
      })
    ).status,
    404,
  );
});

test("sessions: no implicit login, hashed tokens, expiry, deactivation, logout and Origin", async (t) => {
  const { db, request, login } = await setup(t);
  assert.equal((await request("/api/me")).status, 401);
  assert.equal(
    (
      await request("/api/demo/session", {
        method: "POST",
        body: { userId: id(209) },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/demo/session", {
        method: "POST",
        body: { userId: id(201) },
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/demo/session", {
        method: "POST",
        body: { userId: id(201), role: "admin" },
      })
    ).status,
    400,
  );
  let cookie = await login(201);
  const token = cookie.split("=")[1];
  assert.equal(
    db.prepare("SELECT id_hash FROM sessions").get().id_hash,
    createHash("sha256").update(token).digest("hex"),
  );
  db.prepare("UPDATE users SET active=0 WHERE id=?").run(id(201));
  assert.equal((await request("/api/me", { cookie })).status, 401);
  db.prepare("UPDATE users SET active=1 WHERE id=?").run(id(201));
  db.exec("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await request("/api/me", { cookie })).status, 401);
  cookie = await login(201);
  assert.equal(
    (await request("/api/session", { method: "DELETE", cookie })).status,
    204,
  );
  assert.equal((await request("/api/me", { cookie })).status, 401);
  const disabled = await setup(t, { demoMode: false });
  assert.equal((await disabled.request("/api/demo/users")).status, 404);
  assert.equal(
    (
      await disabled.request("/api/demo/session", {
        method: "POST",
        body: { userId: id(201) },
      })
    ).status,
    404,
  );
  assert.equal((await disabled.request("/api/me")).status, 401);
});

test("create and patch: assignment, optimistic version, validation, immutable actor and atomic audit", async (t) => {
  const { db, request, login } = await setup(t);
  const cookie = await login(205);
  const created = await request("/api/measures", {
    method: "POST",
    cookie,
    body: createBody(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(
    created.headers.get("location"),
    "/api/measures/" + created.data.id,
  );
  const path = "/api/measures/" + created.data.id;
  const owner = await login(201),
    other = await login(202);
  assert.equal((await request(path, { cookie: owner })).status, 200);
  assert.equal((await request(path, { cookie: other })).status, 404);
  const updated = await request(path, {
    method: "PATCH",
    cookie,
    body: {
      version: 1,
      title: "Оновлено",
      active: false,
      indicator: {
        title: "Нова ціль",
        unit: "%",
        baseline: 10,
        target: 20,
        direction: "increase",
      },
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.version, 2);
  assert.equal(updated.data.active, false);
  const beforeConflict = counts(db);
  assert.equal(
    (
      await request(path, {
        method: "PATCH",
        cookie,
        body: { version: 1, title: "Стара версія" },
      })
    ).status,
    409,
  );
  assert.deepEqual(counts(db), beforeConflict);
  const log = await request(path + "/audit", { cookie });
  assert.equal(log.data.total, 2);
  assert.ok(log.data.items.every((e) => e.actorId === id(205)));
  const bad = [
    { plannedDate: "2026-02-30" },
    { plannedDate: "2027-01-01" },
    { riskId: id(401) },
    { executorId: id(204) },
    { executorId: id(209) },
    { departmentId: id(103) },
    { actor: id(208) },
    { active: true },
    {
      indicator: {
        title: "X",
        unit: "%",
        baseline: 10,
        target: 1,
        direction: "increase",
      },
    },
    { sectionId: id(12), riskId: null },
    { sectionId: id(12), riskId: id(402) },
    { title: " " },
    { scheduleType: "continuous", plannedDate: "2026-11-20" },
  ];
  for (const change of bad) {
    const before = counts(db),
      response = await request("/api/measures", {
        method: "POST",
        cookie,
        body: { ...createBody(), code: randomUUID(), ...change },
      });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.deepEqual(counts(db), before);
  }
  assert.equal(
    (
      await request("/api/measures", {
        method: "POST",
        cookie,
        body: { ...createBody(), departmentId: id(102), executorId: id(203) },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(path, {
        method: "PATCH",
        cookie,
        body: { version: 2, sectionId: id(21) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/measures", {
        method: "POST",
        cookie,
        body: createBody(),
      })
    ).status,
    409,
  );
  const before = counts(db),
    snapshot = (await request(path, { cookie })).data;
  db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  assert.equal(
    (
      await request("/api/measures", {
        method: "POST",
        cookie,
        body: { ...createBody(), code: "ROLLBACK" },
      })
    ).status,
    500,
  );
  assert.equal(
    (
      await request(path, {
        method: "PATCH",
        cookie,
        body: {
          version: 2,
          title: "Не збережеться",
          indicator: {
            title: "Rollback",
            unit: "%",
            baseline: 0,
            target: 100,
            direction: "increase",
          },
        },
      })
    ).status,
    500,
  );
  assert.deepEqual(counts(db), before);
  assert.deepEqual((await request(path, { cookie })).data, snapshot);
});

test("import is create-only, bounded, validated, admin-only and fully transactional", async (t) => {
  const { db, request, login } = await setup(t);
  const cookie = await login(208),
    payload = importBody();
  const denied = await request("/api/imports/registry", {
    method: "POST",
    cookie: await login(205),
    body: payload,
  });
  assert.equal(denied.status, 403);
  const result = await request("/api/imports/registry", {
    method: "POST",
    cookie,
    body: payload,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.created.measures, 4);
  assert.equal(result.data.created.indicators, 4);
  const before = counts(db);
  assert.equal(
    (
      await request("/api/imports/registry", {
        method: "POST",
        cookie,
        body: payload,
      })
    ).status,
    409,
  );
  assert.deepEqual(counts(db), before);
  for (const corrupt of [
    (p) => (p.measures[3].departmentId = randomUUID()),
    (p) => (p.measures[3].indicator.target = "NaN"),
    (p) => p.sections.pop(),
    (p) => (p.users[0].password = "no"),
    (p) => (p.schemaVersion = 2),
    (p) => (p.measures[0].createdAt = "x"),
    (p) => (p.scopes[0].departmentId = p.departments[2].id),
  ]) {
    const bad = importBody();
    corrupt(bad);
    const response = await request("/api/imports/registry", {
      method: "POST",
      cookie,
      body: bad,
    });
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.deepEqual(counts(db), before);
  }
  const huge = importBody();
  huge.measures[0].description = "x".repeat(1024 * 1024);
  assert.equal(
    (
      await request("/api/imports/registry", {
        method: "POST",
        cookie,
        body: huge,
      })
    ).status,
    413,
  );
  assert.deepEqual(counts(db), before);
  const many = importBody();
  many.users = Array.from({ length: 1001 }, () => ({
    id: randomUUID(),
    displayName: "Демо",
    role: "executor",
    active: true,
  }));
  assert.equal(
    (
      await request("/api/imports/registry", {
        method: "POST",
        cookie,
        body: many,
      })
    ).status,
    413,
  );
  assert.deepEqual(counts(db), before);
  db.exec(
    "CREATE TRIGGER fail_import_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  assert.equal(
    (
      await request("/api/imports/registry", {
        method: "POST",
        cookie,
        body: importBody(),
      })
    ).status,
    500,
  );
  assert.deepEqual(counts(db), before);
});

test("seed manifest refuses collisions, partial failure, missing records and changed versions", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  try {
    db.prepare("INSERT INTO programs VALUES (?,?,?,?,?)").run(
      randomUUID(),
      fixture.programs[0].code,
      "Попередній синтетичний імпорт",
      "2026-01-01",
      "2026-12-31",
    );
    const before = counts(db);
    await assert.rejects(() => seed(db, { demoMode: true }), {
      code: "seed_conflict",
    });
    assert.deepEqual(counts(db), before);
  } finally {
    db.close();
  }
  const clean = new DatabaseSync(":memory:");
  migrate(clean);
  try {
    clean.exec(
      "CREATE TRIGGER fail_last_seed BEFORE INSERT ON seed_batches BEGIN SELECT RAISE(ABORT,'last insert failed'); END;",
    );
    const empty = counts(clean);
    await assert.rejects(() => seed(clean, { demoMode: true }));
    assert.deepEqual(counts(clean), empty);
    clean.exec("DROP TRIGGER fail_last_seed");
    await seed(clean, { demoMode: true });
    const applied = counts(clean),
      changed = structuredClone(fixture);
    changed.users[0].displayName = "Змінений manifest";
    await assert.rejects(() => seed(clean, { demoMode: true, manifest: changed }), {
      code: "seed_version_conflict",
    });
    assert.deepEqual(counts(clean), applied);
    clean.prepare("DELETE FROM indicators WHERE measure_id=?").run(id(501));
    const broken = counts(clean);
    await assert.rejects(() => seed(clean, { demoMode: true }), {
      code: "seed_inconsistent",
    });
    assert.deepEqual(counts(clean), broken);
  } finally {
    clean.close();
  }
});

test("same-program assignment requires exact department scope; codes cannot reveal hidden departments", async (t) => {
  const { db, request, login } = await setup(t);
  const cookie = await login(205);
  // Hidden department can use the same code and section without affecting caller A.
  db.prepare("UPDATE measures SET section_id=?,code=? WHERE id=?").run(
    id(11),
    "SAME-CODE",
    id(503),
  );
  const created = await request("/api/measures", {
    method: "POST",
    cookie,
    body: { ...createBody(), code: "SAME-CODE" },
  });
  assert.equal(created.status, 201);
  assert.equal(
    (
      await request("/api/measures", {
        method: "POST",
        cookie,
        body: { ...createBody(), code: "SAME-CODE" },
      })
    ).status,
    409,
  );
  db.prepare("INSERT INTO user_scopes VALUES (?,?,?)").run(
    id(205),
    id(1),
    id(102),
  );
  const before = counts(db);
  assert.equal(
    (
      await request("/api/measures", {
        method: "POST",
        cookie,
        body: { ...createBody(), departmentId: id(102), executorId: id(201) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/measures/" + id(501), {
        method: "PATCH",
        cookie,
        body: { version: 1, departmentId: id(102) },
      })
    ).status,
    400,
  );
  assert.deepEqual(counts(db), before);
  const options = await request(`/api/programs/${id(1)}/registry-options`, {
    cookie,
  });
  assert.deepEqual(
    options.data.executors.find((e) => e.id === id(201)).departmentIds,
    [id(101)],
  );
  assert.deepEqual(
    options.data.executors.find((e) => e.id === id(203)).departmentIds,
    [id(102)],
  );
  const bad = importBody();
  bad.measures[0].departmentId = bad.departments[1].id;
  assert.equal(
    (
      await request("/api/imports/registry", {
        method: "POST",
        cookie: await login(208),
        body: bad,
      })
    ).status,
    400,
  );
  assert.deepEqual(counts(db), before);
});

test("demo sessions are purged on restart and middleware rejects a restored session row", async (t) => {
  const { db, login } = await setup(t);
  const cookie = await login(208),
    token = cookie.split("=")[1];
  const row = db
    .prepare("SELECT * FROM sessions WHERE id_hash=?")
    .get(createHash("sha256").update(token).digest("hex"));
  const server = createApp(db, { demoMode: false }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  const url = "http://127.0.0.1:" + server.address().port;
  async function denied() {
    assert.equal(
      (await fetch(url + "/api/me", { headers: { Cookie: cookie } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "/api/imports/registry", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(importBody()),
        })
      ).status,
      401,
    );
  }
  await denied();
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(
    row.id_hash,
    row.user_id,
    row.auth_kind,
    row.expires_at,
  );
  await denied();
});

test("effectiveFrom follows Kyiv day, remains immutable and bounds planned dates and imports", async (t) => {
  assert.equal(kyivDate(new Date("2026-11-16T22:30:00Z")), "2026-11-17");
  const { db, request, login } = await setup(t);
  const cookie = await login(205);
  const created = await request("/api/measures", {
    method: "POST",
    cookie,
    body: createBody(),
  });
  assert.equal(created.data.effectiveFrom, "2026-11-17");
  for (const body of [
    { ...createBody(), code: "BACKDATE", plannedDate: "2026-11-16" },
    { ...createBody(), code: "OVERRIDE", effectiveFrom: "2026-01-01" },
  ])
    assert.equal(
      (await request("/api/measures", { method: "POST", cookie, body })).status,
      400,
    );
  assert.equal(
    (
      await request("/api/measures/" + created.data.id, {
        method: "PATCH",
        cookie,
        body: { version: 1, effectiveFrom: "2026-01-01" },
      })
    ).status,
    400,
  );
  const bad = importBody();
  bad.measures[0].effectiveFrom = "2026-12-01";
  const before = counts(db);
  assert.equal(
    (
      await request("/api/imports/registry", {
        method: "POST",
        cookie: await login(208),
        body: bad,
      })
    ).status,
    400,
  );
  assert.deepEqual(counts(db), before);
  db.prepare("UPDATE programs SET period_end=? WHERE id=?").run(
    "2026-11-16",
    id(1),
  );
  assert.equal(
    (
      await request("/api/measures", {
        method: "POST",
        cookie,
        body: {
          ...createBody(),
          scheduleType: "continuous",
          plannedDate: null,
        },
      })
    ).status,
    400,
  );
});
