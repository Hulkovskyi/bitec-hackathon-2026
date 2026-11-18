import { useEffect, useRef, useState } from "react";
import { halfYears } from "./periods.js";
import "./results.css";

const statusLabels = {
  draft: "Чернетка",
  submitted: "На перевірці",
  returned: "Повернено",
  approved: "Погоджено",
};

const outcomeLabels = {
  completed: "Виконано",
  partial: "Виконано частково",
  not_completed: "Не виконано",
};

const auditLabels = {
  create: "Створено результат",
  draft_created: "Створено чернетку",
  update: "Збережено зміни",
  result_updated: "Збережено зміни",
  submit: "Подано на перевірку",
  return: "Повернено на доопрацювання",
  approve: "Погоджено",
  result_reassigned: "Змінено виконавця",
  reassign: "Змінено виконавця",
  evidence_added: "Додано доказ",
  upload: "Завантажено доказ",
  replace: "Завантажено нову версію доказу",
};

const kyivToday = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" }).format(new Date());

const dateTime = (value) =>
  new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Kyiv",
  }).format(new Date(value));

const statusText = (result) => statusLabels[result.status] || result.status;

function periodsFor(measure, program) {
  const start = [measure.effectiveFrom, program.periodStart].sort().at(-1);
  const end = program.periodEnd;
  if (measure.scheduleType !== "continuous") {
    return [{ key: "once", start, end, label: "Одноразовий захід" }];
  }
  return halfYears(start, end);
}

const json = (method, body) => ({ method, body: JSON.stringify(body) });

function RequestError({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="result-error">
      <p role="alert">{error.message}</p>
      {onRetry && <button type="button" className="secondary" onClick={onRetry}>Оновити дані</button>}
    </div>
  );
}

