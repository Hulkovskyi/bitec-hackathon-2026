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
    { ...enrollment, password: "short" },
    { ...enrollment, managerId: null },
    { ...enrollment, managerId: unknownId },
    { ...enrollment, managerId: fixture.users[0].id },
    { ...enrollment, roleId: "unknown" },
    { ...enrollment, departmentIds: [unknownId] },
  ]) {
    assert.equal((await provision(payload, cookie)).status, 400);
  }
  assert.deepEqual(countWrites(), before);

  const credentials = { ...enrollment, password: "T3st!6" };
  assert.equal((await provision(credentials, cookie)).status, 201);
  assert.equal((await login(credentials)).status, 201);
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
  const password = await request("/auth/password", {
    method: "POST", cookie: demo.cookie,
    body: { currentPassword: employee.password, newPassword: "synthetic-new-passphrase" },
  });
  assert.equal(password.status, 403);
  assert.equal(password.data.error.code, "forbidden");
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

test("password change verifies the old secret, revokes only the owner's sessions and preserves access", async (t) => {
  const { db, request, login, provision, enrollment } = await setup(t);
  const adminSession = await login(administrator);
  const created = await provision(enrollment, adminSession.cookie);
  assert.equal(created.status, 201);
  const userId = created.data.id;
  const first = await login(employee);
  const second = await login(employee);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.cookie, second.cookie);

  const storedHash = () => db.prepare("SELECT password_hash FROM credential_accounts WHERE user_id=?")
    .get(userId).password_hash;
  const audit = () => db.prepare("SELECT * FROM audit_events WHERE entity_id=? ORDER BY occurred_at,id").all(userId);
  const beforeEvents = audit();
  const previousHash = storedHash();
  const newPassword = "P4ss!6";
  const change = (cookie, currentPassword, next) => request("/auth/password", {
    method: "POST", cookie, body: { currentPassword, newPassword: next },
  });

  const anonymous = await change(undefined, employee.password, newPassword);
  assert.equal(anonymous.status, 401);
  const wrong = await change(first.cookie, "wrong-current-passphrase", newPassword);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, "invalid_credentials");
  for (const invalid of ["short", employee.password]) {
    const rejected = await change(first.cookie, employee.password, invalid);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error.code, "validation_error");
  }
  assert.equal(storedHash(), previousHash);
  assert.deepEqual(audit(), beforeEvents);
  const beforeProfile = await request("/me", { cookie: first.cookie });
  assert.equal(beforeProfile.status, 200);
  assert.equal((await request("/me", { cookie: second.cookie })).status, 200);

  const updated = await change(first.cookie, employee.password, newPassword);
  assert.equal(updated.status, 204);
  assert.match(updated.setCookie, /^dacm_session=;.*Expires=/i);
  assert.match(updated.setCookie, /HttpOnly/);
  assert.match(updated.setCookie, /Secure/);
  const nextHash = storedHash();
  assert.notEqual(nextHash, previousHash);
  assert.match(nextHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const afterEvents = audit();
  const beforeIds = new Set(beforeEvents.map(({ id }) => id));
  const addedEvents = afterEvents.filter(({ id }) => !beforeIds.has(id));
  assert.equal(addedEvents.length, 1);
  const [event] = addedEvents;
  assert.equal(event.actor_id, userId);
  assert.equal(event.action, "change_password");
  assert.equal(event.entity_type, "account");
  assert.equal(event.before_json, null);
  assert.equal(event.after_json, null);
  const auditText = JSON.stringify(addedEvents);
  for (const secret of [employee.password, newPassword, previousHash, nextHash]) {
    assert.ok(!auditText.includes(secret), "password material must stay outside the audit");
  }

  assert.equal((await request("/me", { cookie: first.cookie })).status, 401);
  assert.equal((await request("/me", { cookie: second.cookie })).status, 401);
  assert.equal((await request("/me", { cookie: adminSession.cookie })).status, 200);
  assert.equal((await login(employee)).status, 401);
  const signedIn = await login({ ...employee, password: newPassword });
  assert.equal(signedIn.status, 201);
  assert.deepEqual((await request("/me", { cookie: signedIn.cookie })).data, beforeProfile.data);
});

