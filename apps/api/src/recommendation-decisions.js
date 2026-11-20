import { createHash, randomUUID } from "node:crypto";
import { hasPermission, loadPermissions } from "./permissions.js";
import { audit, forbidden, missing, programAllowed, scope } from "./registry.js";
import { validPeriodKey } from "./result-access.js";
import { ApiError, choice, date, invalid, keys, pagination, positive, text, uuid } from "./validation.js";

const path = "/api/risk-flag-decisions";
const identityFields = ["programId", "source", "ruleCode", "subjectType", "subjectId", "periodKey"];
const decisionFields = ["action", "assigneeId", "dueDate", "version", "signalVersion"];
const identityWhere = "d.program_id=? AND d.source=? AND d.rule_code=? AND d.subject_type=? AND d.subject_id=? AND d.period_key=?";
const selection = `
  SELECT d.*, assignee.display_name AS assignee_name, actor.display_name AS decider_name
  FROM risk_flag_decisions d
  JOIN users assignee ON assignee.id=d.assignee_id
  JOIN users actor ON actor.id=d.decided_by
`;

function identity(input) {
  return {
    programId: uuid(input.programId),
    source: choice(input.source, ["live", "official"]),
    ruleCode: text(input.ruleCode, 64),
    subjectType: choice(input.subjectType, ["measure", "department", "risk"]),
    subjectId: uuid(input.subjectId),
    periodKey: validPeriodKey(input.periodKey),
  };
}

function present(row) {
  return {
    id: row.id,
    programId: row.program_id,
    departmentId: row.department_id,
    source: row.source,
    ruleCode: row.rule_code,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    periodKey: row.period_key,
    action: row.action,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    dueDate: row.due_date,
    decidedBy: row.decided_by,
    deciderName: row.decider_name,
    updatedAt: row.updated_at,
    version: row.version,
    signal: JSON.parse(row.signal_json),
  };
}

function canRead(user) {
  return user.role !== "executor" && hasPermission(user, "analytics.read");
}

function canDecide(user) {
  return !user.preview && canRead(user) && ["coordinator", "admin"].includes(user.role)
    && hasPermission(user, "workflow.review");
}

async function authorizeWriter(tx, user, passwordSession) {
  if (!canDecide(user)) forbidden();
  const account = await tx.prepare(`
    SELECT u.id, u.role FROM users u
    WHERE u.id=? AND u.active=1
      AND (?='demo' OR EXISTS (
        SELECT 1 FROM credential_accounts a
        JOIN account_sessions session ON session.user_id=a.user_id
        WHERE a.user_id=u.id AND a.status='approved' AND session.id_hash=? AND session.expires_at>?
          AND NOT EXISTS (SELECT 1 FROM account_session_previews p WHERE p.session_id_hash=session.id_hash)
      ))
  `).get(user.id, user.authKind, passwordSession?.hash ?? null, new Date().toISOString());
  if (!account) forbidden();
  const current = await loadPermissions(tx, account);
  if (!canDecide(current)) forbidden();
  return { ...current, authKind: user.authKind };
}

async function requireSignal(tx, user, key, getVisibleSignal) {
  await programAllowed(tx, user, key.programId);
  const signal = await getVisibleSignal(tx, user, key);
  if (!signal?.departmentId || !await scope(tx, user, key.programId, signal.departmentId)) missing();
  return signal;
}

function eligibleAssignees(tx, { programId, departmentId, authKind }) {
  return tx.prepare(`
    SELECT u.id, u.display_name AS "displayName" FROM users u
    WHERE u.active=1
      AND (u.role='admin' OR EXISTS (
        SELECT 1 FROM user_scopes s WHERE s.user_id=u.id AND s.program_id=? AND s.department_id=?
      ))
      AND (EXISTS (SELECT 1 FROM credential_accounts a WHERE a.user_id=u.id AND a.status='approved')
        OR (?='demo' AND NOT EXISTS (SELECT 1 FROM credential_accounts a WHERE a.user_id=u.id)))
    ORDER BY u.display_name, u.id
  `).all(programId, departmentId, authKind);
}

