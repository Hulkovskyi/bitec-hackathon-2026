import { randomUUID } from "node:crypto";
import { accountManagerJoin, insertApprovedAccount, prepareAccountCredentials, validateAccountProfile } from "./accounts.js";
import { databaseConstraintKind } from "./database.js";
import { permissions, roleBases, rolePermissions } from "./permissions.js";
import { audit, forbidden, missing } from "./registry.js";
import { ApiError, choice, invalid, keys, text, uuid } from "./validation.js";

const permissionKeys = new Set(permissions.map(({ key }) => key));
const visibleAccount = `(a.status<>'draft' OR EXISTS (
  SELECT 1 FROM audit_events e WHERE e.entity_type='account' AND e.entity_id=a.user_id AND e.action='revoke_access'
))`;

function accountSelect(db) {
  return `SELECT
  a.user_id AS id,a.username,u.display_name AS fullName,a.department,a.position,
  CASE a.status WHEN 'draft' THEN 'revoked' ELSE a.status END AS status,
  a.role_id AS roleId,a.submitted_at AS submittedAt,a.reviewed_at AS reviewedAt,a.decision_reason AS decisionReason,
  manager.id AS managerId,manager.display_name AS managerName
  FROM credential_accounts a JOIN users u ON u.id=a.user_id
  ${accountManagerJoin(db)}`;
}

function roleView(row) {
  return {
    id: row.id,
    name: row.name,
    baseRole: row.base_role,
    permissions: rolePermissions(row.base_role, row.permissions_json),
    system: Boolean(row.system),
    editable: row.id !== "admin",
  };
}

export async function verifyAdministrator(db, actorId) {
  if (!(await db.prepare(`
    SELECT 1 FROM credential_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=? AND a.status='approved' AND u.role='admin' AND u.active=1
  `).get(actorId))) forbidden();
}

async function accountForAdmin(db, accountId) {
  const account = await db.prepare(`
    ${accountSelect(db)}
    WHERE a.user_id=? AND ${visibleAccount}
  `).get(accountId);
  if (!account) missing();
  const scope = await db.prepare("SELECT department_id FROM user_scopes WHERE user_id=? ORDER BY department_id").all(accountId);
  return { ...account, departmentIds: scope.map(({ department_id }) => department_id) };
}

async function verifyManager(db, managerId, accountId, unavailableMessage = "Оберіть чинного керівника зі списку облікових записів") {
  const manager = await db.prepare(`
    SELECT 1 FROM credential_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=? AND a.status='approved' AND u.active=1
  `).get(managerId);
  if (!manager) invalid(unavailableMessage);
  if (accountId && await db.prepare(`
    WITH RECURSIVE managers(id) AS (
      SELECT CAST(? AS TEXT)
      UNION
      SELECT a.manager_id FROM credential_accounts a JOIN managers m ON a.user_id=m.id
      WHERE a.manager_id IS NOT NULL
    )
    SELECT 1 FROM managers WHERE id=?
  `).get(managerId, accountId)) invalid("Керівник і підлеглі не можуть утворювати цикл");
}

function isPrimaryAdministrator(account) {
  return account.roleId === "admin" && account.username === "admin";
}

async function assignedAccess(db, body) {
  const role = await db.prepare("SELECT * FROM account_roles WHERE id=?").get(text(body.roleId, 64));
  if (!role) invalid("Оберіть чинну роль");
  if (!Array.isArray(body.departmentIds) || body.departmentIds.length > 200) invalid("Оберіть підрозділи зі списку");
  const departmentIds = [...new Set(body.departmentIds.map(uuid))].sort();
  if (role.base_role === "admin" || !departmentIds.length) return { role, departments: [] };
  const departments = await db.prepare(`
    SELECT id,program_id FROM departments WHERE id IN (${departmentIds.map(() => "?").join(",")}) ORDER BY id
  `).all(...departmentIds);
  if (departments.length !== departmentIds.length) invalid("Один із підрозділів більше не доступний");
  return { role, departments };
}