test("simultaneous password changes commit at most one new password", async (t) => {
  const { db, request, login, provision, enrollment } = await setup(t);
  const adminSession = await login(administrator);
  const created = await provision(enrollment, adminSession.cookie);
  assert.equal(created.status, 201);
  const first = await login(employee);
  const second = await login(employee);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const auditCount = () => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id=?").get(created.data.id).n;
  const before = auditCount();
  const passwords = ["synthetic-first-new-secret", "synthetic-second-new-secret"];
  const changes = await Promise.all([first.cookie, second.cookie].map((cookie, index) =>
    request("/auth/password", {
      method: "POST", cookie,
      body: { currentPassword: employee.password, newPassword: passwords[index] },
    })));
  const winner = changes.findIndex(({ status }) => status === 204);
  assert.notEqual(winner, -1);
  const rejected = changes[1 - winner];
  // Both requests may read the same hash, or the second may be authenticated
  // only after the first transaction has revoked its session.
  assert.ok([401, 409].includes(rejected.status), JSON.stringify(rejected));
  if (rejected.status === 409) assert.equal(rejected.data.error.code, "password_changed");
  assert.equal(auditCount(), before + 1);
  assert.equal((await login({ ...employee, password: passwords[winner] })).status, 201);
  assert.equal((await login({ ...employee, password: passwords[1 - winner] })).status, 401);
});

