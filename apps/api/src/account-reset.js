import { insertApprovedAccount, prepareAccountCredentials } from "./accounts.js";
import { adaptDatabase } from "./database.js";
import { audit } from "./registry.js";

export async function resetAccounts(database, { password, fullName, department, position }) {
  const credentials = await prepareAccountCredentials({
    username: "admin",
    password,
    fullName: fullName ?? "Адміністратор",
    department: department ?? "Адміністрація",
    position: position ?? "Адміністратор",
  });

  return adaptDatabase(database).transaction(async (db) => {
    const { count } = await db.prepare("SELECT count(*) AS count FROM credential_accounts").get();
    const existingAdmin = count === 1 && await db.prepare(`
      SELECT a.user_id FROM credential_accounts a JOIN users u ON u.id=a.user_id
      WHERE a.username='admin' AND a.role_id='admin' AND a.status='approved'
        AND u.role='admin' AND u.active=1
    `).get();

    await db.prepare("DELETE FROM account_sessions").run();
    await db.prepare("DELETE FROM sessions").run();
    await db.prepare("DELETE FROM user_scopes WHERE user_id IN (SELECT user_id FROM credential_accounts)").run();

    let id;
    if (existingAdmin) {
      id = existingAdmin.user_id;
      await db.prepare("UPDATE users SET display_name=COALESCE(?,display_name) WHERE id=?")
        .run(fullName == null ? null : credentials.fullName, id);
      await db.prepare(`
        UPDATE credential_accounts SET password_hash=?, manager_id=NULL,
          department=COALESCE(?,department), position=COALESCE(?,position)
        WHERE user_id=?
      `).run(credentials.passwordHash, department == null ? null : credentials.department,
        position == null ? null : credentials.position, id);
    } else {
      await db.prepare("UPDATE users SET active=0 WHERE id IN (SELECT user_id FROM credential_accounts)").run();
      await db.prepare("UPDATE credential_accounts SET manager_id=NULL WHERE manager_id IS NOT NULL").run();
      await db.prepare("DELETE FROM credential_accounts").run();
      id = await insertApprovedAccount(db, credentials, { roleId: "admin", baseRole: "admin" });
    }

    const retainedIdentity = Boolean(existingAdmin);
    const retiredAccounts = retainedIdentity ? 0 : count;
    await audit(db, id, "reset_accounts", "account", id, null, {
      username: credentials.username, roleId: "admin", retiredAccounts, retainedIdentity,
    });
    return { id, username: credentials.username, retiredAccounts, retainedIdentity };
  });
}