async function lookupDecision(tx, user, key) {
  const identityParams = Object.values(key);
  const access = decisionAccess(user);
  const row = await tx.prepare(`${selection} WHERE ${identityWhere} ${access.sql}`)
    .get(...identityParams, ...access.params);
  if (!row && await tx.prepare(`SELECT 1 FROM risk_flag_decisions d WHERE ${identityWhere}`).get(...identityParams)) missing();
  return row ? present(row) : null;
}

function decisionAccess(user) {
  if (user.role === "admin") return { sql: "", params: [] };
  const sql = `
    AND EXISTS (
      SELECT 1 FROM user_scopes s WHERE s.user_id=? AND s.program_id=d.program_id AND s.department_id=d.department_id
    )
    AND (
      d.measure_id IS NULL OR EXISTS (
        SELECT 1 FROM measures m JOIN user_scopes s
          ON s.department_id=m.department_id AND s.program_id=d.program_id AND s.user_id=?
        WHERE m.id=d.measure_id
      )
    )
    AND (
      d.risk_owner_department_id IS NULL OR EXISTS (
        SELECT 1 FROM user_scopes s
        WHERE s.user_id=? AND s.program_id=d.program_id AND s.department_id=d.risk_owner_department_id
      )
    )
    AND (
      d.risk_id IS NULL OR EXISTS (
        SELECT 1 FROM risk_indicators ri JOIN user_scopes s
          ON s.department_id=ri.owner_department_id AND s.program_id=ri.program_id AND s.user_id=?
        WHERE ri.risk_id=d.risk_id
      )
    )
    ${hasPermission(user, "risks.read") ? "" : "AND d.risk_id IS NULL"}
  `;
  return { sql, params: [user.id, user.id, user.id, user.id] };
}