test("password administrator previews a scoped role in one read-only session", async (t) => {
  const { db, request, login, admin, provision, enrollment } = await setup(t);
  const adminSession = await login(administrator);
  const parallelSession = await login(administrator);
  const cookie = adminSession.cookie;
  assert.equal(adminSession.status, 201);
  assert.equal(parallelSession.status, 201);

  const created = await provision({ ...enrollment, roleId: "coordinator" }, cookie);
  assert.equal(created.status, 201);
  const userId = created.data.id;
  const targetSession = await login(employee);
  assert.equal(targetSession.status, 201);
  const me = (sessionCookie) => request("/me", { cookie: sessionCookie });
  const adminProfile = (await me(cookie)).data;
  const { profile, ...target } = (await me(targetSession.cookie)).data;
  assert.equal(profile.username, employee.username);
  assert.equal(target.role, "coordinator");
  assert.ok(target.permissions.includes("registry.write"));
  const { programId } = fixture.departments.find(({ id }) => id === departmentIds[0]);
  assert.deepEqual(target.scopes, [{ programId, departmentId: departmentIds[0] }]);
  const credential = () => db.prepare("SELECT * FROM credential_accounts WHERE user_id=?").get(userId);
  const originalCredential = credential();

  const options = await request("/role-preview/options", { cookie });
  assert.equal(options.status, 200);
  assert.deepEqual(options.data.items.find(({ id }) => id === userId), {
    id: userId, displayName: target.displayName, role: target.role, roleName: target.roleName,
  });
  const selectableIds = fixture.users.filter(({ active, role }) => active && role !== "admin").map(({ id }) => id);
  assert.deepEqual(options.data.items.map(({ id }) => id).sort(), [...selectableIds, userId].sort());
  const enter = (sessionCookie, id = userId) => request("/role-preview", {
    method: "PUT", cookie: sessionCookie, body: { userId: id },
  });
  const exit = (sessionCookie) => request("/role-preview", { method: "DELETE", cookie: sessionCookie });
  for (const [sessionCookie, status] of [[undefined, 401], [targetSession.cookie, 403]]) {
    assert.equal((await request("/role-preview/options", { cookie: sessionCookie })).status, status);
    assert.equal((await enter(sessionCookie)).status, status);
    assert.equal((await exit(sessionCookie)).status, status);
  }

  const entered = await enter(cookie);
  assert.equal(entered.status, 204);
  assert.equal(entered.setCookie, null);
  assert.deepEqual((await me(cookie)).data, {
    ...target, authKind: "preview", preview: { displayName: target.displayName, roleName: target.roleName },
  });
  assert.deepEqual((await me(parallelSession.cookie)).data, adminProfile);
  assert.deepEqual((await me(targetSession.cookie)).data, { ...target, profile });
  assert.equal((await request("/admin/access", { cookie: parallelSession.cookie })).status, 200);
  assert.equal((await request("/admin/access", { cookie })).status, 403);

  const inScope = fixture.measures.filter(({ departmentId }) => departmentIds.includes(departmentId));
  const otherDepartment = fixture.departments.find(({ id, programId: candidate }) =>
    candidate === programId && !departmentIds.includes(id));
  const otherMeasure = fixture.measures.find(({ departmentId }) => departmentId === otherDepartment.id);
  const otherProgram = fixture.programs.find(({ id }) => id !== programId);
  const scopedList = await request("/measures?programId=" + programId, { cookie });
  assert.equal(scopedList.status, 200);
  assert.deepEqual(scopedList.data.items.map(({ id }) => id).sort(), inScope.map(({ id }) => id).sort());
  assert.equal((await request("/measures/" + inScope[0].id, { cookie })).status, 200);
  assert.equal((await request("/measures/" + otherMeasure.id, { cookie })).status, 404);
  assert.equal((await request("/measures?programId=" + otherProgram.id, { cookie })).status, 404);

  const { id: _id, effectiveFrom: _start, ...measure } = inScope[0];
  const updateCode = "PREVIEW-WRITE-TEST";
  for (const [path, method, body] of [
    ["/measures", "POST", { ...measure, code: updateCode }],
    ["/admin/accounts/" + userId, "PATCH", { roleId: "admin", departmentIds: [] }],
    ["/auth/password", "POST", { currentPassword: employee.password, newPassword: "synthetic-preview-new-password" }],
  ]) {
    const denied = await request(path, { method, cookie, body });
    assert.equal(denied.status, 403, path);
    assert.equal(denied.data.error.code, "forbidden", path);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM measures WHERE code=?").get(updateCode).n, 0);
  assert.deepEqual(credential(), originalCredential);

  assert.equal((await exit(cookie)).status, 204);
  assert.deepEqual((await me(cookie)).data, adminProfile);
  assert.equal((await request("/admin/access", { cookie })).status, 200);
  assert.equal((await request("/measures/" + otherMeasure.id, { cookie })).status, 200);
  assert.equal((await login(employee)).status, 201);
  const events = db.prepare(`
    SELECT action, actor_id, entity_type, entity_id, before_json, after_json FROM audit_events
    WHERE action IN ('enter_role_preview', 'exit_role_preview') ORDER BY action
  `).all();
  assert.deepEqual(events.map((event) => ({ ...event })), ["enter_role_preview", "exit_role_preview"].map((action) => ({
    action, actor_id: admin.id, entity_type: "account", entity_id: userId, before_json: null, after_json: null,
  })));
});

test("a preview with an unavailable target denies access until the administrator exits", async (t) => {
  const { db, request, login, admin } = await setup(t, { demoMode: true });
  const { cookie } = await login(administrator);
  const executor = fixture.users.find(({ role, active }) => role === "executor" && active);
  const inactive = fixture.users.find(({ active }) => !active);
  const demoAdministrator = fixture.users.find(({ role }) => role === "admin");
  const enter = (userId, sessionCookie = cookie) => request("/role-preview", {
    method: "PUT", cookie: sessionCookie, body: { userId },
  });
  const demo = await request("/demo/session", { method: "POST", body: { userId: demoAdministrator.id } });
  assert.equal(demo.status, 201);
  assert.equal((await request("/role-preview/options", { cookie: demo.cookie })).status, 403);
  assert.equal((await enter(executor.id, demo.cookie)).status, 403);
  assert.equal((await request("/role-preview", { method: "DELETE", cookie: demo.cookie })).status, 403);

  for (const id of [admin.id, inactive.id, unknownId]) {
    assert.equal((await enter(id)).status, 404);
    const current = await request("/me", { cookie });
    assert.equal(current.status, 200);
    assert.equal(current.data.id, admin.id);
    assert.equal(current.data.role, "admin");
  }
  assert.equal((await enter(executor.id)).status, 204);
  assert.equal((await request("/role-preview/options", { cookie })).status, 403);
  const anotherExecutor = fixture.users.find(({ id, role, active }) => id !== executor.id && role === "executor" && active);
  assert.equal((await enter(anotherExecutor.id)).status, 403);
  const active = await request("/me", { cookie });
  assert.equal(active.status, 200);
  assert.equal(active.data.id, executor.id);
  assert.equal(active.data.authKind, "preview");
  assert.equal((await login(administrator, cookie)).status, 403);

  db.prepare("UPDATE users SET active=0 WHERE id=?").run(executor.id);
  const unavailable = await request("/me", { cookie });
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.data.authKind, "preview");
  assert.equal(unavailable.data.preview.unavailable, true);
  assert.deepEqual(unavailable.data.permissions, []);
  assert.deepEqual(unavailable.data.scopes, []);
  const programs = await request("/programs", { cookie });
  assert.equal(programs.status, 409);
  assert.equal(programs.data.error.code, "role_preview_unavailable");
  assert.equal((await request("/role-preview", { method: "DELETE", cookie })).status, 204);
  const restored = await request("/me", { cookie });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.id, admin.id);
  assert.equal(restored.data.role, "admin");
  assert.equal((await request("/admin/access", { cookie })).status, 200);
});