export function ResultPanel({ measure, program, user, options, api, onPlanLockChange }) {
  const periods = periodsFor(measure, program);
  const today = kyivToday();
  const activePeriod = periods.find((period) => period.start <= today && period.end >= today);
  const [periodKey, setPeriodKey] = useState(
    () => periods.find((period) => period.key === measure.periodKey)?.key ||
      activePeriod?.key || periods.at(-1)?.key,
  );
  const period = periods.find((item) => item.key === periodKey);
  return (
    <section className="result-panel" aria-label="Результат виконання заходу">
      <header className="result-panel-heading">
        <h3>Результат виконання</h3>
        {periods.length > 1 && (
          <label className="result-period">
            Період виконання
            <select value={periodKey} onChange={(event) => setPeriodKey(event.target.value)}>
              {periods.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        )}
      </header>
      {period ? (
        <PeriodResults
          key={period.key}
          api={api}
          measure={measure}
          onPlanLockChange={onPlanLockChange}
          options={options}
          period={period}
          today={today}
          user={user}
        />
      ) : <p>Для цього заходу немає доступного періоду.</p>}
    </section>
  );
}

function PeriodResults({ api, measure, onPlanLockChange, options, period, today, user }) {
  const [data, setData] = useState(null);
  const [resultId, setResultId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [requestError, setRequestError] = useState(null);
  const [createBusy, setCreateBusy] = useState(false);
  const resultPath = `/measures/${measure.id}/results`;
  const assignmentPath = `/measures/${measure.id}/assignment`;
  const canAssign = user.role === "coordinator";
  const canExecute = user.role === "executor";

  useEffect(() => {
    const controller = new AbortController();
    const requestOptions = { signal: controller.signal };
    const assignment = canAssign || canExecute
      ? api(`${assignmentPath}?periodKey=${encodeURIComponent(period.key)}`, requestOptions)
          .catch((error) => {
            if (error.code === "not_found" && canExecute) return null;
            throw error;
          })
      : Promise.resolve(null);
    Promise.all([api(resultPath, requestOptions), assignment])
      .then(([response, currentAssignment]) => {
        if (controller.signal.aborted) return;
        if (canAssign) {
          const planFrozen = response.items.some((item) =>
            item.status === "submitted" || item.status === "approved");
          onPlanLockChange(measure.id, planFrozen);
        }
        const items = response.items
          .filter((item) => item.periodKey === period.key)
          .sort((a, b) => b.revision - a.revision);
        setData({ items, assignment: currentAssignment });
        setResultId((current) => items.some((item) => item.id === current)
          ? current : items[0]?.id || "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRequestError(error);
      });
    return () => controller.abort();
  }, [api, assignmentPath, canAssign, canExecute, measure.id, onPlanLockChange, period.key, refresh, resultPath]);

  function reload() {
    setRequestError(null);
    setRefresh((value) => value + 1);
  }

  async function createDraft() {
    setCreateBusy(true);
    setRequestError(null);
    try {
      const result = await api(resultPath, json("POST", { periodKey: period.key }));
      setResultId(result.id);
      reload();
    } catch (error) {
      setRequestError(error);
    } finally {
      setCreateBusy(false);
    }
  }

  if (!data) {
    return requestError
      ? <RequestError error={requestError} onRetry={reload} />
      : <p role="status">Завантажуємо результати…</p>;
  }

  const { items, assignment } = data;
  const latest = items[0];
  const openPeriod = measure.active &&
    (!latest || (latest.status === "approved" && latest.outcome !== "completed"));
  const ownAssignment = canExecute && assignment?.executorId === user.id;
  const allowAssign = measure.active && latest?.status !== "submitted" &&
    !(latest?.status === "approved" && latest.outcome === "completed");

  return (
    <>
      <RequestError error={requestError} onRetry={reload} />
      {canAssign && assignment && (
        <AssignmentForm
          key={`${assignment.executorId}-${assignment.version}`}
          api={api}
          path={assignmentPath}
          assignment={assignment}
          departmentId={measure.departmentId}
          executors={options?.executors || []}
          locked={!allowAssign}
          onChanged={reload}
          periodKey={period.key}
        />
      )}
      {canAssign && (
        <AssignmentHistory
          api={api}
          measureId={measure.id}
          periodKey={period.key}
          refresh={refresh}
        />
      )}
      <div className="result-toolbar">
        {items.length > 0 ? (
          <label>
            Версія результату
            <select value={resultId} onChange={(event) => setResultId(event.target.value)}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.revision} · {statusText(item)}
                </option>
              ))}
            </select>
          </label>
        ) : <p className="result-muted">За цей період ще немає результату.</p>}
        {ownAssignment && openPeriod && (
          <button type="button" disabled={createBusy} onClick={createDraft}>
            {latest ? "Створити наступну версію" : "Створити чернетку"}
          </button>
        )}
      </div>
      {resultId && (
        <ResultDetail
          key={resultId}
          api={api}
          resultId={resultId}
          period={period}
          user={user}
          today={today}
          refresh={refresh}
          onChanged={reload}
          ownAssignment={ownAssignment}
          unit={measure.indicator.unit}
        />
      )}
    </>
  );
}

function AssignmentForm({
  api, path, assignment, departmentId, executors, locked, onChanged, periodKey,
}) {
  const [executorId, setExecutorId] = useState(assignment.executorId);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const available = executors.filter((item) => item.departmentIds.includes(departmentId));

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(path, json("PUT", { executorId, periodKey, version: assignment.version }));
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <dl className="result-assignment-readonly">
        <dt>Виконавець цього періоду</dt>
        <dd>{available.find((item) => item.id === assignment.executorId)?.displayName
          || "Поточний виконавець недоступний"}</dd>
      </dl>
    );
  }
  return (
    <form className="result-toolbar result-assignment" onSubmit={save}>
      <label>
        Виконавець цього періоду
        <select value={executorId} disabled={busy} onChange={(event) => setExecutorId(event.target.value)}>
          {!available.some((item) => item.id === assignment.executorId) &&
            <option value={assignment.executorId}>Поточний виконавець недоступний</option>}
          {available.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select>
      </label>
      <button className="secondary" disabled={busy || executorId === assignment.executorId}>
        Змінити виконавця
      </button>
      <RequestError error={error} onRetry={error?.code === "version_conflict" ? onChanged : null} />
    </form>
  );
}

