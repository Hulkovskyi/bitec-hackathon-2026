import { useEffect, useRef, useState } from "react";
import { measurePeriods } from "./measure-schedule.js";
import { kyivToday } from "./periods.js";
import { hasPermission } from "./permissions.js";
import "./results.css";

const evidenceLimitMiB = import.meta.env.VITE_HOSTED_DEMO === "true" ? 4 : 5;

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

const dateTime = (value) =>
  new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Kyiv",
  }).format(new Date(value));

const statusText = (result) => statusLabels[result.status] || result.status;

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

export function ResultPanel({ measure, program, user, options, api, onPlanLockChange, sourceResultId }) {
  const periods = measurePeriods(measure, program);
  const today = kyivToday();
  const activePeriod = periods.find((period) => period.start <= today && period.end >= today);
  const [periodKey, setPeriodKey] = useState(
    () => periods.find((period) => period.key === measure.periodKey)?.key ||
      activePeriod?.key || (today < periods[0]?.start ? periods[0]?.key : periods.at(-1)?.key),
  );
  const period = periods.find((item) => item.key === periodKey);
  return (
    <section className="result-panel" aria-label="Результат виконання заходу">
      <header className="result-panel-heading">
        <div>
          <h3>Результат виконання</h3>
          <p className="result-measure-title">{measure.title}</p>
        </div>
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
          sourceResultId={period.key === measure.periodKey ? sourceResultId : null}
          today={today}
          user={user}
        />
      ) : <p>Для цього заходу немає доступного періоду.</p>}
    </section>
  );
}

