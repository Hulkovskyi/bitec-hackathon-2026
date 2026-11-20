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
const applicant = {
  username: "apply.test", password: "synthetic-applicant-passphrase",
  fullName: "Олена Тестова", department: "Перший відділ", position: "Фахівець",
};
const administrator = { ...applicant, username: "local.admin", fullName: "Тестовий Адміністратор" };

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
  const base = `http://127.0.0.1:${server.address().port}/api`;
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
    return { status: response.status, data: response.status === 204 ? null : await response.json(),
      cookie: setCookie?.split(";")[0], setCookie };
  }
  const login = ({ username, password }, cookie) => request("/auth/login", { method: "POST", cookie, body: { username, password } });
  return { db, request, login, admin };
}

test("registration and login gate application decisions and apply role updates to existing sessions", async (t) => {
  const { db, request, login, admin } = await setup(t);
  assert.deepEqual((await request("/auth/options")).data, { demoEnabled: false, registrationEnabled: true });
  assert.equal((await request("/demo/users")).status, 404);
  assert.equal((await request("/auth/register", { method: "POST", body: applicant, from: "https://foreign.example" })).status, 403);
  assert.equal((await request("/auth/register", { method: "POST", body: { ...applicant, role: "admin" } })).status, 400);
  assert.deepEqual((await request("/auth/register", { method: "POST", body: applicant })).data, { status: "draft" });
  assert.equal((await request("/auth/register", { method: "POST", body: { ...applicant, username: "APPLY.TEST" } })).status, 409);
  assert.equal((await login({ ...applicant, password: "wrong" })).status, 401);
  const stored = db.prepare("SELECT password_hash FROM credential_accounts WHERE username=?").get(applicant.username);
  assert.match(stored.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);

  const signedIn = await login({ ...applicant, username: "APPLY.TEST" });
  const cookie = signedIn.cookie;
  assert.equal(signedIn.status, 201);
  assert.match(signedIn.setCookie, /HttpOnly/);
  assert.match(signedIn.setCookie, /Secure/);
  assert.match(signedIn.setCookie, /SameSite=Strict/);
  assert.equal(db.prepare("SELECT id_hash FROM account_sessions WHERE user_id=?").get(signedIn.data.userId).id_hash,
    createHash("sha256").update(cookie.split("=")[1]).digest("hex"));
  const draft = await request("/me", { cookie });
  assert.equal(draft.data.status, "draft");
  assert.deepEqual(draft.data.profile, { username: applicant.username, fullName: applicant.fullName,
    department: applicant.department, position: applicant.position });
  assert.equal((await request("/programs", { cookie })).status, 403);

  const adminSession = await login(administrator);
  assert.equal(adminSession.data.userId, admin.id);
  const adminCookie = adminSession.cookie;
  const management = () => request("/admin/access", { cookie: adminCookie });
  assert.deepEqual((await management()).data.accounts.map(({ id }) => id), [admin.id]);
  assert.equal((await request("/access-application/submit", { method: "POST", cookie, body: {} })).data.status, "pending");
  assert.equal((await request("/access-application/submit", { method: "POST", cookie, body: {} })).status, 200);
  assert.equal((await request("/admin/access", { cookie })).status, 403);
  const pending = (await management()).data.accounts.find(({ status }) => status === "pending");
  assert.equal(pending.fullName, applicant.fullName);

  const role = await request("/admin/roles", { method: "POST", cookie: adminCookie,
    body: { name: "Користувацький аналітик", baseRole: "analyst", permissions: ["reports.read"] } });
  assert.equal(role.status, 201);
  assert.equal((await request("/admin/roles/admin", { method: "PATCH", cookie: adminCookie,
    body: { name: "Без прав", permissions: [] } })).status, 403);
  const departmentIds = [fixture.measures[0].departmentId];
  const decision = `/admin/applications/${pending.id}/decision`;
  assert.equal((await request(decision, { method: "POST", cookie: adminCookie,
    body: { decision: "approve", roleId: role.data.id, departmentIds: ["0b1ba9b8-a7fa-4e5a-8593-a79563d948ef"] } })).status, 400);
  assert.equal((await request(decision, { method: "POST", cookie: adminCookie,
    body: { decision: "approve", roleId: role.data.id, departmentIds } })).status, 200);
  assert.equal((await request(decision, { method: "POST", cookie: adminCookie,
    body: { decision: "reject", reason: "Повторне рішення" } })).status, 409);

  const approved = (await request("/me", { cookie })).data;
  assert.equal(approved.status, "approved");
  assert.equal(approved.roleName, role.data.name);
  assert.deepEqual(approved.permissions, ["reports.read"]);
  const { programId } = approved.scopes[0];
  const report = `/reports/half-year?programId=${programId}&year=2026&half=2`;
  assert.equal((await request(report, { cookie })).status, 200);
  const foreignMeasure = fixture.measures.find(({ departmentId }) => !departmentIds.includes(departmentId));
  assert.equal((await request(`/measures/${foreignMeasure.id}`, { cookie })).status, 404);
  assert.equal((await request(`/admin/roles/${role.data.id}`, { method: "PATCH", cookie: adminCookie,
    body: { name: role.data.name, permissions: ["registry.write"] } })).status, 200);
  assert.equal((await request(report, { cookie })).status, 403);
  const { id: _id, effectiveFrom: _start, ...measure } = fixture.measures[0];
  assert.equal((await request("/measures", { method: "POST", cookie,
    body: { ...measure, code: "CUSTOM-ROLE-TEST" } })).status, 201);

  const assignment = `/admin/accounts/${pending.id}`;
  assert.equal((await request(assignment, { method: "PATCH", cookie: adminCookie,
    body: { roleId: "leader", departmentIds } })).status, 200);
  assert.equal((await request(report, { cookie })).status, 200);
  assert.equal((await request("/measures", { method: "POST", cookie,
    body: { ...measure, code: "ROLE-REVOKED-TEST" } })).status, 403);
  assert.equal((await request(`/admin/accounts/${admin.id}`, { method: "PATCH", cookie: adminCookie,
    body: { roleId: "leader", departmentIds } })).status, 403);
  assert.equal((await request(assignment, { method: "PATCH", cookie: adminCookie,
    body: { roleId: "leader", departmentIds: [] } })).status, 200);
  assert.deepEqual((await request("/programs", { cookie })).data.items, []);
  const rotated = await login(applicant, cookie);
  assert.notEqual(rotated.cookie, cookie);
  assert.equal((await request("/me", { cookie })).status, 401);
  assert.equal((await request("/session", { method: "DELETE", cookie: rotated.cookie })).status, 204);
  assert.equal((await request("/me", { cookie: rotated.cookie })).status, 401);
});