function AssignmentHistory({ api, measureId, periodKey, refresh }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const pageSize = 10;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ entityType: "period_assignment", periodKey, page, pageSize });
    setAudit(null);
    setError(null);
    api(`/measures/${measureId}/audit?${query}`, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setAudit(response);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [api, measureId, open, page, periodKey, refresh, retry]);

  return (
    <details className="result-assignment-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Зміни виконавця за період</summary>
      <RequestError error={error} onRetry={() => setRetry((value) => value + 1)} />
      {open && !audit && !error && <p role="status">Завантажуємо зміни призначення…</p>}
      {audit?.total === 0 && <p className="result-muted">Призначення ще не змінювали.</p>}
      {audit?.items.length > 0 && (
        <ol className="result-events">
          {audit.items.map((event) => (
            <li key={event.id}>
              <strong>Змінено виконавця</strong>
              <span className="result-event-meta">
                {event.actorName && <span>{event.actorName}</span>}
                <time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time>
              </span>
              <p className="result-text">
                {event.before?.executorName ?? "Попередній виконавець"} → {event.after?.executorName ?? "Новий виконавець"}
              </p>
            </li>
          ))}
        </ol>
      )}
      {audit?.total > pageSize && (
        <div className="result-action-row">
          <button type="button" className="secondary" disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}>Попередні призначення</button>
          <button type="button" className="secondary" disabled={page * pageSize >= audit.total}
            onClick={() => setPage((value) => value + 1)}>Наступні призначення</button>
        </div>
      )}
    </details>
  );
}

function draftFields(result) {
  return {
    outcome: result.outcome || "",
    description: result.description || "",
    nonCompletionReason: result.nonCompletionReason || "",
    resultDate: result.resultDate || "",
    actualDate: result.actualDate || "",
    measuredValue: result.measuredValue ?? "",
  };
}

