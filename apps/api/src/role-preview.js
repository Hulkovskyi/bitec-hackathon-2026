import { rolePermissions } from "./permissions.js";
import { audit, forbidden, missing } from "./registry.js";
import { ApiError, keys, uuid } from "./validation.js";

const previewUsers = `
  SELECT u.id, u.display_name AS "displayName", u.role,
         r.id AS "roleId", r.name AS "roleName", r.permissions_json
  FROM users u
  LEFT JOIN credential_accounts a ON a.user_id=u.id
  JOIN account_roles r ON r.id=COALESCE(a.role_id, u.role) AND r.base_role=u.role
  WHERE u.active=1 AND u.role<>'admin' AND (a.user_id IS NULL OR a.status='approved')
`;

export async function previewIdentity(db, targetId) {
  const target = await db.prepare(`${previewUsers} AND u.id=?`).get(targetId);
  if (!target) {
    const displayName = "Перегляд ролі";
    const roleName = "Обліковий запис недоступний";
    return {
      id: targetId, displayName, role: null, roleId: null, roleName, status: "approved", authKind: "preview",
      permissions: [], preview: { displayName, roleName, unavailable: true },
    };
  }
  const { id, displayName, role, roleId, roleName, permissions_json } = target;
  return {
    id, displayName, role, roleId, roleName, status: "approved", authKind: "preview",
    permissions: rolePermissions(role, permissions_json), preview: { displayName, roleName },
  };
}

async function administratorSession(db, session) {
  if (session?.role !== "admin") forbidden();
  const current = await db.prepare(`
    SELECT p.session_id_hash IS NOT NULL AS preview_active
    FROM account_sessions s
    JOIN credential_accounts a ON a.user_id=s.user_id
    JOIN users u ON u.id=a.user_id
    LEFT JOIN account_session_previews p ON p.session_id_hash=s.id_hash
    WHERE s.id_hash=? AND s.user_id=? AND s.expires_at>? AND a.status='approved' AND u.active=1 AND u.role='admin'
  `).get(session.hash, session.id, new Date().toISOString());
  if (!current) forbidden();
  return current;
}

export async function exitRolePreview(db, session) {
  if (!session) return;
  const preview = await db.prepare("SELECT preview_user_id FROM account_session_previews WHERE session_id_hash=?").get(session.hash);
  if (!preview) return;
  await db.prepare("DELETE FROM account_session_previews WHERE session_id_hash=?").run(session.hash);
  await audit(db, session.id, "exit_role_preview", "account", preview.preview_user_id ?? session.id, null, null);
}

export function assertPreviewAdministrator(session) {
  if (session?.previewActive && session.role !== "admin") {
    throw new ApiError(401, "unauthenticated", "Доступ адміністратора змінився. Увійдіть знову");
  }
}

export function mountRolePreviewRoutes(app, db) {
  app.get("/api/role-preview/options", async (req, res) => {
    const session = req.passwordSession;
    assertPreviewAdministrator(session);
    if (session?.role !== "admin") forbidden();
    keys(req.query, []);
    const items = await db.transaction(async (tx) => {
      if ((await administratorSession(tx, session)).preview_active) forbidden();
      const users = await tx.prepare(`${previewUsers} ORDER BY u.display_name,u.id`).all();
      return users.map(({ id, displayName, role, roleName }) => ({ id, displayName, role, roleName }));
    }, { readOnly: true });
    res.json({ items });
  });

  app.put("/api/role-preview", async (req, res) => {
    const session = req.passwordSession;
    assertPreviewAdministrator(session);
    if (session?.role !== "admin" || session.previewActive) forbidden();
    keys(req.query, []);
    keys(req.body, ["userId"], ["userId"]);
    const userId = uuid(req.body.userId);
    await db.transaction(async (tx) => {
      if ((await administratorSession(tx, session)).preview_active) forbidden();
      if (!(await tx.prepare(`${previewUsers} AND u.id=?`).get(userId))) missing();
      await tx.prepare("INSERT INTO account_session_previews (session_id_hash,preview_user_id) VALUES (?,?)").run(session.hash, userId);
      await audit(tx, session.id, "enter_role_preview", "account", userId, null, null);
    });
    res.status(204).end();
  });

  app.delete("/api/role-preview", async (req, res) => {
    const session = req.passwordSession;
    assertPreviewAdministrator(session);
    if (session?.role !== "admin") forbidden();
    keys(req.query, []);
    await db.transaction(async (tx) => {
      await administratorSession(tx, session);
      await exitRolePreview(tx, session);
    });
    res.status(204).end();
  });
}