test("synthetic demo sessions reject credential accounts and registration is blocked", async (t) => {
  const { db, request, admin } = await setup(t, { demoMode: true, registrationEnabled: true });
  await assert.rejects(createFirstAdministrator(db, { ...administrator, username: "other.admin" }), { code: "admin_exists" });
  assert.deepEqual((await request("/auth/options")).data, { demoEnabled: true, registrationEnabled: false });
  const registration = await request("/auth/register", { method: "POST", body: applicant });
  assert.equal(registration.status, 403);
  assert.equal(registration.data.error.code, "registration_disabled");
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM credential_accounts").get().total, 1);
  const demoUsers = (await request("/demo/users")).data.items;
  assert.ok(demoUsers.every(({ id }) => id !== admin.id));
  assert.equal((await request("/demo/session", { method: "POST", body: { userId: admin.id } })).status, 401);
  const demoAdminId = demoUsers.find(({ role }) => role === "admin").id;
  const demo = await request("/demo/session", { method: "POST", body: { userId: demoAdminId } });
  assert.equal(demo.status, 201);
  assert.equal((await request("/admin/access", { cookie: demo.cookie })).status, 403);
});

test("working environments can close registration and retain password login", async (t) => {
  const { request, login } = await setup(t, { registrationEnabled: false });
  assert.deepEqual((await request("/auth/options")).data, { demoEnabled: false, registrationEnabled: false });
  assert.equal((await request("/auth/register", { method: "POST", body: applicant })).status, 403);
  assert.equal((await login(administrator)).status, 201);
});

test("rejected applications remain blocked", async (t) => {
  const { db, request, login } = await setup(t);
  assert.equal((await request("/auth/register", { method: "POST", body: applicant })).status, 201);
  const { cookie, data: { userId } } = await login(applicant);
  await request("/access-application/submit", { method: "POST", cookie, body: {} });
  const admin = await login(administrator);
  const reason = "Потрібно уточнити підрозділ";
  assert.equal((await request(`/admin/applications/${userId}/decision`, { method: "POST", cookie: admin.cookie,
    body: { decision: "reject", reason } })).status, 200);
  const rejected = (await request("/me", { cookie })).data;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.decisionReason, reason);
  assert.equal((await request("/programs", { cookie })).status, 403);
  assert.equal((await request("/access-application/submit", { method: "POST", cookie, body: {} })).status, 409);
  assert.deepEqual(db.prepare("SELECT action,actor_id FROM audit_events WHERE entity_id=? ORDER BY occurred_at").all(userId)
    .map(({ action, actor_id }) => [action, actor_id]), [["submit", userId], ["reject", admin.data.userId]]);
});