function ResultDetail({
  api, onChanged, ownAssignment, period, refresh, resultId, today, unit, user,
}) {
  const [result, setResult] = useState(null);
  const [fields, setFields] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const mutation = useRef(null);
  const path = `/results/${resultId}`;
  const dirty = Boolean(result && fields &&
    Object.entries(draftFields(result)).some(([key, value]) => String(fields[key]) !== String(value)));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api(path, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setResult(loaded);
        setFields(draftFields(loaded));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, path, refresh]);

  useEffect(() => () => mutation.current?.abort(), []);

  if (!result) {
    return error
      ? <RequestError error={error} onRetry={() => { setError(null); onChanged(); }} />
      : <p role="status">Завантажуємо вибрану версію…</p>;
  }

  const editable = ownAssignment && result.executorId === user.id &&
    ["draft", "returned"].includes(result.status);
  const canReview = user.role === "coordinator" && result.status === "submitted" &&
    result.executorId !== user.id;
  const canCheck = ["admin", "coordinator"].includes(user.role);
  const canAudit = ["executor", "coordinator", "admin"].includes(user.role);
  const busyOrLoading = Boolean(busy) || loading;

  async function act(action, url, request) {
    const controller = new AbortController();
    mutation.current = controller;
    setError(null);
    setBusy(action);
    try {
      const value = await api(url, { ...request, signal: controller.signal });
      if (controller.signal.aborted) return false;
      if (action === "upload") {
        setResult((current) => ({ ...current, version: value.resultVersion }));
      } else {
        setResult((current) => ({ ...current, ...value }));
        setFields(draftFields({ ...result, ...value }));
      }
      if (action === "return" || action === "approve") setComment("");
      onChanged();
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
      return false;
    } finally {
      if (!controller.signal.aborted) setBusy("");
    }
  }

  function changeField(event) {
    const { name, value } = event.target;
    setFields((current) => ({ ...current, [name]: value }));
  }

  function save(event) {
    event.preventDefault();
    const noResult = fields.outcome === "not_completed";
    act("save", path, json("PATCH", {
      version: result.version,
      outcome: fields.outcome || null,
      description: fields.description,
      nonCompletionReason: fields.outcome === "completed" ? null : fields.nonCompletionReason || null,
      actualDate: noResult ? null : fields.actualDate || null,
      resultDate: (noResult ? fields.resultDate : fields.actualDate) || null,
      measuredValue: noResult || fields.measuredValue === "" ? null : Number(fields.measuredValue),
    }));
  }

  const returnedReview = (result.reviews || []).findLast((item) => item.decision === "return");
  return (
    <div className="result-detail">
      <p className="result-state" role="status">
        <strong>{statusText(result)}</strong>
        <span>Версія {result.revision}</span>
      </p>
      {result.status === "returned" && returnedReview && (
        <p className="result-return-note"><strong>Коментар координатора</strong><br />{returnedReview.comment}</p>
      )}
      <RequestError error={error} onRetry={error?.status === 409 || error?.code === "version_conflict"
        ? () => { setError(null); onChanged(); } : null} />
      {editable ? (
        <DraftForm
          busy={busyOrLoading}
          dirty={dirty}
          fields={fields}
          onChange={changeField}
          onSave={save}
          period={period}
          today={today}
          unit={unit}
        />
      ) : (
        <dl>
          <dt>Підсумок</dt><dd>{outcomeLabels[result.outcome] || "Не зазначено"}</dd>
          <dt>Опис</dt><dd className="result-text">{result.description || "Не зазначено"}</dd>
          {result.nonCompletionReason && <><dt>Причина</dt><dd className="result-text">{result.nonCompletionReason}</dd></>}
          <dt>Дата результату</dt><dd>{result.resultDate || "Не зазначено"}</dd>
          {result.measuredValue != null && <><dt>Значення індикатора</dt><dd>{result.measuredValue} {unit}</dd></>}
        </dl>
      )}
      <EvidenceArea
        api={api}
        key={result.id}
        disabled={busyOrLoading || dirty}
        editable={editable}
        canCheck={canCheck}
        result={result}
        onUpload={(body) => act("upload", `${path}/evidence`, { method: "POST", body })}
      />
      {editable && (
        <div className="result-submit">
          {dirty && <p className="result-muted">Збережіть зміни перед завантаженням файлу або поданням.</p>}
          <button
            type="button"
            disabled={busyOrLoading || dirty}
            onClick={() => act("submit", `${path}/submit`, json("POST", { version: result.version }))}
          >Подати на перевірку</button>
        </div>
      )}
      {canReview && (
        <div className="result-review">
          <label>
            Коментар до рішення
            <textarea value={comment} disabled={busyOrLoading} maxLength={4000} onChange={(event) => setComment(event.target.value)} />
          </label>
          <div className="result-action-row">
            <button
              className="secondary"
              disabled={busyOrLoading || !comment.trim()}
              onClick={() => act("return", `${path}/review`, json("POST", {
                decision: "return", comment, version: result.version,
              }))}
            >Повернути на доопрацювання</button>
            <button disabled={busyOrLoading} onClick={() => act("approve", `${path}/review`, json("POST", {
              decision: "approve", comment, version: result.version,
            }))}>Погодити результат</button>
          </div>
        </div>
      )}
      <ResultHistory api={api} canAudit={canAudit} result={result} user={user} />
    </div>
  );
}

