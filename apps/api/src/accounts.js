import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { adaptDatabase, databaseConstraintKind } from "./database.js";
import { rolePermissions } from "./permissions.js";
import { audit, forbidden, missing } from "./registry.js";
import { ApiError, invalid, keys, text, uuid } from "./validation.js";

const cookieName = "dacm_session";
const sessionDuration = 8 * 60 * 60 * 1000;
const deriveKey = promisify(scrypt);
const scryptOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const unknownHash = `${"0".repeat(32)}:${"0".repeat(128)}`;

function usernameKey(value) {
  const username = text(value, 64).normalize("NFKC").toLowerCase();
  if (!/^[\p{L}\p{Nd}][\p{L}\p{Nd}._-]{2,63}$/u.test(username)) {
    invalid("Логін має містити 3–64 літери, цифри, крапки, дефіси або підкреслення");
  }
  return username;
}

export function validateAccountPassword(value, minimum = 12) {
  if (typeof value !== "string" || value.length < minimum || value.length > 128 || !value.trim()) {
    invalid(minimum === 12 ? "Пароль має містити від 12 до 128 символів" : "Введіть пароль");
  }
  return value;
}

function profile(body) {
  return {
    username: usernameKey(body.username),
    fullName: text(body.fullName, 160),
    department: text(body.department, 160),
    position: text(body.position, 160),
  };
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, Buffer.from(salt, "hex"), 64, scryptOptions);
  return `${salt}:${key.toString("hex")}`;
}

async function passwordMatches(password, stored) {
  const [salt, expected] = (stored ?? unknownHash).split(":");
  const actual = await deriveKey(password, Buffer.from(salt, "hex"), 64, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function digest(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenFrom(req) {
  const token = req.headers.cookie?.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function cookieOptions(req, { secureCookies }) {
  return { httpOnly: true, sameSite: "strict", secure: secureCookies || req.secure, path: "/" };
}

async function deleteSession(db, token) {
  if (!token) return;
  const hash = digest(token);
  await db.prepare("DELETE FROM account_sessions WHERE id_hash=?").run(hash);
  await db.prepare("DELETE FROM sessions WHERE id_hash=?").run(hash);
}

function invalidCredentials() {
  throw new ApiError(401, "invalid_credentials", "Невірний логін або пароль");
}

async function startSession(db, req, res, options, userId, kind, verifiedPasswordHash) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = new Date(now + sessionDuration).toISOString();
  await db.transaction(async (tx) => {
    if (kind === "password") {
      const current = await tx.prepare(`
        SELECT 1 FROM credential_accounts a JOIN users u ON u.id=a.user_id
        WHERE a.user_id=? AND a.password_hash=? AND a.status='approved' AND u.active=1
      `).get(userId, verifiedPasswordHash);
      if (!current) invalidCredentials();
    }
    await deleteSession(tx, tokenFrom(req));
    const table = kind === "password" ? "account_sessions" : "sessions";
    await tx.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).run(new Date(now).toISOString());
    if (kind === "password") {
      await tx.prepare("INSERT INTO account_sessions (id_hash,user_id,expires_at) VALUES (?,?,?)")
        .run(digest(token), userId, expiresAt);
    } else {
      await tx.prepare("INSERT INTO sessions (id_hash,user_id,expires_at,auth_kind) VALUES (?,?,?,'demo')")
        .run(digest(token), userId, expiresAt);
    }
  });
  res.cookie(cookieName, token, { ...cookieOptions(req, options), maxAge: sessionDuration })
    .status(201).json({ userId });
}

function rateLimit(requests, windowMs, clientKey = (req) => req.ip) {
  const clients = new Map();
  let nextCleanup = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now >= nextCleanup) {
      for (const [key, value] of clients) {
        if (value.until <= now) clients.delete(key);
      }
      nextCleanup = now + windowMs;
    }
    const client = clientKey(req);
    let entry = clients.get(client);
    if (!entry || entry.until <= now) {
      entry = { count: 0, until: now + windowMs };
      if (clients.size >= 4096) clients.delete(clients.keys().next().value);
      clients.set(client, entry);
    }
    if (++entry.count > requests) {
      res.set("Retry-After", String(Math.ceil((entry.until - now) / 1000)));
      throw new ApiError(429, "too_many_requests", "Забагато спроб. Повторіть пізніше.");
    }
    next();
  };
}

