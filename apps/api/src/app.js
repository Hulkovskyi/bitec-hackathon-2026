import express from "express";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { transaction } from "./database.js";
import { ApiError, keys, uuid, pagination, invalid } from "./validation.js";
import {
  access,
  selectMeasure,
  measure,
  getMeasure,
  saveMeasure,
  importRegistry,
  missing,
  forbidden,
  kyivDate,
} from "./registry.js";
const webBuild = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cookieName = "dacm_session";
const tokenFrom = (req) =>
  req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);

export function createApp(
  database,
  {
    demoMode = false,
    today = kyivDate,
    allowedOrigins = [
      "http://127.0.0.1:3001",
      "http://localhost:3001",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
  } = {},
) {
  const app = express();
  if (
    !demoMode &&
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get()
  )
    database.prepare("DELETE FROM sessions WHERE auth_kind='demo'").run();
  app.disable("x-powered-by");
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) => {
    try {
      database.prepare("SELECT 1").get();
      res.json({ status: "ok", database: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable", database: "unavailable" });
    }
  });
  app.use("/api/demo", (_req, _res, next) => {
    if (!demoMode) missing();
    next();
  });
  app.use("/api", (req, _res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !allowedOrigins.includes(req.headers.origin)
    )
      forbidden();
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/demo/users", (req, res) => {
    keys(req.query, []);
    res.json({
      items: database
        .prepare(
          "SELECT id,display_name AS displayName,role FROM users WHERE active=1 ORDER BY display_name,id",
        )
        .all(),
    });
  });
  app.post("/api/demo/session", (req, res) => {
    keys(req.body, ["userId"], ["userId"]);
    const userId = uuid(req.body.userId);
    if (
      !database
        .prepare("SELECT 1 FROM users WHERE id=? AND active=1")
        .get(userId)
    )
      throw new ApiError(401, "unauthenticated", "Користувач недоступний");
    const token = randomBytes(32).toString("hex");
    transaction(database, () => {
      const oldToken = tokenFrom(req);
      if (oldToken)
        database
          .prepare("DELETE FROM sessions WHERE id_hash=?")
          .run(hash(oldToken));
      database
        .prepare("DELETE FROM sessions WHERE expires_at<=?")
        .run(new Date().toISOString());
      database
        .prepare(
          "INSERT INTO sessions (id_hash,user_id,expires_at,auth_kind) VALUES (?,?,?,'demo')",
        )
        .run(
          hash(token),
          userId,
          new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        );
    });
    res
      .cookie(cookieName, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: req.secure,
        path: "/",
        maxAge: 8 * 60 * 60 * 1000,
      })
      .status(201)
      .json({ userId });
  });
  app.use("/api", (req, _res, next) => {
    const token = tokenFrom(req);
    req.user =
      demoMode &&
      token &&
      database
        .prepare(
          "SELECT u.id,u.display_name AS displayName,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.active=1",
        )
        .get(hash(token), new Date().toISOString());
    if (!req.user)
      throw new ApiError(401, "unauthenticated", "Увійдіть у демосесію");
    next();
  });
  app.delete("/api/session", (req, res) => {
    database
      .prepare("DELETE FROM sessions WHERE id_hash=?")
      .run(hash(tokenFrom(req)));
    res
      .clearCookie(cookieName, {
        httpOnly: true,
        sameSite: "strict",
        secure: req.secure,
        path: "/",
      })
      .status(204)
      .end();
  });
  app.get("/api/me", (req, res) => {
    keys(req.query, []);
    res.json({
      ...req.user,
      scopes: database
        .prepare(
          "SELECT program_id AS programId,department_id AS departmentId FROM user_scopes WHERE user_id=?",
        )
        .all(req.user.id),
    });
  });
  const programAllowed = (user, id) => {
    const row = database
      .prepare(
        `SELECT p.id FROM programs p WHERE p.id=? ${user.role === "admin" ? "" : "AND EXISTS (SELECT 1 FROM user_scopes us WHERE us.program_id=p.id AND us.user_id=?)"}`,
      )
      .get(...(user.role === "admin" ? [id] : [id, user.id]));
    if (!row) missing();
  };
  app.get("/api/programs", (req, res) => {
    keys(req.query, []);
    const admin = req.user.role === "admin";
    res.json({
      items: database
        .prepare(
          `SELECT p.id,p.code,p.title,p.period_start AS periodStart,p.period_end AS periodEnd FROM programs p ${admin ? "" : "WHERE EXISTS (SELECT 1 FROM user_scopes us WHERE us.program_id=p.id AND us.user_id=?)"} ORDER BY p.code,p.id`,
        )
        .all(...(admin ? [] : [req.user.id])),
    });
  });
  app.get("/api/programs/:id/registry-options", (req, res) => {
    keys(req.query, []);
    const id = uuid(req.params.id);
    programAllowed(req.user, id);
    const admin = req.user.role === "admin";
    const sections = database
      .prepare(
        "SELECT id,program_id AS programId,code,title FROM sections WHERE program_id=? ORDER BY code",
      )
      .all(id);
    const risks = database
      .prepare(
        "SELECT id,program_id AS programId,code,title FROM risks WHERE program_id=? ORDER BY code",
      )
      .all(id);
    const departments = database
      .prepare(
        `SELECT d.id,d.program_id AS programId,d.code,d.title FROM departments d WHERE d.program_id=? ${admin ? "" : "AND EXISTS (SELECT 1 FROM user_scopes us WHERE us.department_id=d.id AND us.program_id=d.program_id AND us.user_id=?)"} ORDER BY d.code`,
      )
      .all(...(admin ? [id] : [id, req.user.id]));
    const executors = ["coordinator", "admin"].includes(req.user.role)
      ? database
          .prepare(
            `SELECT u.id,u.display_name AS displayName,us.department_id AS departmentId FROM users u JOIN user_scopes us ON us.user_id=u.id WHERE u.active=1 AND u.role='executor' AND us.program_id=? ${admin ? "" : "AND EXISTS (SELECT 1 FROM user_scopes own WHERE own.user_id=? AND own.program_id=us.program_id AND own.department_id=us.department_id)"} ORDER BY u.display_name,u.id`,
          )
          .all(...(admin ? [id] : [id, req.user.id]))
      : [];
    const executorMap = new Map();
    for (const row of executors) {
      if (!executorMap.has(row.id))
        executorMap.set(row.id, {
          id: row.id,
          displayName: row.displayName,
          departmentIds: [],
        });
      executorMap.get(row.id).departmentIds.push(row.departmentId);
    }
    res.json({
      sections,
      departments,
      risks,
      executors: [...executorMap.values()],
    });
  });
  app.get("/api/measures", (req, res) => {
    keys(
      req.query,
      [
        "programId",
        "sectionId",
        "departmentId",
        "executorId",
        "active",
        "page",
        "pageSize",
      ],
      ["programId"],
    );
    const programId = uuid(req.query.programId);
    programAllowed(req.user, programId);
    const { page, pageSize } = pagination(req.query),
      rule = access(req.user);
    const conditions = ["s.program_id=?", rule.sql],
      params = [programId, ...rule.params];
    for (const [key, column] of [
      ["sectionId", "m.section_id"],
      ["departmentId", "m.department_id"],
      ["executorId", "m.executor_id"],
    ])
      if (Object.hasOwn(req.query, key)) {
        conditions.push(`${column}=?`);
        params.push(uuid(req.query[key]));
      }
    if (Object.hasOwn(req.query, "active")) {
      if (!["true", "false"].includes(req.query.active)) invalid();
      conditions.push("m.active=?");
      params.push(Number(req.query.active === "true"));
    }
    const where = conditions.join(" AND ");
    const total = database
      .prepare(
        `SELECT count(*) AS n FROM measures m JOIN sections s ON s.id=m.section_id WHERE ${where}`,
      )
      .get(...params).n;
    const items = database
      .prepare(
        `${selectMeasure} WHERE ${where} ORDER BY m.code,m.id LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize)
      .map(measure);
    res.json({ items, total, page, pageSize });
  });
  app.get("/api/measures/:id", (req, res) => {
    keys(req.query, []);
    res.json(getMeasure(database, req.user, uuid(req.params.id)));
  });
  app.post("/api/measures", (req, res) => {
    keys(req.query, []);
    const value = saveMeasure(database, req.user, req.body, undefined, {
      today,
    });
    res
      .status(201)
      .location("/api/measures/" + value.id)
      .json(value);
  });
  app.patch("/api/measures/:id", (req, res) => {
    keys(req.query, []);
    res.json(
      saveMeasure(database, req.user, req.body, uuid(req.params.id), { today }),
    );
  });
  app.get("/api/measures/:id/audit", (req, res) => {
    if (["leader", "analyst"].includes(req.user.role)) forbidden();
    keys(req.query, ["page", "pageSize"]);
    const id = uuid(req.params.id);
    getMeasure(database, req.user, id);
    const { page, pageSize } = pagination(req.query);
    const total = database
      .prepare(
        "SELECT count(*) AS n FROM audit_events WHERE entity_type='measure' AND entity_id=?",
      )
      .get(id).n;
    const items = database
      .prepare(
        "SELECT id,actor_id AS actorId,action,entity_type AS entityType,entity_id AS entityId,before_json,after_json,occurred_at AS occurredAt FROM audit_events WHERE entity_type='measure' AND entity_id=? ORDER BY occurred_at,id LIMIT ? OFFSET ?",
      )
      .all(id, pageSize, (page - 1) * pageSize)
      .map(({ before_json, after_json, ...row }) => ({
        ...row,
        before: JSON.parse(before_json),
        after: JSON.parse(after_json),
      }));
    res.json({ items, total, page, pageSize });
  });
  app.post("/api/imports/registry", (req, res) => {
    if (req.user.role !== "admin") forbidden();
    keys(req.query, []);
    res.status(201).json(importRegistry(database, req.user.id, req.body));
  });
  app.use("/api", (_req, _res) => missing());
  app.use(express.static(webBuild));
  app.use((error, _req, res, _next) => {
    let status = error.status || 500,
      code = error.code || "internal_error",
      message = error.message;
    if (error.type === "entity.too.large") {
      status = 413;
      code = "payload_too_large";
      message = "Пакет перевищує 1 MiB";
    } else if (error.type === "entity.parse.failed") {
      status = 400;
      code = "validation_error";
      message = "Некоректний JSON";
    } else if (error.code?.startsWith("ERR_SQLITE")) {
      if (error.errcode === 1555 || error.errcode === 2067) {
        status = 409;
        code = "duplicate_code";
        message = "Ідентифікатор або код уже існує";
      } else if ([787, 275, 1299].includes(error.errcode)) {
        status = 400;
        code = "validation_error";
        message = "Некоректні посилання або значення";
      } else {
        status = 500;
        code = "internal_error";
      }
    }
    if (status >= 500) {
      code = "internal_error";
      message = "Внутрішня помилка сервера";
    }
    res.status(status).json({ error: { code, message } });
  });
  return app;
}