function DraftForm({ busy, dirty, fields, onChange, onSave, period, today, unit }) {
  const noResult = fields.outcome === "not_completed";
  const dateLimit = today < period.end ? today : period.end;
  return (
    <form onSubmit={onSave} className="result-draft">
      <fieldset disabled={busy}>
        <div className="form-grid">
          <label>
            Підсумок виконання
            <select name="outcome" value={fields.outcome} onChange={onChange}>
              <option value="">Оберіть підсумок</option>
              {Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            {noResult ? "Дата фіксації стану" : "Фактична дата"}
            <input
              type="date"
              name={noResult ? "resultDate" : "actualDate"}
              min={period.start}
              max={dateLimit}
              value={noResult ? fields.resultDate : fields.actualDate}
              onChange={onChange}
            />
          </label>
          {!noResult && (
            <label>
              Значення індикатора{unit ? ` (${unit})` : ""}
              <input type="number" step="any" name="measuredValue" value={fields.measuredValue} onChange={onChange} />
            </label>
          )}
        </div>
        <label>
          Опис результату
          <textarea name="description" maxLength={4000} value={fields.description} onChange={onChange} />
        </label>
        {["not_completed", "partial"].includes(fields.outcome) && (
          <label>
            Причина невиконання
            <textarea name="nonCompletionReason" maxLength={4000} value={fields.nonCompletionReason} onChange={onChange} />
          </label>
        )}
        <button className="secondary" disabled={!dirty}>Зберегти зміни</button>
      </fieldset>
    </form>
  );
}

function EvidenceArea({ api, canCheck, disabled, editable, onUpload, result }) {
  const [file, setFile] = useState(null);
  const [replacement, setReplacement] = useState("");
  const [checked, setChecked] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);
  const current = result.evidence || [];
  const currentIds = new Set(current.map((item) => item.id));
  const older = (result.evidenceHistory || []).filter((item) => !currentIds.has(item.id));

  async function upload(event) {
    event.preventDefault();
    if (!file || disabled) return;
    const form = event.currentTarget;
    const body = new FormData();
    body.set("file", file);
    body.set("version", String(result.version));
    if (replacement) body.set("logicalFileId", replacement);
    if (await onUpload(body)) {
      form.reset();
      setFile(null);
      setReplacement("");
    }
  }

  async function check(item) {
    setCheckError(null);
    setChecking(true);
    setChecked(null);
    try {
      const integrity = await api(`/evidence/${item.id}/integrity`);
      setChecked({ name: item.originalName, intact: integrity.intact });
    } catch (cause) {
      setCheckError(cause);
    } finally {
      setChecking(false);
    }
  }

  function evidenceList(files) {
    return (
      <ul className="result-evidence-list">
        {files.map((item) => (
          <li key={item.id}>
            <div className="result-evidence-file">
              <a href={`/api/evidence/${item.id}/download`} download>{item.originalName}</a>
              <span className="result-muted">Версія {item.revision}</span>
              <details className="result-digest"><summary>SHA-256</summary><code>{item.sha256}</code></details>
            </div>
            {canCheck && (
              <button type="button" className="secondary" disabled={checking} onClick={() => check(item)}>
                Перевірити цілісність
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="result-evidence">
      <h4>Докази</h4>
      {current.length ? evidenceList(current) : <p className="result-muted">Актуальних файлів немає.</p>}
      {older.length > 0 && <details><summary>Історія версій файлів</summary>{evidenceList(older)}</details>}
      <RequestError error={checkError} />
      {checked && (
        <p role="status" className={checked.intact ? "result-integrity" : "result-integrity result-integrity-failed"}>
          {checked.name} · {checked.intact ? "Цілісність підтверджено" : "Цілісність не підтверджено"}
        </p>
      )}
      {editable && (
        <form onSubmit={upload} className="result-upload">
          <fieldset disabled={disabled}>
            {current.length > 0 && (
              <label>
                Дія з файлом
                <select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
                  <option value="">Додати новий файл</option>
                  {current.map((item) => (
                    <option key={item.logicalFileId} value={item.logicalFileId}>
                      Нова версія: {item.originalName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Синтетичний файл доказу
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.txt"
                onChange={(event) => setFile(event.target.files[0] || null)}
              />
            </label>
            <p className="result-muted">PDF, PNG, JPEG або TXT · до 5 МіБ</p>
            <button className="secondary" disabled={!file}>Завантажити доказ</button>
          </fieldset>
        </form>
      )}
    </div>
  );
}

function ResultHistory({ api, canAudit, result, user }) {
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const actorLabel = (item) => item.actorName || (item.actorId === user.id ? user.displayName : null);

  useEffect(() => {
    if (!showAudit || !canAudit) return;
    const controller = new AbortController();
    api(`/results/${result.id}/audit?page=${page}&pageSize=${pageSize}`, { signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) { setAudit(loaded); setError(null); }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [api, canAudit, page, result.id, result.version, showAudit]);

  if (!canAudit && !result.reviews?.length) return null;
  return (
    <div className="result-history">
      {result.reviews?.length > 0 && (
        <details>
          <summary>Історія погодження</summary>
          <ol className="result-events">
            {result.reviews.map((review) => (
              <li key={review.id}>
                <strong>{review.decision === "return" ? "Повернено на доопрацювання" : "Погоджено"}</strong>
                <span className="result-event-meta">
                  {actorLabel(review) && <span>{actorLabel(review)}</span>}
                  <time dateTime={review.createdAt}>{dateTime(review.createdAt)}</time>
                </span>
                {review.comment && <p className="result-text">{review.comment}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {canAudit && (
        <details onToggle={(event) => setShowAudit(event.currentTarget.open)}>
          <summary>Журнал змін результату</summary>
          <RequestError error={error} />
          {!audit && !error && showAudit && <p role="status">Завантажуємо журнал…</p>}
          {audit && (
            <>
              <ol className="result-events">
                {audit.items.map((entry) => (
                  <li key={entry.id}>
                    <strong>{auditLabels[entry.action] || entry.action}</strong>
                    <span className="result-event-meta">
                      {actorLabel(entry) && <span>{actorLabel(entry)}</span>}
                      <time dateTime={entry.occurredAt}>{dateTime(entry.occurredAt)}</time>
                    </span>
                    <AuditDetails entry={entry} />
                  </li>
                ))}
              </ol>
              {!audit.total && <p className="result-muted">Записів ще немає.</p>}
              {audit.total > pageSize && (
                <div className="result-action-row">
                  <button className="secondary" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
                    Попередні зміни
                  </button>
                  <button className="secondary" disabled={page * pageSize >= audit.total} onClick={() => setPage((value) => value + 1)}>
                    Наступні зміни
                  </button>
                </div>
              )}
            </>
          )}
        </details>
      )}
    </div>
  );
}

const auditFields = [
  ["outcome", "Підсумок", (value) => outcomeLabels[value]],
  ["description", "Опис"],
  ["non_completion_reason", "Причина невиконання"],
  ["result_date", "Дата результату"],
  ["actual_date", "Фактична дата"],
  ["measured_value", "Значення індикатора"],
];

function AuditDetails({ entry }) {
  if (entry.entityType === "evidence" && entry.after) {
    return <p className="result-text">{entry.after.originalName} · версія {entry.after.revision}</p>;
  }
  if (entry.action !== "update" || !entry.before || !entry.after) return null;
  const changedFields = auditFields.filter(([field]) => entry.before[field] !== entry.after[field]);
  if (!changedFields.length) return null;
  return (
    <details className="result-audit-details">
      <summary>Що змінилося</summary>
      <dl>
        {changedFields.map(([field, label, format = (value) => value]) => (
          <div key={field}>
            <dt>{label}</dt>
            <dd className="result-text">Було: {format(entry.before[field]) ?? "—"}</dd>
            <dd className="result-text">Стало: {format(entry.after[field]) ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