async function addScopes(db, accountId, departments) {
  const insertScope = db.prepare("INSERT INTO user_scopes (user_id,program_id,department_id) VALUES (?,?,?)");
  for (const department of departments) await insertScope.run(accountId, department.program_id, department.id);
}

async function grantAccess(db, accountId, { role, departments }) {
  await db.prepare("UPDATE users SET role=?,active=1 WHERE id=?").run(role.base_role, accountId);
  await db.prepare("DELETE FROM user_scopes WHERE user_id=?").run(accountId);
  await addScopes(db, accountId, departments);
}

function roleFields(body) {
  const name = text(body.name, 100);
  if (!Array.isArray(body.permissions) || body.permissions.length > permissions.length ||
      body.permissions.some((key) => !permissionKeys.has(key))) invalid("Некоректний набір дозволів");
  return [name, name.normalize("NFKC").toLowerCase(), JSON.stringify([...new Set(body.permissions)].sort())];
}

export function mountAccountAdminRoutes(app, db) {
  app.use("/api/admin", (req, _res, next) => {
    if (req.user.authKind !== "password" || req.user.role !== "admin") forbidden();
    next();
  });
  app.get("/api/admin/access", async (req, res) => {
    keys(req.query, []);
    const result = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const accounts = await tx.prepare(`
        ${accountSelect(tx)}
        WHERE ${visibleAccount} ORDER BY a.username
      `).all();
      const scopes = await tx.prepare(`
        SELECT s.user_id,s.department_id FROM user_scopes s JOIN credential_accounts a ON a.user_id=s.user_id
        WHERE a.status='approved' ORDER BY s.user_id,s.department_id
      `).all();
      const byAccount = new Map();
      for (const scope of scopes) {
        const ids = byAccount.get(scope.user_id) ?? [];
        ids.push(scope.department_id);
        byAccount.set(scope.user_id, ids);
      }
      const roles = (await tx.prepare("SELECT * FROM account_roles ORDER BY system DESC,name_key").all()).map(roleView);
      const departments = await tx.prepare(`
        SELECT d.id,d.title,d.code,p.code AS programCode,p.title AS programTitle
        FROM departments d JOIN programs p ON p.id=d.program_id ORDER BY p.code,d.code
      `).all();
      return { accounts: accounts.map((account) => ({ ...account, departmentIds: byAccount.get(account.id) ?? [] })),
        roles, departments, permissions };
    }, { readOnly: true });
    res.json(result);
  });

  app.post("/api/admin/accounts", async (req, res) => {
    keys(req.query, []);
    const fields = ["fullName", "username", "password", "department", "position", "managerId", "roleId", "departmentIds"];
    keys(req.body, fields, fields);
    const managerId = uuid(req.body.managerId);
    const credentials = await prepareAccountCredentials(req.body);
    const created = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      await verifyManager(tx, managerId);
      const { role, departments } = await assignedAccess(tx, req.body);
      const id = await insertApprovedAccount(tx, credentials, {
        roleId: role.id, baseRole: role.base_role, managerId, reviewedBy: req.user.id,
      });
      await addScopes(tx, id, departments);
      const account = await accountForAdmin(tx, id);
      await audit(tx, req.user.id, "create", "account", id, null, account);
      return account;
    });
    res.status(201).json(created);
  });

  app.post("/api/admin/applications/:id/decision", async (req, res) => {
    keys(req.query, []);
    const id = uuid(req.params.id);
    const decision = choice(req.body?.decision, ["approve", "reject"]);
    const fields = decision === "approve" ? ["decision", "roleId", "departmentIds"] : ["decision", "reason"];
    keys(req.body, fields, fields);
    const result = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const account = await accountForAdmin(tx, id);
      if (account.status !== "pending") throw new ApiError(409, "application_closed", "Заявку вже розглянуто");
      const reviewedAt = new Date().toISOString();
      if (decision === "approve") {
        const access = await assignedAccess(tx, req.body);
        await grantAccess(tx, id, access);
        await tx.prepare(`
          UPDATE credential_accounts SET status='approved',role_id=?,reviewed_at=?,reviewed_by=? WHERE user_id=?
        `).run(access.role.id, reviewedAt, req.user.id, id);
      } else {
        const reason = text(req.body.reason, 1000);
        await tx.prepare(`
          UPDATE credential_accounts SET status='rejected',reviewed_at=?,reviewed_by=?,decision_reason=? WHERE user_id=?
        `).run(reviewedAt, req.user.id, reason, id);
      }
      await tx.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
      const updated = await accountForAdmin(tx, id);
      await audit(tx, req.user.id, decision, "access_application", id, { status: account.status }, {
        status: updated.status, roleId: updated.roleId, departmentIds: updated.departmentIds, reason: updated.decisionReason,
      });
      return updated;
    });
    res.json(result);
  });

  app.patch("/api/admin/accounts/:id", async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["roleId", "departmentIds"], ["roleId", "departmentIds"]);
    const id = uuid(req.params.id);
    if (id === req.user.id) forbidden();
    const result = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const account = await accountForAdmin(tx, id);
      if (isPrimaryAdministrator(account)) forbidden();
      if (account.status !== "approved") throw new ApiError(409, "access_not_approved", "Спочатку схваліть заявку");
      const access = await assignedAccess(tx, req.body);
      await grantAccess(tx, id, access);
      await tx.prepare("UPDATE credential_accounts SET role_id=? WHERE user_id=?").run(access.role.id, id);
      const updated = await accountForAdmin(tx, id);
      await audit(tx, req.user.id, "assign_role", "account", id,
        { roleId: account.roleId, departmentIds: account.departmentIds },
        { roleId: updated.roleId, departmentIds: updated.departmentIds });
      return updated;
    });
    res.json(result);
  });

  app.patch("/api/admin/accounts/:id/profile", async (req, res) => {
    keys(req.query, []);
    const fields = ["fullName", "username", "department", "position", "managerId"];
    keys(req.body, fields, fields);
    const id = uuid(req.params.id);
    const profile = validateAccountProfile(req.body);
    const managerId = req.body.managerId === null ? null : uuid(req.body.managerId);
    const result = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const before = await accountForAdmin(tx, id);
      if (isPrimaryAdministrator(before) && profile.username !== before.username) forbidden();
      if (managerId !== null && managerId !== before.managerId) await verifyManager(tx, managerId, id);
      try {
        await tx.prepare("UPDATE credential_accounts SET username=?,department=?,position=?,manager_id=? WHERE user_id=?")
          .run(profile.username, profile.department, profile.position, managerId, id);
      } catch (error) {
        if (databaseConstraintKind(error) === "unique") {
          throw new ApiError(409, "username_taken", "Такий логін уже зареєстровано");
        }
        throw error;
      }
      await tx.prepare("UPDATE users SET display_name=? WHERE id=?").run(profile.fullName, id);
      const after = await accountForAdmin(tx, id);
      await audit(tx, req.user.id, "update_profile", "account", id, before, after);
      return after;
    });
    res.json(result);
  });

  app.delete("/api/admin/accounts/:id", async (req, res) => {
    keys(req.query, []);
    const id = uuid(req.params.id);
    if (id === req.user.id) forbidden();
    await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const before = await accountForAdmin(tx, id);
      if (isPrimaryAdministrator(before)) forbidden();
      if (before.status !== "approved") throw new ApiError(409, "access_not_approved", "Відкликати можна лише схвалений доступ");
      if (await tx.prepare(`
        SELECT 1 FROM credential_accounts WHERE manager_id=? AND status IN ('approved','pending')
      `).get(id)) {
        throw new ApiError(409, "manager_in_use", "Спочатку призначте підлеглим іншого керівника");
      }
      await tx.prepare("UPDATE credential_accounts SET status='draft',role_id=NULL WHERE user_id=?").run(id);
      await tx.prepare("UPDATE users SET active=0 WHERE id=?").run(id);
      await tx.prepare("DELETE FROM user_scopes WHERE user_id=?").run(id);
      await tx.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
      await tx.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      await audit(tx, req.user.id, "revoke_access", "account", id, before,
        { status: "revoked", roleId: null, departmentIds: [] });
    });
    res.status(204).end();
  });

  app.post("/api/admin/accounts/:id/restore", async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["roleId", "departmentIds"], ["roleId", "departmentIds"]);
    const id = uuid(req.params.id);
    const result = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const before = await accountForAdmin(tx, id);
      if (before.status !== "revoked") throw new ApiError(409, "access_not_revoked", "Доступ цього облікового запису не відкликано");
      if (before.managerId !== null) {
        await verifyManager(tx, before.managerId, id, "Спочатку призначте чинного керівника в профілі або залиште поле порожнім");
      }
      const access = await assignedAccess(tx, req.body);
      await grantAccess(tx, id, access);
      await tx.prepare("UPDATE credential_accounts SET status='approved',role_id=? WHERE user_id=?").run(access.role.id, id);
      const after = await accountForAdmin(tx, id);
      await audit(tx, req.user.id, "restore_access", "account", id, before, after);
      return after;
    });
    res.json(result);
  });

  app.post("/api/admin/roles", async (req, res) => {
    keys(req.query, []);
    const fields = ["name", "baseRole", "permissions"];
    keys(req.body, fields, fields);
    const baseRole = choice(req.body.baseRole, roleBases);
    const id = randomUUID();
    const [name, nameKey, rules] = roleFields(req.body);
    const role = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      await tx.prepare(`
        INSERT INTO account_roles (id,name,name_key,base_role,system,permissions_json) VALUES (?,?,?,?,0,?)
      `).run(id, name, nameKey, baseRole, rules);
      const created = roleView(await tx.prepare("SELECT * FROM account_roles WHERE id=?").get(id));
      await audit(tx, req.user.id, "create_role", "account_role", id, null, created);
      return created;
    });
    res.status(201).json(role);
  });

  app.patch("/api/admin/roles/:id", async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["name", "permissions"], ["name", "permissions"]);
    const id = text(req.params.id, 64);
    if (id === "admin") forbidden();
    const [name, nameKey, rules] = roleFields(req.body);
    const role = await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const existing = await tx.prepare("SELECT * FROM account_roles WHERE id=?").get(id);
      if (!existing) missing();
      await tx.prepare("UPDATE account_roles SET name=?,name_key=?,permissions_json=? WHERE id=?")
        .run(name, nameKey, rules, id);
      const updated = roleView(await tx.prepare("SELECT * FROM account_roles WHERE id=?").get(id));
      await audit(tx, req.user.id, "update_role", "account_role", id, roleView(existing), updated);
      return updated;
    });
    res.json(role);
  });

  app.delete("/api/admin/roles/:id", async (req, res) => {
    keys(req.query, []);
    const id = text(req.params.id, 64);
    await db.transaction(async (tx) => {
      await verifyAdministrator(tx, req.user.id);
      const existing = await tx.prepare("SELECT * FROM account_roles WHERE id=?").get(id);
      if (!existing) missing();
      if (existing.system) forbidden();
      if (await tx.prepare("SELECT 1 FROM credential_accounts WHERE role_id=?").get(id)) {
        throw new ApiError(409, "role_in_use", "Спочатку змініть роль в усіх облікових записах, які її використовують");
      }
      await tx.prepare("DELETE FROM account_roles WHERE id=?").run(id);
      await audit(tx, req.user.id, "delete_role", "account_role", id, roleView(existing), null);
    });
    res.status(204).end();
  });
}
