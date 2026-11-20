import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { resetAccounts } from "../src/account-reset.js";
import { createFirstAdministrator, prepareAccountCredentials } from "../src/accounts.js";
import { migrate } from "../src/database.js";
import { createResult } from "../src/result-workflow.js";
import { fixture, seed } from "../src/seed.js";

const passwords = {
  priorAdmin: "synthetic-prior-admin-passphrase",
  priorExecutor: "synthetic-prior-executor-passphrase",
  firstReset: "synthetic-first-reset-passphrase",
  secondReset: "synthetic-second-reset-passphrase",
};
const expiresAt = "2099-01-01T00:00:00.000Z";

async function existingInstallation(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  await seed(db, { demoMode: true });

  const administrator = await createFirstAdministrator(db, {
    username: "previous.admin", password: passwords.priorAdmin, fullName: "Попередній адміністратор",
    department: "Адміністрація", position: "Адміністратор",
  });
  const plan = fixture.measures[0];
  const executorId = plan.executorId;
  const executor = await prepareAccountCredentials({
    username: "previous.executor", password: passwords.priorExecutor, fullName: "Попередній виконавець",
    department: "Перший відділ", position: "Виконавець",
  });
  db.prepare(`
    INSERT INTO credential_accounts
      (user_id, username, password_hash, department, position, role_id, status, created_at, manager_id)
    VALUES (?,?,?,?,?,'executor','approved',?,?)
  `).run(executorId, executor.username, executor.passwordHash, executor.department, executor.position,
    new Date().toISOString(), administrator.id);

  // The retired employee remains the author of the historical result and its audit entry.
  const result = await createResult(db, { id: executorId, role: "executor" }, plan.id, { periodKey: "once" });
  const accountSession = db.prepare("INSERT INTO account_sessions (id_hash,user_id,expires_at) VALUES (?,?,?)");
  accountSession.run("1".repeat(64), administrator.id, expiresAt);
  accountSession.run("2".repeat(64), executorId, expiresAt);
  const demo = fixture.users.find(({ role, id }) => role === "executor" && id !== executorId);
  db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at,auth_kind) VALUES (?,?,?,'demo')")
    .run("3".repeat(64), demo.id, expiresAt);

  return { db, administrator, executorId, result, accountSession };
}

function snapshot(db) {
  const orderBy = {
    users: "id",
    credential_accounts: "user_id",
    account_sessions: "id_hash",
    sessions: "id_hash",
    user_scopes: "user_id, program_id, department_id",
    results: "id",
    audit_events: "id",
  };
  return Object.fromEntries(Object.entries(orderBy).map(([table, columns]) =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${columns}`).all()]));
}

test("account reset retires credentials and sessions while preserving result history and one admin", async (t) => {
  const { db, administrator, executorId, result, accountSession } = await existingInstallation(t);
  const before = snapshot(db);
  const retiredIds = new Set([administrator.id, executorId]);
  assert.ok(before.audit_events.some(({ entity_id, actor_id }) => entity_id === result.id && actor_id === executorId));

  const first = await resetAccounts(db, { password: passwords.firstReset });
  const after = snapshot(db);
  assert.deepEqual(first, { id: first.id, username: "admin", retiredAccounts: 2, retainedIdentity: false });
  assert.ok(!retiredIds.has(first.id));
  assert.deepEqual(after.credential_accounts.map(({ user_id, username, role_id, status, manager_id }) =>
    ({ user_id, username, role_id, status, manager_id })), [
    { user_id: first.id, username: "admin", role_id: "admin", status: "approved", manager_id: null },
  ]);
  assert.ok(after.users.some(({ id, role, active }) => id === first.id && role === "admin" && active === 1));
  assert.deepEqual(
    after.users.filter(({ id }) => id !== first.id).map((user) => ({ ...user })),
    before.users.map((user) => ({ ...user, active: retiredIds.has(user.id) ? 0 : user.active })),
  );
  assert.deepEqual(after.account_sessions, []);
  assert.deepEqual(after.sessions, []);
  assert.deepEqual(after.user_scopes, before.user_scopes.filter(({ user_id }) => !retiredIds.has(user_id)));
  assert.deepEqual(after.results, before.results);
  assert.deepEqual(after.audit_events.filter(({ action }) => action !== "reset_accounts"), before.audit_events);

  accountSession.run("4".repeat(64), first.id, expiresAt);
  const second = await resetAccounts(db, { password: passwords.secondReset });
  const rerun = snapshot(db);
  assert.deepEqual(second, { id: first.id, username: "admin", retiredAccounts: 0, retainedIdentity: true });
  assert.equal(rerun.credential_accounts.length, 1);
  assert.equal(rerun.credential_accounts[0].user_id, first.id);
  assert.notEqual(rerun.credential_accounts[0].password_hash, after.credential_accounts[0].password_hash);
  assert.deepEqual(rerun.users, after.users);
  assert.deepEqual(rerun.account_sessions, []);
  assert.deepEqual(rerun.sessions, []);
  assert.deepEqual(rerun.user_scopes, after.user_scopes);
  assert.deepEqual(rerun.results, before.results);
  assert.deepEqual(rerun.audit_events.filter(({ action }) => action !== "reset_accounts"), before.audit_events);
  const resetEvents = rerun.audit_events.filter(({ action }) => action === "reset_accounts");
  assert.equal(resetEvents.length, 2);
  for (const event of resetEvents) {
    assert.equal(event.actor_id, first.id);
    assert.equal(event.entity_id, first.id);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("failure writing the reset audit rolls back credentials, sessions, scopes, and user changes", async (t) => {
  const { db } = await existingInstallation(t);
  const before = snapshot(db);
  db.exec(`
    CREATE TEMP TRIGGER reject_reset_audit
    BEFORE INSERT ON main.audit_events
    WHEN NEW.action='reset_accounts'
    BEGIN
      SELECT RAISE(ABORT, 'injected failure writing reset audit');
    END;
  `);

  await assert.rejects(resetAccounts(db, { password: passwords.firstReset }), /injected failure writing reset audit/);
  assert.deepEqual(snapshot(db), before);
});
