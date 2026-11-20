import express from "express";
import { fileURLToPath } from "node:url";
import { adaptDatabase, databaseConstraintKind } from "./database.js";
import { ApiError, choice, keys, uuid, pagination, invalid, text } from "./validation.js";
import { mountLoginRoutes, mountSessionRoutes } from "./accounts.js";
import { mountAccountAdminRoutes } from "./account-admin.js";
import { mountDepartmentAdminRoutes } from "./department-admin.js";
import { mountCatalogAdminRoutes } from "./catalog-admin.js";
import { hasPermission } from "./permissions.js";
import {
  access,
  executorAccountFilter,
  selectPeriodMeasure,
  periodMeasure,
  getMeasure,
  riskCatalogScope,
  saveMeasure,
  deleteMeasure,
  importRegistry,
  missing,
  forbidden,
  kyivDate,
  programAllowed,
} from "./registry.js";
import { createEvidenceStore, mountEvidenceRoutes } from "./evidence.js";
import { mountResultRoutes } from "./result-routes.js";
import { mountDashboardRoutes } from "./dashboard.js";
import { mountReportRoutes } from "./half-year-report.js";
import { mountProgramRiskRoutes } from "./program-risk.js";
const webBuild = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const defaultEvidenceDirectory = fileURLToPath(new URL("../../../data/evidence", import.meta.url));
export function createApp(
  database,
  {
    demoMode = false,
    today = kyivDate,
    evidenceDirectory = defaultEvidenceDirectory,
    evidenceStore,
    secureCookies = false,
    serveWeb = true,
    checkReadiness,
    allowedOrigins = [
      "http://127.0.0.1:3001",
      "http://localhost:3001",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
  } = {},
) {
  const app = express();
  const evidence = evidenceStore ?? createEvidenceStore(database, { directory: evidenceDirectory });
  if (
    !demoMode && !database.dialect &&
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get()
  )
    database.prepare("DELETE FROM sessions WHERE auth_kind='demo'").run();
  database = adaptDatabase(database);
  app.disable("x-powered-by");
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", async (_req, res) => {
    try {
      await database.prepare("SELECT 1").get();
      await checkReadiness?.();
      res.json({ status: "ok", database: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable", database: "unavailable" });
    }
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
  const authOptions = { demoMode, secureCookies };
  mountLoginRoutes(app, database, authOptions);
  mountSessionRoutes(app, database, authOptions);
  mountAccountAdminRoutes(app, database);
  async function finishDeletion(res) {
    let pendingEvidence;
    try {
      pendingEvidence = await evidence.drainDeletions();
    } catch {
      // The record deletion has already committed. Preserve the pending queue.
      return res.status(202).json({ pendingEvidence: null });
    }
    return pendingEvidence
      ? res.status(202).json({ pendingEvidence })
      : res.status(204).end();
  }
  app.get("/api/admin/evidence-deletions", async (req, res) => {
    keys(req.query, []);
    res.json({ pendingEvidence: await evidence.pendingDeletions() });
  });
  app.post("/api/admin/evidence-deletions/retry", async (req, res) => {
    keys(req.query, []);
    if (req.body !== undefined) keys(req.body, []);
    return finishDeletion(res);
  });
  mountDepartmentAdminRoutes(app, database, { finishDeletion });
  mountCatalogAdminRoutes(app, database);
  app.get("/api/programs", async (req, res) => {
    keys(req.query, []);
    const admin = req.user.role === "admin";
    res.json({
      items: await database
        .prepare(
          `SELECT p.id,p.code,p.title,p.period_start AS periodStart,p.period_end AS periodEnd FROM programs p ${admin ? "" : "WHERE EXISTS (SELECT 1 FROM user_scopes us WHERE us.program_id=p.id AND us.user_id=?)"} ORDER BY p.code,p.id`,
        )
        .all(...(admin ? [] : [req.user.id])),
    });
  });
  app.get("/api/programs/:id/registry-options", async (req, res) => {
    const body = await database.transaction(async (database) => {
      keys(req.query, []);
      const id = uuid(req.params.id);
      await programAllowed(database, req.user, id);
      const admin = req.user.role === "admin";
      const sections = await database
        .prepare(
          "SELECT id,program_id AS programId,code,title FROM sections WHERE program_id=? ORDER BY code",
        )
        .all(id);
      const canPlan = !req.user.preview && hasPermission(req.user, "registry.write");
      const riskScope = riskCatalogScope(req.user, { includeUnowned: canPlan });
      const risks = canPlan || hasPermission(req.user, "risks.read") ? await database.prepare(`
        SELECT r.id,r.program_id AS "programId",r.code,r.title
        FROM risks r LEFT JOIN risk_indicators ri ON ri.risk_id=r.id
        WHERE r.program_id=? AND ${riskScope.sql} ORDER BY r.code,r.id
      `).all(id, ...riskScope.params) : [];
      const departments = await database
        .prepare(
          `SELECT d.id,d.program_id AS programId,d.code,d.title FROM departments d WHERE d.program_id=? ${admin ? "" : "AND EXISTS (SELECT 1 FROM user_scopes us WHERE us.department_id=d.id AND us.program_id=d.program_id AND us.user_id=?)"} ORDER BY d.code`,
        )
        .all(...(admin ? [id] : [id, req.user.id]));
      const executors = (hasPermission(req.user, "registry.write") || hasPermission(req.user, "workflow.assign"))
        ? await database
            .prepare(
              `SELECT u.id,u.display_name AS displayName,us.department_id AS departmentId FROM users u JOIN user_scopes us ON us.user_id=u.id WHERE u.active=1 AND u.role='executor' AND us.program_id=? ${executorAccountFilter(req.user)} ${admin ? "" : "AND EXISTS (SELECT 1 FROM user_scopes own WHERE own.user_id=? AND own.program_id=us.program_id AND own.department_id=us.department_id)"} ORDER BY u.display_name,u.id`,
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
      return {
        sections,
        departments,
        risks,
        executors: [...executorMap.values()],
      };
    }, { readOnly: true });
    res.json(body);
  });
  app.get("/api/measures", async (req, res) => {
    const body = await database.transaction(async (database) => {
      keys(
        req.query,
        [
          "programId",
          "sectionId",
          "departmentId",
          "executorId",
          "active",
          "periodKey",
          "q",
          "page",
          "pageSize",
        ],
        ["programId"],
      );
      const programId = uuid(req.query.programId);
      await programAllowed(database, req.user, programId);
      const { page, pageSize } = pagination(req.query),
        rule = access(req.user, { periodKey: req.query.periodKey, today: today() });
      const conditions = ["s.program_id=?", rule.sql],
        params = [programId, ...rule.params];
      for (const [key, column] of [
        ["sectionId", "m.section_id"],
        ["departmentId", "m.department_id"],
      ])
        if (Object.hasOwn(req.query, key)) {
          conditions.push(`${column}=?`);
          params.push(uuid(req.query[key]));
        }
      if (Object.hasOwn(req.query, "executorId")) {
        conditions.push(`${rule.executor}=?`);
        params.push(rule.period, uuid(req.query.executorId));
      }
      if (Object.hasOwn(req.query, "active")) {
        if (!["true", "false"].includes(req.query.active)) invalid();
        conditions.push("m.active=?");
        params.push(Number(req.query.active === "true"));
      }
      const where = conditions.join(" AND ");
      const offset = (page - 1) * pageSize;
      const filter = req.query.q === undefined ? "" : text(req.query.q, 200, true).normalize("NFC").toLocaleLowerCase("uk");
      let total, rows;
      if (filter) {
        // SQLite lower() is ASCII-only. Match literal Ukrainian text consistently on both databases.
        const candidates = await database.prepare(`
          SELECT m.id,m.code,m.title FROM measures m JOIN sections s ON s.id=m.section_id
          WHERE ${where} ORDER BY m.code,m.id
        `).all(...params);
        const matches = candidates.filter(({ code, title }) =>
          `${code} ${title}`.normalize("NFC").toLocaleLowerCase("uk").includes(filter));
        const ids = matches.slice(offset, offset + pageSize).map(({ id }) => id);
        total = matches.length;
        rows = ids.length ? await database.prepare(`
          ${selectPeriodMeasure(rule)} WHERE m.id IN (${ids.map(() => "?").join(",")}) ORDER BY m.code,m.id
        `).all(rule.period, ...ids) : [];
      } else {
        ({ n: total } = await database.prepare(
          `SELECT count(*) AS n FROM measures m JOIN sections s ON s.id=m.section_id WHERE ${where}`,
        ).get(...params));
        rows = await database.prepare(
          `${selectPeriodMeasure(rule)} WHERE ${where} ORDER BY m.code,m.id LIMIT ? OFFSET ?`,
        ).all(rule.period, ...params, pageSize, offset);
      }
      const items = rows.map((row) => periodMeasure(row, req.user, rule.period));
      return { items, total, page, pageSize };
    }, { readOnly: true });
    res.json(body);
  });
  app.get("/api/measures/:id", async (req, res) => {
    keys(req.query, ["periodKey", "source"]);
    const archive = choice(req.query.source ?? "live", ["live", "official"]) === "official";
    const id = uuid(req.params.id);
    const options = { periodKey: req.query.periodKey, today: today(), archive };
    const result = archive
      ? await database.transaction((tx) => getMeasure(tx, req.user, id, options), { readOnly: true })
      : await getMeasure(database, req.user, id, options);
    res.json(result);
  });
  app.post("/api/measures", async (req, res) => {
    keys(req.query, []);
    const value = await saveMeasure(database, req.user, req.body, undefined, {
      today,
    });
    res
      .status(201)
      .location("/api/measures/" + value.id)
      .json(value);
  });
  app.patch("/api/measures/:id", async (req, res) => {
    keys(req.query, []);
    res.json(
      await saveMeasure(database, req.user, req.body, uuid(req.params.id), { today }),
    );
  });
  app.delete("/api/measures/:id", async (req, res) => {
    keys(req.query, []);
    keys(req.body, ["version"], ["version"]);
    await deleteMeasure(database, req.user, uuid(req.params.id), req.body.version);
    return finishDeletion(res);
  });
  app.get("/api/measures/:id/audit", async (req, res) => {
    const body = await database.transaction(async (database) => {
      if (!hasPermission(req.user, "audit.read")) forbidden();
      keys(req.query, ["page", "pageSize", "entityType", "periodKey"]);
      const { entityType, periodKey } = req.query;
      if (entityType !== undefined && !["measure", "period_assignment"].includes(entityType)) invalid();
      const canReadAssignments = hasPermission(req.user, "audit.assignments");
      if (entityType === "period_assignment" && !canReadAssignments) forbidden();
      const id = uuid(req.params.id);
      await getMeasure(database, req.user, id, { periodKey, today: today() });
      const { page, pageSize } = pagination(req.query);

      const conditions = ["a.entity_id=?"];
      const params = [id];
      if (entityType || !canReadAssignments) {
        conditions.push("a.entity_type=?");
        params.push(entityType ?? "measure");
      } else {
        conditions.push("a.entity_type IN ('measure','period_assignment')");
      }
      const jsonField = (column, field) => database.dialect === "postgres"
        ? `CAST(${column} AS jsonb)->>'${field}'`
        : `json_extract(${column}, '$.${field}')`;
      if (periodKey !== undefined) {
        conditions.push(`(a.entity_type<>'period_assignment' OR (${jsonField("a.after_json", "periodKey")})=?)`);
        params.push(periodKey);
      }
      const where = conditions.join(" AND ");
      const { n: total } = await database
        .prepare(`SELECT count(*) AS n FROM audit_events a WHERE ${where}`)
        .get(...params);
      const rows = await database
        .prepare(
          `SELECT a.id,a.actor_id AS actorId,actor.display_name AS actorName,a.action,
                  a.entity_type AS entityType,a.entity_id AS entityId,a.before_json,a.after_json,
                  a.occurred_at AS occurredAt,previous.display_name AS before_name,
                  replacement.display_name AS after_name
           FROM audit_events a JOIN users actor ON actor.id=a.actor_id
           LEFT JOIN users previous ON a.entity_type='period_assignment'
             AND previous.id=(${jsonField("a.before_json", "executorId")})
           LEFT JOIN users replacement ON a.entity_type='period_assignment'
             AND replacement.id=(${jsonField("a.after_json", "executorId")})
           WHERE ${where} ORDER BY a.occurred_at,a.id LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      const items = rows.map(({ before_json, after_json, before_name, after_name, ...row }) => {
          const before = JSON.parse(before_json);
          const after = JSON.parse(after_json);
          if (row.entityType === "period_assignment") {
            if (before) before.executorName = before_name;
            if (after) after.executorName = after_name;
          }
          return { ...row, before, after };
        });
      return { items, total, page, pageSize };
    }, { readOnly: true });
    res.json(body);
  });
  app.post("/api/imports/registry", async (req, res) => {
    if (req.user.role !== "admin") forbidden();
    keys(req.query, []);
    res.status(201).json(await importRegistry(database, req.user.id, req.body));
  });
  mountResultRoutes(app, database, { today, evidence });
  mountEvidenceRoutes(app, database, evidence);
  mountDashboardRoutes(app, database, { today, evidence });
  mountReportRoutes(app, database, { today });
  mountProgramRiskRoutes(app, database, { today });
  app.use("/api", (_req, _res) => missing());
  if (serveWeb) app.use(express.static(webBuild));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
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
    } else {
      const constraint = databaseConstraintKind(error);
      if (constraint === "unique") {
        status = 409;
        code = "duplicate_code";
        message = "Ідентифікатор або код уже існує";
      } else if (constraint === "invalid") {
        status = 400;
        code = "validation_error";
        message = "Некоректні посилання або значення";
      }
    }
    if (status >= 500 && !(error instanceof ApiError && code === "insufficient_storage")) {
      code = "internal_error";
      message = "Внутрішня помилка сервера";
    }
    res.status(status).json({ error: { code, message } });
  });
  return app;
}
