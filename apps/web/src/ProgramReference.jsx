import { useEffect, useState } from "react";
import { Glyph } from "./Workspace.jsx";
import "./program-reference.css";

const formatValue = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 6 });
const calendar = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv" });
const formatDate = (date) => date?.split("-").reverse().join(".");
const formatReading = (value, unit) => value == null ? "—" : [formatValue.format(value), unit].filter(Boolean).join(" ");

function useProgramReference(api, path) {
  const [request, setRequest] = useState({ data: null, error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setRequest({ data, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRequest((current) => ({ ...current, error }));
      });
    return () => controller.abort();
  }, [api, path, version]);
  return {
    ...request,
    refresh: () => {
      setRequest((current) => ({ ...current, error: null }));
      setVersion((current) => current + 1);
    },
    update: (data) => setRequest({ data, error: null }),
  };
}

function ReferenceState({ data, error, refresh }) {
  if (!error) return data ? null : <p className="count" role="status">Завантаження…</p>;
  return (
    <div className="reference-error">
      <p className="error" role="alert">{error.message}</p>
      <button className="secondary" type="button" onClick={refresh}>Повторити завантаження</button>
    </div>
  );
}

function SaveForm({ label, className = "", cancel, save, onSave, children }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const fields = new FormData(event.currentTarget);
    setSaving(true);
    setError(null);
    try {
      onSave(await save(fields));
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={`reference-form ${className}`} aria-label={label} onSubmit={submit}>
      <fieldset disabled={saving}>{children}</fieldset>
      {error && <p className="error" role="alert">{error.message}</p>}
      <div className="reference-actions">
        <button disabled={saving}>{saving ? "Збереження…" : "Зберегти"}</button>
        <button className="secondary" type="button" onClick={cancel} disabled={saving}>Скасувати</button>
      </div>
    </form>
  );
}

const passportFields = {
  organization: { label: "Організація", limit: 240 },
  approvalReference: { label: "Реквізити затвердження", limit: 240 },
  nazkApprovalStatus: { label: "Статус погодження НАЗК", limit: 180 },
  notes: { label: "Примітки", limit: 1200 },
};

function PassportForm({ api, path, data, departments, close, update }) {
  function save(fields) {
    const body = Object.fromEntries([...fields].map(([key, value]) => [key, value.trim() || null]));
    body.restrictedInformation = fields.has("restrictedInformation");
    return api(path, { method: "PUT", body: JSON.stringify(body) });
  }
  return (
    <SaveForm label="Редагування паспорта програми" cancel={close} save={save} onSave={update}>
      <label>Мета та цілі програми<textarea name="goals" defaultValue={data.goals} maxLength={4000} required autoFocus /></label>
      <div className="form-grid">
        {Object.entries(passportFields).filter(([name]) => name !== "notes").map(([name, { label, limit }]) => (
          <label key={name}>{label}<input name={name} defaultValue={data[name] ?? ""} maxLength={limit} /></label>
        ))}
        <label>Підрозділ-координатор
          <select name="coordinatorDepartmentId" defaultValue={data.coordinatorDepartmentId ?? ""}>
            <option value="">Не визначено</option>
            {departments.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
          </select>
        </label>
      </div>
      <label>Примітки<textarea name="notes" defaultValue={data.notes ?? ""} maxLength={passportFields.notes.limit} /></label>
      <label className="checkbox"><input type="checkbox" name="restrictedInformation" defaultChecked={data.restrictedInformation} />
        Позначка про інформацію з обмеженим доступом
      </label>
    </SaveForm>
  );
}

function Passport({ api, path, departments }) {
  const request = useProgramReference(api, path);
  const { data } = request;
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <>
      <ReferenceState {...request} />
      {data && (
        <div className="reference-passport">
          <section className="dashboard-panel reference-section" aria-labelledby="program-goals">
            <div className="reference-section-heading">
              <h2 id="program-goals">Мета та цілі програми</h2>
              {data.canEdit && !editing && <button className="secondary" type="button"
                onClick={() => { setNotice(""); setEditing(true); }}>Редагувати паспорт</button>}
            </div>
            <div role="status">{notice && <p className="reference-notice">{notice}</p>}</div>
            {editing ? (
              <PassportForm api={api} path={path} data={data} departments={departments}
                close={() => setEditing(false)} update={(next) => {
                  if (next) request.update(next);
                  else request.refresh();
                  setEditing(false);
                  setNotice("Паспорт програми збережено.");
                }} />
            ) : (
              <p className={data.goals ? "reference-prose" : "count"}>
                {data.goals || "Цілі цієї програми ще не внесено."}
              </p>
            )}
          </section>
          <section className="dashboard-panel reference-section" aria-labelledby="program-details">
            <h2 id="program-details">Відомості про програму</h2>
            <dl className="reference-facts">
              <div><dt>Код програми</dt><dd>{data.code}</dd></div>
              <div><dt>Підрозділ-координатор</dt><dd>{data.coordinatorDepartmentTitle || "Не визначено"}</dd></div>
              {Object.entries(passportFields).map(([name, { label }]) => (
                <div key={name}><dt>{label}</dt><dd>{data[name] || "—"}</dd></div>
              ))}
              <div><dt>Позначка про інформацію з обмеженим доступом</dt><dd>{data.restrictedInformation ? "Так" : "Ні"}</dd></div>
            </dl>
          </section>
          <section className="dashboard-panel reference-section" aria-labelledby="program-sections">
            <h2 id="program-sections">Розділи програми</h2>
            {data.sections.length ? (
              <ul className="reference-sections">
                {data.sections.map(({ id, code, title, measureCount }) => (
                  <li key={id}>
                    <span className="measure-code">{code}</span>
                    <span>{title}</span>
                    <strong><span className="visually-hidden">Заходів: </span>{measureCount}</strong>
                  </li>
                ))}
              </ul>
            ) : <p className="count">У програмі ще немає доступних розділів.</p>}
          </section>
        </div>
      )}
    </>
  );
}