export async function prepareAccountCredentials(values) {
  const data = profile(values);
  return { ...data, passwordHash: await passwordHash(validateAccountPassword(values.password)) };
}

export async function insertApprovedAccount(db, values, { roleId, baseRole, managerId = null, reviewedBy = null }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id,display_name,role,active) VALUES (?,?,?,1)")
    .run(id, values.fullName, baseRole);
  try {
    await db.prepare(`
      INSERT INTO credential_accounts (
        user_id,username,password_hash,department,position,role_id,status,created_at,manager_id,reviewed_at,reviewed_by
      ) VALUES (?,?,?,?,?,?,'approved',?,?,?,?)
    `).run(id, values.username, values.passwordHash, values.department, values.position,
      roleId, now, managerId, reviewedBy ? now : null, reviewedBy);
  } catch (error) {
    if (error.code === "42703" && error.message.includes("manager_id")) {
      throw new ApiError(503, "account_migration_required", "Для створення облікових записів застосуйте міграцію керівників у базі даних");
    }
    if (databaseConstraintKind(error) !== "unique") throw error;
    throw new ApiError(409, "username_taken", "Такий логін уже зареєстровано");
  }
  return id;
}

export async function createFirstAdministrator(database, values) {
  const data = await prepareAccountCredentials(values);
  return adaptDatabase(database).transaction(async (db) => {
    const existing = await db.prepare(`
      SELECT 1 FROM credential_accounts a JOIN users u ON u.id=a.user_id
      WHERE a.status='approved' AND u.role='admin' AND u.active=1 LIMIT 1
    `).get();
    if (existing) throw new ApiError(409, "admin_exists", "Активний адміністратор уже існує");
    const id = await insertApprovedAccount(db, data, { roleId: "admin", baseRole: "admin" });
    await audit(db, id, "bootstrap", "account", id, null, { username: data.username, roleId: "admin" });
    return { id, username: data.username, role: "admin" };
  });
}