async function listDecisions(tx, user, { programId, departmentId, page, pageSize }) {
  await programAllowed(tx, user, programId);
  if (departmentId && (!await tx.prepare("SELECT 1 FROM departments WHERE program_id=? AND id=?").get(programId, departmentId)
      || !await scope(tx, user, programId, departmentId))) missing();
  const access = decisionAccess(user);
  const where = `
    WHERE d.program_id=? ${departmentId ? "AND d.department_id=?" : ""} ${access.sql}
  `;
  const params = [programId, ...(departmentId ? [departmentId] : []), ...access.params];
  const { total } = await tx.prepare(`SELECT count(*) AS total FROM risk_flag_decisions d ${where}`).get(...params);
  const rows = await tx.prepare(`
    ${selection}
    ${where}
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map(present), canDecide: canDecide(user), total, page, pageSize };
}

function snapshot({ code, title, explanation, suggestedAction, sourceValues }) {
  return { code, title, explanation, suggestedAction, sourceValues };
}

function signalVersion(signal) {
  return createHash("sha256")
    .update(JSON.stringify({
      ...snapshot(signal), departmentId: signal.departmentId,
      riskId: signal.riskId, riskOwnerDepartmentId: signal.riskOwnerDepartmentId,
    })).digest("hex");
}

function conflict() {
  throw new ApiError(409, "version_conflict", "Рішення вже змінилося. Оновіть форму.");
}

export function mountRecommendationDecisionRoutes(app, db, { today, getVisibleSignal }) {
  app.get(path, async (req, res) => {
    if (!canRead(req.user)) forbidden();
    keys(req.query, ["programId", "departmentId", "page", "pageSize"], ["programId"]);
    const programId = uuid(req.query.programId);
    const departmentId = req.query.departmentId === undefined ? null : uuid(req.query.departmentId);
    const query = { programId, departmentId, ...pagination(req.query) };
    const result = await db.transaction((tx) => listDecisions(tx, req.user, query), { readOnly: true });
    res.json(result);
  });

  app.get(`${path}/assignees`, async (req, res) => {
    if (!canDecide(req.user)) forbidden();
    keys(req.query, identityFields, identityFields);
    const key = identity(req.query);
    const result = await db.transaction(async (tx) => {
      const signal = await requireSignal(tx, req.user, key, getVisibleSignal);
      const items = await eligibleAssignees(tx, { ...key, departmentId: signal.departmentId, authKind: req.user.authKind });
      return { items, decision: await lookupDecision(tx, req.user, key), signalVersion: signalVersion(signal) };
    }, { readOnly: true });
    res.json(result);
  });

  app.put(path, async (req, res) => {
    if (!canDecide(req.user)) forbidden();
    keys(req.query, []);
    keys(req.body, [...identityFields, ...decisionFields], [...identityFields, ...decisionFields]);
    const key = identity(req.body);
    const action = text(req.body.action, 2000);
    const assigneeId = uuid(req.body.assigneeId);
    const dueDate = date(req.body.dueDate);
    const version = req.body.version === 0 ? 0 : positive(req.body.version);
    if (typeof req.body.signalVersion !== "string" || !/^[a-f0-9]{64}$/.test(req.body.signalVersion)) invalid();

    const saved = await db.transaction(async (tx) => {
      const actor = await authorizeWriter(tx, req.user, req.passwordSession);
      const asOf = today();
      if (dueDate < asOf) invalid("Строк виконання має бути сьогодні або в майбутньому.");
      const signal = await requireSignal(tx, actor, key, getVisibleSignal);
      if (req.body.signalVersion !== signalVersion(signal)) {
        throw new ApiError(409, "signal_changed", "Дані сигналу змінилися. Відкрийте його знову.");
      }
      const before = await lookupDecision(tx, actor, key);
      if (version !== (before?.version ?? 0)) conflict();

      const { departmentId } = signal;
      const available = await eligibleAssignees(tx, { ...key, departmentId, authKind: req.user.authKind });
      if (!available.some(({ id }) => id === assigneeId)) invalid("Відповідальний має бути активним і мати доступ до підрозділу.");

      const updatedAt = new Date().toISOString();
      const signalJson = JSON.stringify(snapshot(signal));
      const measureId = key.subjectType === "measure" ? key.subjectId : null;
      const riskId = key.subjectType === "risk" ? key.subjectId : signal.riskId ?? null;
      const riskOwnerDepartmentId = signal.riskOwnerDepartmentId ?? null;
      if (before) {
        const changed = await tx.prepare(`
          UPDATE risk_flag_decisions
          SET department_id=?, risk_id=?, risk_owner_department_id=?, action=?, assignee_id=?, due_date=?,
            decided_by=?, updated_at=?, version=version+1, signal_json=?
          WHERE id=? AND version=?
        `).run(departmentId, riskId, riskOwnerDepartmentId, action, assigneeId, dueDate,
          actor.id, updatedAt, signalJson, before.id, version);
        if (!changed.changes) conflict();
      } else {
        const inserted = await tx.prepare(`
          INSERT INTO risk_flag_decisions (
            id, program_id, source, rule_code, subject_type, subject_id, period_key, department_id,
            measure_id, risk_id, risk_owner_department_id, action, assignee_id, due_date, decided_by,
            updated_at, version, signal_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
          ON CONFLICT (program_id, source, rule_code, subject_type, subject_id, period_key) DO NOTHING
        `).run(randomUUID(), ...Object.values(key), departmentId, measureId, riskId, riskOwnerDepartmentId,
          action, assigneeId, dueDate, actor.id, updatedAt, signalJson);
        if (!inserted.changes) conflict();
      }

      const after = await lookupDecision(tx, actor, key);
      await audit(tx, actor.id, before ? "update_risk_flag_decision" : "create_risk_flag_decision",
        "risk_flag_decision", after.id, before, after);
      return after;
    });
    res.json(saved);
  });
}