const directions = { increase: "Збільшення", decrease: "Зменшення" };
const levels = { low: "Низький", medium: "Середній", high: "Високий", critical: "Критичний" };

function IndicatorForm({ api, path, risk, departments, close, saved }) {
  const indicator = risk.indicator;
  const hasReadings = risk.readings.length > 0;
  const today = calendar.format(new Date());
  function save(fields) {
    const body = Object.fromEntries(fields);
    if (hasReadings) body.direction = indicator.direction;
    for (const key of ["baseline", "target", "likelihood", "impact"]) {
      body[key] = body[key] === "" ? null : Number(body[key]);
    }
    return api(`${path}/indicator`, { method: "PUT", body: JSON.stringify(body) });
  }
  return (
    <SaveForm label={`Індикатор ${risk.code}`} cancel={close} save={save} onSave={saved}>
      <div className="form-grid">
        <label>Назва індикатора<input name="title" maxLength={240} defaultValue={indicator?.title ?? ""} required autoFocus /></label>
        <label>Одиниця виміру<input name="unit" maxLength={50} defaultValue={indicator?.unit ?? ""} readOnly={hasReadings} required /></label>
        <label>Відповідальний підрозділ
          <select name="ownerDepartmentId" defaultValue={risk.ownerDepartmentId ?? ""} required>
            <option value="" disabled>Оберіть підрозділ</option>
            {departments.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
          </select>
        </label>
        <label>Напрям досягнення цілі
          <select name="direction" defaultValue={indicator?.direction ?? "decrease"} disabled={hasReadings}>
            {Object.entries(directions).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
          </select>
        </label>
        <label>Базове значення<input name="baseline" type="number" step="any" defaultValue={indicator?.baseline ?? ""} readOnly={hasReadings} required /></label>
        <label>Дата базового виміру<input name="baselineDate" type="date" max={today}
          defaultValue={indicator?.baselineDate ?? ""} readOnly={hasReadings} required /></label>
        <label>Цільове значення<input name="target" type="number" step="any" defaultValue={indicator?.target ?? ""} required /></label>
        <label>Строк досягнення цілі<input name="targetDate" type="date" min={hasReadings ? indicator.baselineDate : undefined}
          defaultValue={indicator?.targetDate ?? ""} required /></label>
        <label>Імовірність (1–4)<input name="likelihood" type="number" step="1" min="1" max="4" defaultValue={risk.likelihood ?? ""} /></label>
        <label>Вплив (1–4)<input name="impact" type="number" step="1" min="1" max="4" defaultValue={risk.impact ?? ""} /></label>
      </div>
      {hasReadings && <p className="count">Після першого вимірювання одиницю, напрям і базове значення зафіксовано.</p>}
      <label>Опис ризику<textarea name="description" maxLength={1200} defaultValue={risk.description ?? ""} /></label>
    </SaveForm>
  );
}

function ReadingForm({ api, path, risk, close, saved }) {
  const today = calendar.format(new Date());
  return (
    <SaveForm label={`Вимірювання ${risk.code}`} cancel={close} onSave={saved}
      save={(fields) => api(`${path}/readings`, { method: "POST", body: JSON.stringify({
        readingDate: fields.get("readingDate"),
        value: Number(fields.get("value")),
        source: fields.get("source").trim(),
      }) })}>
      <div className="form-grid">
        <label>Дата вимірювання
          <input name="readingDate" type="date" min={risk.indicator.baselineDate} max={today} defaultValue={today} required />
        </label>
        <label>Значення ({risk.indicator.unit})<input name="value" type="number" step="any" required autoFocus /></label>
      </div>
      <label>Джерело вимірювання<input name="source" maxLength={400} required /></label>
    </SaveForm>
  );
}

function RiskFacts({ risk }) {
  const { indicator, latestReading } = risk;
  if (!indicator) return <p className="count">Індикатор ще не налаштовано.</p>;
  return (
    <>
      <p className="reference-indicator">{indicator.title}</p>
      <dl className="reference-readings">
        <div>
          <dt>Базове значення</dt>
          <dd>{formatReading(indicator.baseline, indicator.unit)}</dd>
          {indicator.baselineDate && <dd className="count">{formatDate(indicator.baselineDate)}</dd>}
        </div>
        <div>
          <dt>Останнє вимірювання</dt>
          <dd>{latestReading ? formatReading(latestReading.value, indicator.unit) : "Ще немає"}</dd>
          {latestReading && <dd className="count">{formatDate(latestReading.readingDate)}</dd>}
        </div>
        <div>
          <dt>Цільове значення</dt>
          <dd>{formatReading(indicator.target, indicator.unit)}</dd>
          {indicator.targetDate && <dd className="count">До {formatDate(indicator.targetDate)}</dd>}
        </div>
      </dl>
    </>
  );
}

function RiskRecord({ risk, api, path, departments, refresh }) {
  const [form, setForm] = useState("");
  const [notice, setNotice] = useState("");
  const { indicator, readings } = risk;
  const orderedReadings = [...readings].sort((left, right) => right.readingDate.localeCompare(left.readingDate));
  function open(type) {
    setForm(type);
    setNotice("");
  }
  function saved(message) {
    setForm("");
    setNotice(message);
    refresh();
  }
  return (
    <article className="reference-risk">
      <div className="reference-section-heading">
        <div>
          <h2>{risk.code} · {risk.title}</h2>
          <p className="count">{risk.ownerDepartmentTitle || "Підрозділ не визначено"}</p>
        </div>
        {risk.level && <span className="reference-level" data-level={risk.level}>
          {levels[risk.level] ?? risk.level} рівень ({formatReading(risk.score)})
        </span>}
      </div>
      {risk.description && <p className="reference-prose">{risk.description}</p>}
      {risk.level && <p className="count">Імовірність {risk.likelihood} · Вплив {risk.impact}</p>}
      <RiskFacts risk={risk} />
      {indicator && (
        <details className="reference-history">
          <summary>Історія вимірювань ({readings.length})<Glyph name="chevron" size={16} /></summary>
          {orderedReadings.length ? (
            <ul>
              {orderedReadings.map(({ id, readingDate, value, source }) => (
                <li key={id}>
                  <time dateTime={readingDate}>{formatDate(readingDate)}</time>
                  <strong>{formatReading(value, indicator.unit)}</strong>
                  <span>{source}</span>
                </li>
              ))}
            </ul>
          ) : <p className="count">Вимірювання ще не внесено.</p>}
        </details>
      )}
      <div role="status">{notice && <p className="reference-notice">{notice}</p>}</div>
      {!form && (risk.canMeasure || risk.canEditIndicator) && (
        <div className="reference-actions">
          {risk.canMeasure && indicator && <button type="button" onClick={() => open("reading")}>Додати вимірювання</button>}
          {risk.canEditIndicator && <button className="secondary" type="button" onClick={() => open("indicator")}>
            {indicator ? "Редагувати індикатор" : "Налаштувати індикатор"}
          </button>}
        </div>
      )}
      {form === "reading" && <ReadingForm api={api} path={path} risk={risk} close={() => setForm("")}
        saved={() => saved("Вимірювання збережено.")} />}
      {form === "indicator" && <IndicatorForm api={api} path={path} risk={risk} departments={departments}
        close={() => setForm("")} saved={() => saved("Індикатор збережено.")} />}
    </article>
  );
}

function CorruptionRisks({ api, path, departments }) {
  const request = useProgramReference(api, path);
  return (
    <>
      <ReferenceState {...request} />
      {request.data?.items.length > 0 && (
        <div className="dashboard-panel reference-risk-list">
          {request.data.items.map((risk) => (
            <RiskRecord key={risk.id} risk={risk} api={api} path={`${path}/${risk.id}`}
              departments={departments} refresh={request.refresh} />
          ))}
        </div>
      )}
      {request.data?.items.length === 0 && <p className="empty">Для цієї програми немає доступних корупційних ризиків.</p>}
    </>
  );
}

export function ProgramReference({ view, program, programContext, departments, api }) {
  const passport = view === "passport";
  const path = `/programs/${program.id}/${passport ? "passport" : "corruption-risks"}`;
  return (
    <section aria-labelledby="reference-title" className="program-reference">
      <header className="section-heading">
        <div>
          <h1 id="reference-title">{passport ? "Паспорт програми" : "Корупційні ризики"}</h1>
          {programContext}
        </div>
      </header>
      {passport
        ? <Passport key={path} api={api} path={path} departments={departments} />
        : <CorruptionRisks key={path} api={api} path={path} departments={departments} />}
    </section>
  );
}