function PeriodResults({ api, measure, onPlanLockChange, options, period, sourceResultId, today, user }) {
  const [data, setData] = useState(null);
  const [resultId, setResultId] = useState(sourceResultId ?? "");
  const [refresh, setRefresh] = useState(0);
  const [requestError, setRequestError] = useState(null);
  const [createBusy, setCreateBusy] = useState(false);
  const resultPath = `/measures/${measure.id}/results`;
  const assignmentPath = `/measures/${measure.id}/assignment`;
  const isExecutor = user.role === "executor";
  const canAssign = !user.preview && hasPermission(user, "workflow.assign", user.role === "coordinator");
  const canSubmit = !user.preview && hasPermission(user, "workflow.submit", isExecutor);
  const canTrackAssignments = hasPermission(user, "audit.read", user.role === "coordinator") &&
    hasPermission(user, "audit.assignments", user.role === "coordinator");
  const canEditPlan = !user.preview && !isExecutor && hasPermission(user, "registry.write", user.role === "coordinator");

  useEffect(() => {
    const controller = new AbortController();
    const requestOptions = { signal: controller.signal };
    const assignment = canAssign || canSubmit
      ? api(`${assignmentPath}?periodKey=${encodeURIComponent(period.key)}`, requestOptions)
          .catch((error) => {
            if (error.code === "not_found" && isExecutor) return null;
            throw error;
          })
      : Promise.resolve(null);
    Promise.all([api(resultPath, requestOptions), assignment])
      .then(([response, currentAssignment]) => {
        if (controller.signal.aborted) return;
        if (canEditPlan) {
          const planFrozen = response.items.some((item) =>
            item.status === "submitted" || item.status === "approved");
          onPlanLockChange(measure.id, planFrozen);
        }
        const items = response.items
          .filter((item) => item.periodKey === period.key)
          .sort((a, b) => b.revision - a.revision);
        setData({ items, assignment: currentAssignment });
        setResultId((current) => current && (
          current === sourceResultId || items.some((item) => item.id === current)
        ) ? current : items[0]?.id || "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRequestError(error);
      });
    return () => controller.abort();
  }, [api, assignmentPath, canAssign, canEditPlan, canSubmit, isExecutor, measure.id, onPlanLockChange, period.key, refresh, resultPath, sourceResultId]);

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
  const selectedResult = items.find((item) => item.id === resultId);
  const sourceUnavailable = sourceResultId && resultId === sourceResultId && !selectedResult;
  const latest = items[0];
  const openPeriod = measure.active &&
    (!latest || (latest.status === "approved" && latest.outcome !== "completed"));
  const writableExecutorId = canSubmit && (!isExecutor || assignment?.executorId === user.id)
    ? assignment?.executorId : null;
  const allowAssign = measure.active && latest?.status !== "submitted" &&
    !(latest?.status === "approved" && latest.outcome === "completed");

  return (
    <>
      <RequestError error={requestError} onRetry={reload} />
      {sourceUnavailable && (
        <p role="status" className="result-muted">Ревізія із сигналу недоступна в цьому періоді.</p>
      )}
      <div className="result-controls">
        {(canAssign || canTrackAssignments) && (
          <div className="result-assignment-tools">
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
            {canTrackAssignments && (
              <AssignmentHistory api={api} measureId={measure.id} periodKey={period.key} refresh={refresh} />
            )}
          </div>
        )}
        <div className="result-toolbar">
          {items.length > 0 ? (
            <label>
              Версія результату
              <select value={selectedResult?.id ?? ""} onChange={(event) => setResultId(event.target.value)}>
                {!selectedResult && <option value="" disabled>Оберіть версію</option>}
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.revision} · {statusText(item)}
                  </option>
                ))}
              </select>
            </label>
          ) : <p className="result-muted">За цей період ще немає результату.</p>}
          {writableExecutorId && openPeriod && (
            <button type="button" disabled={createBusy} onClick={createDraft}>
              {latest ? "Створити наступну версію" : "Створити чернетку"}
            </button>
          )}
        </div>
      </div>
      {selectedResult && (
        <ResultDetail
          key={resultId}
          api={api}
          resultId={resultId}
          period={period}
          user={user}
          today={today}
          refresh={refresh}
          onChanged={reload}
          writableExecutorId={writableExecutorId}
          unit={measure.indicator.unit}
          executors={options?.executors || []}
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
  api, executors, onChanged, period, refresh, resultId, today, unit, user, writableExecutorId,
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

  const editable = writableExecutorId === result.executorId &&
    ["draft", "returned"].includes(result.status);
  const canReview = !user.preview && result.status === "submitted" && result.canReview;
  const canCheck = hasPermission(user, "workflow.review", ["coordinator", "admin"].includes(user.role));
  const canAudit = hasPermission(user, "audit.read", ["executor", "coordinator", "admin"].includes(user.role));
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
  const executorName = executors.find(({ id }) => id === result.executorId)?.displayName ||
    (result.executorId === user.id ? user.displayName : null);
  return (
    <div className="result-detail">
      <RequestError error={error} onRetry={error?.status === 409 || error?.code === "version_conflict"
        ? () => { setError(null); onChanged(); } : null} />
      <div className="result-workspace">
        <EvidenceArea
          api={api}
          key={result.id}
          disabled={busyOrLoading || dirty}
          editable={editable}
          canCheck={canCheck}
          result={result}
          onUpload={(body) => act("upload", `${path}/evidence`, { method: "POST", body })}
        />
        <section className="result-review-pane">
          <h4>Результат</h4>
          <div className="result-state" role="status">
            <strong className={`result-status result-status-${result.status}`}>{statusText(result)}</strong>
            <span>Версія {result.revision}</span>
          </div>
          {result.submittedAt && (
            <p className="result-submitted">
              Подано <time dateTime={result.submittedAt}>{dateTime(result.submittedAt)}</time>
            </p>
          )}
          {result.status === "returned" && returnedReview && (
            <p className="result-return-note"><strong>Коментар координатора</strong><br />{returnedReview.comment}</p>
          )}
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
            <dl className="result-facts">
              {executorName && <><dt>Виконавець</dt><dd>{executorName}</dd></>}
              <dt>Підсумок</dt><dd>{outcomeLabels[result.outcome] || "Не зазначено"}</dd>
              <dt>Опис</dt><dd className="result-text">{result.description || "Не зазначено"}</dd>
              {result.nonCompletionReason && <><dt>Причина</dt><dd className="result-text">{result.nonCompletionReason}</dd></>}
              <dt>Дата результату</dt><dd>{result.resultDate || "Не зазначено"}</dd>
              {result.measuredValue != null && <><dt>Значення індикатора</dt><dd>{result.measuredValue} {unit}</dd></>}
            </dl>
          )}
          <ResultHistory api={api} canAudit={canAudit} result={result} user={user} />
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
                <textarea value={comment} disabled={busyOrLoading} maxLength={4000}
                  placeholder="Опишіть, що потрібно виправити…"
                  onChange={(event) => setComment(event.target.value)} />
              </label>
              <div className="result-review-actions">
                <button type="button" disabled={busyOrLoading} onClick={() => act("approve", `${path}/review`, json("POST", {
                  decision: "approve", comment, version: result.version,
                }))}>Погодити результат</button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busyOrLoading || !comment.trim()}
                  onClick={() => act("return", `${path}/review`, json("POST", {
                    decision: "return", comment, version: result.version,
                  }))}
                >Повернути на доопрацювання</button>
              </div>
            </div>
          )}
        </section>
      </div>
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

const previewMedia = new Set(["image/png", "image/jpeg", "text/plain"]);
const textPreviewLimit = 32 * 1024;
const evidenceTypes = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "text/plain": "TXT",
};
const sizeFormat = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });

const evidenceDownload = (id) => `/api/evidence/${encodeURIComponent(id)}/download`;

function fileSize(bytes) {
  if (bytes < 1024) return `${sizeFormat.format(bytes)} Б`;
  if (bytes < 1024 ** 2) return `${sizeFormat.format(bytes / 1024)} КіБ`;
  return `${sizeFormat.format(bytes / 1024 ** 2)} МіБ`;
}

function EvidenceIcon({ download = false }) {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {download
        ? <path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4" />
        : <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6" />}
    </svg>
  );
}

