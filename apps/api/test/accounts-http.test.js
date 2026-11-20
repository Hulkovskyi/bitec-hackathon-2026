import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createFirstAdministrator } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/database.js";
import { fixture, seed } from "../src/seed.js";

const origin = "http://127.0.0.1:3001";
const employee = {
  username: "employee.test", password: "synthetic-employee-passphrase",
  fullName: "Олена Тестова", department: "Перший відділ", position: "Фахівець",
};
const administrator = { ...employee, username: "local.admin", fullName: "Тестовий Адміністратор" };
const departmentIds = [fixture.measures[0].departmentId];
const unknownId = "0b1ba9b8-a7fa-4e5a-8593-a79563d948ef";

async function setup(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seed(db, { demoMode: true });
  const admin = await createFirstAdministrator(db, administrator);
  const server = createApp(db, { ...options, secureCookies: true, today: () => "2026-11-17" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  async function request(path, { method = "GET", cookie, body, from = origin } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: from,
        ...(cookie === undefined ? {} : { Cookie: cookie }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    return {
      status: response.status, data: response.status === 204 ? null : await response.json(),
      cookie: setCookie?.split(";")[0], setCookie,
    };
  }
  const login = ({ username, password }, cookie) =>
    request("/auth/login", { method: "POST", cookie, body: { username, password } });
  const provision = (body, cookie, from) =>
    request("/admin/accounts", { method: "POST", cookie, body, from });
  const enrollment = { ...employee, managerId: admin.id, roleId: "analyst", departmentIds };
  return { db, request, login, admin, provision, enrollment };
}

test("an administrator provisions a complete account with immediate, scoped password access", async (t) => {
  const { db, request, login, admin, provision, enrollment } = await setup(t);
  assert.deepEqual((await request("/auth/options")).data, { demoEnabled: false, registrationEnabled: false });
  assert.equal((await request("/demo/users")).status, 404);
  assert.equal((await request("/demo/session", { method: "POST", body: { userId: fixture.users[0].id } })).status, 404);
  const registration = await request("/auth/register", { method: "POST", body: employee });
  assert.equal(registration.status, 403);
  assert.equal(registration.data.error.code, "registration_disabled");
  assert.equal((await provision(enrollment)).status, 401);
  assert.equal((await login(employee)).status, 401);

  const adminSession = await login(administrator);
  assert.equal(adminSession.data.userId, admin.id);
  const adminCookie = adminSession.cookie;
  const management = () => request("/admin/access", { cookie: adminCookie });
  const initial = (await management()).data.accounts;
  assert.deepEqual(initial.map(({ id, managerId }) => ({ id, managerId })), [{ id: admin.id, managerId: null }]);
  assert.equal((await provision(enrollment, adminCookie, "https://foreign.example")).status, 403);

  const role = await request("/admin/roles", { method: "POST", cookie: adminCookie,
    body: { name: "Користувацький аналітик", baseRole: "analyst", permissions: ["reports.read"] } });
  assert.equal(role.status, 201);
  assert.equal((await request("/admin/roles/admin", { method: "PATCH", cookie: adminCookie,
    body: { name: "Без прав", permissions: [] } })).status, 403);
  const created = await provision({ ...enrollment, roleId: role.data.id }, adminCookie);
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "approved");
  assert.equal(created.data.roleId, role.data.id);
  assert.deepEqual(created.data.departmentIds, departmentIds);
  assert.equal(created.data.managerId, admin.id);
  assert.equal(created.data.managerName, administrator.fullName);
  assert.ok(!JSON.stringify(created.data).includes(employee.password));
  assert.equal((await login({ ...employee, password: "wrong" })).status, 401);

  const { password_hash: hash } = db.prepare("SELECT password_hash FROM credential_accounts WHERE username=?").get(employee.username);
  assert.match(hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const creationEvent = db.prepare("SELECT actor_id, after_json FROM audit_events WHERE entity_id=?").get(created.data.id);
  assert.equal(creationEvent.actor_id, admin.id);
  assert.ok(!creationEvent.after_json.includes(employee.password) && !creationEvent.after_json.includes(hash));

  const signedIn = await login({ ...employee, username: "EMPLOYEE.TEST" });
  assert.equal(signedIn.status, 201);
  assert.equal(signedIn.data.userId, created.data.id);
  assert.match(signedIn.setCookie, /HttpOnly/);
  assert.match(signedIn.setCookie, /Secure/);
  assert.match(signedIn.setCookie, /SameSite=Strict/);
  const cookie = signedIn.cookie;
  assert.equal(db.prepare("SELECT id_hash FROM account_sessions WHERE user_id=?").get(created.data.id).id_hash,
    createHash("sha256").update(cookie.split("=")[1]).digest("hex"));

  const approved = (await request("/me", { cookie })).data;
  assert.equal(approved.status, "approved");
  assert.equal(approved.roleName, role.data.name);
  assert.deepEqual(approved.permissions, ["reports.read"]);
  assert.deepEqual(approved.profile, {
    username: employee.username, fullName: employee.fullName, department: employee.department,
    position: employee.position, managerId: admin.id, managerName: administrator.fullName,
  });
  assert.equal((await request("/admin/access", { cookie })).status, 403);
  assert.equal((await provision({ ...enrollment, username: "unauthorized.admin", roleId: "admin" }, cookie)).status, 403);

  const subordinate = await provision({
    ...enrollment, fullName: "Іван Тестовий", username: "reporting.test", managerId: created.data.id,
  }, adminCookie);
  assert.equal(subordinate.status, 201);
  const managed = (await management()).data.accounts.find(({ id }) => id === subordinate.data.id);
  assert.equal(managed.managerId, created.data.id);
  assert.equal(managed.managerName, employee.fullName);

  const { programId } = approved.scopes[0];
  const report = "/reports/half-year?programId=" + programId + "&year=2026&half=2";
  assert.equal((await request(report, { cookie })).status, 200);
  const foreignMeasure = fixture.measures.find(({ departmentId }) => !departmentIds.includes(departmentId));
  assert.equal((await request("/measures/" + foreignMeasure.id, { cookie })).status, 404);
  assert.equal((await request("/admin/roles/" + role.data.id, { method: "PATCH", cookie: adminCookie,
    body: { name: role.data.name, permissions: ["registry.write"] } })).status, 200);
  assert.equal((await request(report, { cookie })).status, 403);
  const { id: _id, effectiveFrom: _start, ...measure } = fixture.measures[0];
  assert.equal((await request("/measures", { method: "POST", cookie,
    body: { ...measure, code: "CUSTOM-ROLE-TEST" } })).status, 201);

  const assignment = "/admin/accounts/" + created.data.id;
  assert.equal((await request(assignment, { method: "PATCH", cookie: adminCookie,
    body: { roleId: "leader", departmentIds } })).status, 200);
  assert.equal((await request(report, { cookie })).status, 200);
  assert.equal((await request("/measures", { method: "POST", cookie,
    body: { ...measure, code: "ROLE-REVOKED-TEST" } })).status, 403);
  assert.equal((await request("/admin/accounts/" + admin.id, { method: "PATCH", cookie: adminCookie,
    body: { roleId: "leader", departmentIds } })).status, 403);
  assert.equal((await request(assignment, { method: "PATCH", cookie: adminCookie,
    body: { roleId: "leader", departmentIds: [] } })).status, 200);
  assert.deepEqual((await request("/programs", { cookie })).data.items, []);
  const rotated = await login(employee, cookie);
  assert.notEqual(rotated.cookie, cookie);
  assert.equal((await request("/me", { cookie })).status, 401);
  assert.equal((await request("/session", { method: "DELETE", cookie: rotated.cookie })).status, 204);
  assert.equal((await request("/me", { cookie: rotated.cookie })).status, 401);
});

test("invalid provisioning and duplicate usernames leave no partial account, scope or audit row", async (t) => {
  const { db, login, provision, enrollment } = await setup(t);
  const { cookie } = await login(administrator);
  const countWrites = () => ["users", "credential_accounts", "user_scopes", "audit_events"].map((table) =>
    db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n);
  const before = countWrites();
  for (const field of ["fullName", "username", "password", "department", "position", "managerId"]) {
    const incomplete = { ...enrollment };
    delete incomplete[field];
    assert.equal((await provision(incomplete, cookie)).status, 400, field);
  }
  for (const payload of [
    { ...enrollment, managerId: null },
    { ...enrollment, managerId: unknownId },
    { ...enrollment, managerId: fixture.users[0].id },
    { ...enrollment, roleId: "unknown" },
    { ...enrollment, departmentIds: [unknownId] },
  ]) {
    assert.equal((await provision(payload, cookie)).status, 400);
  }
  assert.deepEqual(countWrites(), before);

  assert.equal((await provision(enrollment, cookie)).status, 201);
  const after = countWrites();
  const duplicate = await provision({ ...enrollment, username: "EMPLOYEE.TEST" }, cookie);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, "username_taken");
  assert.deepEqual(countWrites(), after);
});

test("synthetic demo users cannot provision accounts or impersonate credential accounts", async (t) => {
  const { db, request, admin, provision, enrollment } = await setup(t, { demoMode: true });
  await assert.rejects(createFirstAdministrator(db, { ...administrator, username: "other.admin" }), { code: "admin_exists" });
  assert.deepEqual((await request("/auth/options")).data, { demoEnabled: true, registrationEnabled: false });
  const registration = await request("/auth/register", { method: "POST", body: employee });
  assert.equal(registration.status, 403);
  assert.equal(registration.data.error.code, "registration_disabled");
  const demoUsers = (await request("/demo/users")).data.items;
  assert.ok(demoUsers.every(({ id }) => id !== admin.id));
  assert.equal((await request("/demo/session", { method: "POST", body: { userId: admin.id } })).status, 401);
  const demoAdminId = demoUsers.find(({ role }) => role === "admin").id;
  const demo = await request("/demo/session", { method: "POST", body: { userId: demoAdminId } });
  assert.equal(demo.status, 201);
  assert.equal((await request("/admin/access", { cookie: demo.cookie })).status, 403);
  assert.equal((await provision(enrollment, demo.cookie)).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credential_accounts").get().n, 1);
});

test("legacy applicants require approval and fresh login after self-service closes", async (t) => {
  const { db, request, login, provision, enrollment } = await setup(t);
  const { cookie: adminCookie } = await login(administrator);
  const prior = await provision(enrollment, adminCookie);
  assert.equal(prior.status, 201);
  const { cookie } = await login(employee);
  const updateStatus = db.prepare("UPDATE credential_accounts SET status=?,role_id=NULL WHERE user_id=?");
  for (const status of ["draft", "pending", "rejected"]) {
    updateStatus.run(status, prior.data.id);
    const signedIn = await login(employee);
    assert.equal(signedIn.status, 401, status);
    assert.equal(signedIn.data.error.code, "invalid_credentials");
    assert.equal((await request("/me", { cookie })).status, 401, status);
  }
  assert.equal((await request("/access-application/submit", {
    method: "POST", cookie: adminCookie, body: {},
  })).status, 404);
  updateStatus.run("pending", prior.data.id);
  const decision = await request("/admin/applications/" + prior.data.id + "/decision", {
    method: "POST", cookie: adminCookie, body: { decision: "approve", roleId: "analyst", departmentIds },
  });
  assert.equal(decision.status, 200);
  assert.equal((await request("/me", { cookie })).status, 401);
  assert.equal((await login(employee)).status, 201);
});