export function mountLoginRoutes(app, db, options) {
  const demoAccountFilter = `u.active=1 AND NOT EXISTS (
    SELECT 1 FROM credential_accounts a WHERE a.user_id=u.id
  )`;
  app.get("/api/auth/options", (req, res) => {
    keys(req.query, []);
    res.json({ demoEnabled: options.demoMode, registrationEnabled: false });
  });
  app.post("/api/auth/register", () => {
    throw new ApiError(403, "registration_disabled", "Облікові записи створює адміністратор");
  });
  app.post("/api/auth/login", rateLimit(60, 10 * 60_000), async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["username", "password"], ["username", "password"]);
    const username = usernameKey(req.body.username);
    const password = validateAccountPassword(req.body.password, 1);
    const account = await db.prepare(`
      SELECT a.user_id, a.password_hash
      FROM credential_accounts a JOIN users u ON u.id=a.user_id
      WHERE a.username=? AND a.status='approved' AND u.active=1
    `).get(username);
    const valid = await passwordMatches(password, account?.password_hash);
    if (!valid || !account) invalidCredentials();
    await startSession(db, req, res, options, account.user_id, "password", account.password_hash);
  });

  app.use("/api/demo", (_req, _res, next) => {
    if (!options.demoMode) missing();
    next();
  });
  app.get("/api/demo/users", async (req, res) => {
    keys(req.query, []);
    res.json({ items: await db.prepare(`
      SELECT u.id,u.display_name AS displayName,u.role FROM users u
      WHERE ${demoAccountFilter} ORDER BY u.display_name,u.id
    `).all() });
  });
  app.post("/api/demo/session", async (req, res) => {
    keys(req.body, ["userId"], ["userId"]);
    const userId = uuid(req.body.userId);
    if (!(await db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND ${demoAccountFilter}`).get(userId))) {
      throw new ApiError(401, "unauthenticated", "Користувач недоступний");
    }
    await startSession(db, req, res, options, userId, "demo");
  });
}

export function accountManagerJoin(db) {
  // During a rolling Postgres upgrade, existing accounts can still sign in before manager_id is added.
  const managerId = db.dialect === "postgres" ? "(to_jsonb(a)->>'manager_id')" : "a.manager_id";
  return `LEFT JOIN users manager ON manager.id=${managerId}`;
}

export function mountSessionRoutes(app, db, options) {
  app.use("/api", async (req, _res, next) => {
    const token = tokenFrom(req);
    if (!token) throw new ApiError(401, "unauthenticated", "Увійдіть у систему");
    const hash = digest(token);
    const now = new Date().toISOString();
    const account = await db.prepare(`
      SELECT u.id, u.display_name AS displayName, u.role, a.username,
             a.department, a.position, a.status, a.role_id AS roleId,
             manager.id AS managerId, manager.display_name AS managerName,
             r.name AS roleName, r.permissions_json
      FROM account_sessions s JOIN credential_accounts a ON a.user_id=s.user_id
      JOIN users u ON u.id=a.user_id LEFT JOIN account_roles r ON r.id=a.role_id
      ${accountManagerJoin(db)}
      WHERE s.id_hash=? AND s.expires_at>? AND a.status='approved' AND u.active=1
    `).get(hash, now);
    if (account) {
      const { id, displayName, role, roleId, roleName, status, username, department, position, managerId, managerName } = account;
      req.user = {
        id, displayName, role, roleId, roleName, status, authKind: "password",
        permissions: rolePermissions(role, account.permissions_json),
        profile: { username, fullName: displayName, department, position, managerId, managerName },
      };
    } else if (options.demoMode) {
      const demo = await db.prepare(`
        SELECT u.id,u.display_name AS displayName,u.role,r.name AS roleName FROM sessions s
        JOIN users u ON u.id=s.user_id JOIN account_roles r ON r.id=u.role
        WHERE s.id_hash=? AND s.expires_at>? AND s.auth_kind='demo' AND u.active=1
          AND NOT EXISTS (SELECT 1 FROM credential_accounts a WHERE a.user_id=u.id)
      `).get(hash, now);
      if (demo) req.user = { ...demo, roleId: demo.role, status: "approved", authKind: "demo", permissions: rolePermissions(demo.role) };
    }
    if (!req.user) throw new ApiError(401, "unauthenticated", "Увійдіть у систему");
    next();
  });
  app.post("/api/auth/password", rateLimit(10, 10 * 60_000, (req) => req.user.id), async (req, res) => {
    if (req.user.authKind !== "password") forbidden();
    keys(req.query, []);
    const fields = ["currentPassword", "newPassword"];
    keys(req.body, fields, fields);
    const currentPassword = validateAccountPassword(req.body.currentPassword, 1);
    const newPassword = validateAccountPassword(req.body.newPassword);
    if (Buffer.from(currentPassword).equals(Buffer.from(newPassword))) {
      invalid("Новий пароль має відрізнятися від поточного");
    }
    const id = req.user.id;
    const sessionHash = digest(tokenFrom(req));
    const current = await db.prepare("SELECT password_hash FROM credential_accounts WHERE user_id=?").get(id);
    if (!(await passwordMatches(currentPassword, current?.password_hash)) || !current) {
      throw new ApiError(401, "invalid_credentials", "Невірний поточний пароль");
    }
    const replacementHash = await passwordHash(newPassword);
    await db.transaction(async (tx) => {
      const { changes } = await tx.prepare(`
        UPDATE credential_accounts SET password_hash=?
        WHERE user_id=? AND password_hash=? AND status='approved'
          AND EXISTS (SELECT 1 FROM users u WHERE u.id=credential_accounts.user_id AND u.active=1)
          AND EXISTS (
            SELECT 1 FROM account_sessions s
            WHERE s.user_id=credential_accounts.user_id AND s.id_hash=? AND s.expires_at>?
          )
      `).run(replacementHash, id, current.password_hash, sessionHash, new Date().toISOString());
      if (changes !== 1) throw new ApiError(409, "password_changed", "Пароль або сеанс уже змінився. Увійдіть знову");
      await tx.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
      await tx.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      await audit(tx, id, "change_password", "account", id, null, null);
    });
    res.clearCookie(cookieName, cookieOptions(req, options)).status(204).end();
  });
  app.delete("/api/session", async (req, res) => {
    await db.transaction((tx) => deleteSession(tx, tokenFrom(req)));
    res.clearCookie(cookieName, cookieOptions(req, options)).status(204).end();
  });
  app.get("/api/me", async (req, res) => {
    keys(req.query, []);
    const scopes = await db.prepare(`
      SELECT program_id AS programId,department_id AS departmentId FROM user_scopes WHERE user_id=?
      ORDER BY program_id,department_id
    `).all(req.user.id);
    res.json({ ...req.user, scopes });
  });
}