function EvidencePreview({ file }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const canPreview = previewMedia.has(file.mediaType);

  useEffect(() => {
    if (!canPreview) return;
    const controller = new AbortController();
    let imageUrl;

    async function load() {
      // The same-origin download route checks access and the stored file digest.
      const response = await fetch(evidenceDownload(file.id), { signal: controller.signal, redirect: "error" });
      if (response.status === 409) throw new Error("Цілісність файлу не підтверджено.");
      if (!response.ok) throw new Error("Не вдалося завантажити файл для перегляду.");
      const mediaType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (mediaType !== file.mediaType) throw new Error("Тип файлу не збігається з даними доказу.");

      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (mediaType === "text/plain") {
        const text = await blob.slice(0, textPreviewLimit).text();
        if (!controller.signal.aborted) setPreview({ text, truncated: blob.size > textPreviewLimit });
      } else {
        imageUrl = URL.createObjectURL(blob);
        setPreview({ imageUrl });
      }
    }

    load().catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [canPreview, file.id, file.mediaType]);

  return (
    <div className="result-preview" aria-label="Перегляд доказу">
      <div className="result-preview-bar">
        <strong>{canPreview ? "Перегляд доказу" : "Документ"}</strong>
        <span>{evidenceTypes[file.mediaType]} · {fileSize(file.byteSize)}</span>
      </div>
      {!canPreview ? (
        <div className="result-preview-message">
          <span className="result-file-symbol"><EvidenceIcon /></span>
          <p>Завантажте файл, щоб переглянути документ.</p>
        </div>
      ) : error ? (
        <p className="result-preview-message" role="status">{error}</p>
      ) : preview?.imageUrl ? (
        <img src={preview.imageUrl} alt={file.originalName}
          onError={() => setError("Не вдалося відобразити зображення.")} />
      ) : preview ? (
        <>
          <pre>{preview.text || "Файл не містить тексту."}</pre>
          {preview.truncated && <p className="result-preview-limit">Повний текст доступний у завантаженому файлі.</p>}
        </>
      ) : <p className="result-preview-message" role="status">Завантажуємо перегляд доказу…</p>}
    </div>
  );
}

function EvidenceArea({ api, canCheck, disabled, editable, onUpload, result }) {
  const [file, setFile] = useState(null);
  const [replacement, setReplacement] = useState("");
  const [previewId, setPreviewId] = useState("");
  const [checked, setChecked] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);
  const current = result.evidence || [];
  const currentIds = new Set(current.map((item) => item.id));
  const older = (result.evidenceHistory || []).filter((item) => !currentIds.has(item.id));
  const previewFile = current.find(({ id }) => id === previewId) ?? current[0];
  const exceedsLimit = file?.size > evidenceLimitMiB * 1024 ** 2;

  async function upload(event) {
    event.preventDefault();
    if (!file || disabled || exceedsLimit) return;
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
      setChecked({ name: item.originalName, revision: item.revision, intact: integrity.intact });
    } catch (cause) {
      setCheckError(cause);
    } finally {
      setChecking(false);
    }
  }

  function evidenceList(files, selectPreview = false) {
    return (
      <ul className="result-evidence-list">
        {files.map((item) => (
          <li key={item.id} className={item.id === previewFile?.id ? "result-evidence-current" : undefined}>
            <div className="result-evidence-file">
              <div className="result-evidence-heading">
                <span className="result-file-symbol"><EvidenceIcon /></span>
                <div>
                  <a href={evidenceDownload(item.id)} download className="result-evidence-link">
                    {item.originalName}
                    <EvidenceIcon download />
                  </a>
                  <p className="result-file-meta">
                    <span>Версія {item.revision}</span>
                    <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
                  </p>
                </div>
              </div>
              <details className="result-digest"><summary>SHA-256</summary><code>{item.sha256}</code></details>
            </div>
            {(selectPreview || canCheck) && (
              <div className="result-evidence-actions">
                {selectPreview && (
                  <button type="button" className="secondary" aria-pressed={previewFile?.id === item.id}
                    onClick={() => setPreviewId(item.id)}>Переглянути</button>
                )}
                {canCheck && (
                  <button type="button" className="secondary" disabled={checking} onClick={() => check(item)}>
                    Перевірити цілісність
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="result-evidence">
      <h4>Докази</h4>
      {previewFile ? (
        <>
          {evidenceList(current, current.length > 1)}
          <EvidencePreview key={previewFile.id} file={previewFile} />
        </>
      ) : <p className="result-evidence-empty">Актуальних файлів немає.</p>}
      {older.length > 0 && <details><summary>Історія версій файлів</summary>{evidenceList(older)}</details>}
      <RequestError error={checkError} />
      {checked && (
        <p role="status" className={checked.intact ? "result-integrity" : "result-integrity result-integrity-failed"}>
          {checked.name} · версія {checked.revision} · {checked.intact ? "Цілісність підтверджено" : "Цілісність не підтверджено"}
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
            <p className="result-muted">PDF, PNG, JPEG або TXT · до {evidenceLimitMiB} МіБ</p>
            {exceedsLimit && <p role="alert">Файл перевищує {evidenceLimitMiB} МіБ.</p>}
            <button className="secondary" disabled={!file || exceedsLimit}>Завантажити доказ</button>
          </fieldset>
        </form>
      )}
    </section>
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
