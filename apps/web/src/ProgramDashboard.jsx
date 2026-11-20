import { useEffect, useState } from "react";
import { halfYears } from "./periods.js";
import "./dashboard.css";

const pageSize = 10;
const pluralRules = new Intl.PluralRules("uk-UA");
const units = {
  measure: { one: "захід", few: "заходи", many: "заходів" },
  period: { one: "період", few: "періоди", many: "періодів" },
  currentPeriod: { one: "поточний період", few: "поточні періоди", many: "поточних періодів" },
  result: { one: "результат", few: "результати", many: "результатів" },
};
const metricLabels = {
  measures: { label: "Активні заходи", unit: units.measure, icon: "clipboard" },
  completed: { label: "Виконано", unit: units.currentPeriod, icon: "check", tone: "positive" },
  overdue: { label: "Прострочені періоди", unit: units.period, icon: "alert", tone: "danger" },
  overdueMeasures: { label: "Прострочені заходи", unit: units.measure, icon: "alert", tone: "danger" },
  dueSoon: { label: "Строк у найближчі 7 днів", unit: units.period, icon: "clock" },
  pendingReview: { label: "На перевірці", unit: units.result, icon: "review" },
};

const roleViews = {
  executor: {
    title: "Мої заходи",
    metrics: ["measures", "dueSoon", "overdue"],
  },
  coordinator: {
    title: "Кабінет підрозділу",
    metrics: ["pendingReview", "overdueMeasures", "dueSoon", "measures"],
  },
  leader: {
    title: "Загальний стан програми",
    metrics: ["measures", "completed", "overdueMeasures", "dueSoon"],
    showProgress: true,
  },
  analyst: {
    title: "Дашборд моніторингу",
    metrics: ["measures", "completed", "overdue", "pendingReview"],
    showProgress: true,
  },
};

const resultStatuses = {
  draft: "Чернетка",
  submitted: "На перевірці",
  returned: "Повернено",
  approved: "Погоджено",
};

const resultOutcomes = {
  completed: "Виконано",
  partial: "Виконано частково",
  not_completed: "Не виконано",
};

const icons = {
  clipboard: "M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M10 3H14a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2Z",
  check: "m5 12 4 4L19 6",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z M12 6v6l4 2",
  alert: "M10.3 4.7a2 2 0 0 1 3.4 0l7.3 12.6a2 2 0 0 1-1.7 3H4.7a2 2 0 0 1-1.7-3Z M12 9v4m0 3h.01",
  review: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M8 13h8 M8 17h6",
  chevron: "m9 6 6 6-6 6",
};

const ruleLabels = {
  overdue: "Прострочення",
  due_soon: "Наближення строку",
  missing_evidence: "Брак підтвердних матеріалів",
  target_not_met: "Цілі індикатора не досягнуто",
  closed_without_improvement: "Індикатор не покращився",
};

const sourceLabels = {
  today: "Дата оцінки",
  deadline: "Строк",
  daysOverdue: "Днів прострочення",
  daysRemaining: "Днів до строку",
  revision: "Версія результату",
  issue: "Стан доказів",
  baseline: "Базове значення",
  target: "Цільове значення",
  actual: "Фактичне значення",
  direction: "Напрям покращення",
};

const sourceValueLabels = {
  direction: { increase: "Збільшення", decrease: "Зменшення", maintain: "Збереження" },
  issue: {
    no_current_evidence: "Немає актуального доказу",
    missing_file: "Файл відсутній",
    integrity_failed: "Цілісність не підтверджено",
  },
};

function formatDate(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return day ? `${day}.${month}.${year}` : value;
}

function periodLabel(key, labels) {
  return key === "once" ? "Одноразовий" : labels.get(key) ?? key;
}

function DashboardIcon({ name, tone }) {
  return (
    <span className="dashboard-icon" data-tone={tone} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
        strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <path d={icons[name]} />
      </svg>
    </span>
  );
}

function queryScope(programId, departmentId) {
  return { programId, ...(departmentId ? { departmentId } : {}), pageSize: String(pageSize) };
}

function useDashboardQuery(api, path) {
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setRequest({ path, attempt, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setRequest((previous) => ({ path, attempt, data: previous?.data, error }));
        }
      });
    return () => controller.abort();
  }, [api, path, attempt]);

  const current = request?.path === path && request.attempt === attempt;
  return {
    data: current && !request.error ? request.data : null,
    previousData: request?.data,
    error: current ? request.error : null,
    loading: !current,
    retry: () => setAttempt((value) => value + 1),
  };
}

function RequestState({ request, label }) {
  if (request.loading) return <p role="status">Завантаження: {label}…</p>;
  if (!request.error) return null;
  return (
    <div>
      <p className="error" role="alert">
        Не вдалося завантажити дані: {request.error.message}
      </p>
      <button type="button" className="secondary" onClick={request.retry}>
        Повторити
      </button>
    </div>
  );
}

function Pagination({ data, label, onPageChange }) {
  if (data.total <= data.pageSize && data.page === 1) return null;
  const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <nav className="dashboard-pagination" aria-label={label}>
      <button type="button" className="secondary" disabled={data.page <= 1}
        onClick={() => onPageChange(data.page - 1)}>
        Попередня
      </button>
      <span>Сторінка {data.page} з {lastPage}</span>
      <button type="button" className="secondary" disabled={data.page >= lastPage}
        onClick={() => onPageChange(data.page + 1)}>
        Наступна
      </button>
    </nav>
  );
}

export function ProgramDashboard({ program, userRole, programContext, departments, api, onOpenMeasure, mode = "overview" }) {
  const [departmentId, setDepartmentId] = useState("");
  const view = roleViews[userRole] ?? roleViews.analyst;
  const title = { signals: "Сигнали", approvals: "Погодження" }[mode] ?? view.title;
  const showDepartment = userRole !== "executor" && departments.length > 0;
  const breakdownDepartments = mode === "overview" && userRole === "leader" && !departmentId
    ? departments : [];
  const scope = queryScope(program.id, departmentId);
  const periods = new Map(
    halfYears(program.periodStart, program.periodEnd).map(({ key, label }) => [key, label]),
  );

  return (
    <section aria-labelledby="dashboard-title" className="program-dashboard">
      <header className="section-heading dashboard-page-heading">
        <div>
          <h1 id="dashboard-title">{title}</h1>
          {programContext}
        </div>
        {showDepartment && (
          <label>
            Підрозділ
            <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="">Усі доступні підрозділи</option>
              {departments.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
            </select>
          </label>
        )}
      </header>
      {mode === "signals" ? (
        <RiskFlags key={departmentId} api={api} scope={scope} periods={periods}
          onOpenMeasure={onOpenMeasure} />
      ) : (
        <DashboardScope key={`${mode}:${departmentId}`} api={api} scope={scope}
          view={view} periods={periods} onlyApprovals={mode === "approvals"}
          showFlags={userRole !== "executor"} breakdownDepartments={breakdownDepartments}
          onOpenMeasure={onOpenMeasure} />
      )}
    </section>
  );
}

function DashboardScope({
  api, scope, view, periods, showFlags, onlyApprovals, breakdownDepartments, onOpenMeasure,
}) {
  const [selection, setSelection] = useState({
    metric: onlyApprovals ? "pendingReview" : view.metrics[0],
    page: 1,
  });
  const query = new URLSearchParams({ ...scope, metric: selection.metric, page: String(selection.page) });
  const request = useDashboardQuery(api, `/dashboard?${query}`);
  const summary = request.previousData;
  const hasFlags = showFlags && !onlyApprovals;
  const hasBreakdown = breakdownDepartments.length > 1;
  const hasProgress = !hasBreakdown && view.showProgress && !onlyApprovals && summary;
  const gridLayout = hasBreakdown ? " dashboard-grid--departments"
    : hasProgress ? " dashboard-grid--progress" : hasFlags ? " dashboard-grid--attention" : "";

  return (
    <>
      {summary && (
        <>
          {!onlyApprovals && (
            <div className="dashboard-metrics" role="group" aria-label="Фільтри огляду">
              {view.metrics.map((key) => {
                const count = summary.counts[key];
                const { label, unit, icon, tone } = metricLabels[key];
                return (
                  <button key={key} type="button" className="dashboard-metric"
                    aria-pressed={selection.metric === key}
                    onClick={() => setSelection({ metric: key, page: 1 })}>
                    <DashboardIcon name={icon} tone={tone} />
                    <span className="dashboard-metric-copy">
                      <span>{label}</span>
                      <strong>{count}</strong>
                      <small>{unit[pluralRules.select(count)] ?? unit.many}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="count dashboard-snapshot">
            Станом на <time dateTime={summary.asOf}>{formatDate(summary.asOf)}</time>
            {" · "}Дати за Києвом
          </p>
        </>
      )}
      <div className={`dashboard-grid${gridLayout}`}>
        {hasBreakdown && (
          <DepartmentProgress api={api} programId={scope.programId} departments={breakdownDepartments} />
        )}
        <DashboardList request={request} selection={selection} onSelect={setSelection}
          periods={periods} onOpenMeasure={onOpenMeasure} />
        {hasProgress && <CompletionProgress summary={summary} />}
        {hasFlags && <RiskFlags api={api} scope={scope} periods={periods} onOpenMeasure={onOpenMeasure} />}
      </div>
    </>
  );
}

function DashboardList({ request, selection, onSelect, periods, onOpenMeasure }) {
  const title = {
    dueSoon: "Найближчі строки",
    pendingReview: "Черга на розгляд",
  }[selection.metric] ?? metricLabels[selection.metric].label;
  return (
    <section className="dashboard-panel dashboard-list-panel" aria-labelledby="dashboard-list-title">
      <div className="dashboard-heading dashboard-panel-heading">
        <h2 id="dashboard-list-title">{title}</h2>
        {request.data && <span className="dashboard-total" role="status">Усього: {request.data.total}</span>}
      </div>
      <div className="dashboard-panel-body">
        <RequestState request={request} label="заходи" />
        {request.data && (
          <>
            {request.data.items.length
              ? <MeasureList items={request.data.items} periods={periods} onOpenMeasure={onOpenMeasure} />
              : <p className="empty">За цим фільтром записів немає.</p>}
            <Pagination data={request.data} label="Сторінки заходів огляду"
              onPageChange={(page) => onSelect({ ...selection, page })} />
          </>
        )}
      </div>
    </section>
  );
}

function CompletionProgress({ summary }) {
  const percent = summary.completionRate === null
    ? null
    : new Intl.NumberFormat("uk-UA", { style: "percent", maximumFractionDigits: 1 }).format(summary.completionRate);

  return (
    <section className="dashboard-panel dashboard-progress" aria-labelledby="dashboard-progress-title">
      <div className="dashboard-heading dashboard-panel-heading">
        <h2 id="dashboard-progress-title">Загальний прогрес</h2>
        <p>Виконання поточних періодів</p>
      </div>
      <div className="dashboard-panel-body">
        {percent === null ? <p className="empty">Немає поточних періодів.</p> : (
          <div className="dashboard-progress-figure" role="meter"
            aria-label="Виконання поточних періодів"
            aria-valuemin={0} aria-valuemax={1} aria-valuenow={summary.completionRate}
            aria-valuetext={`${percent}, ${summary.counts.completed} із ${summary.counts.measures} виконано`}>
            <svg viewBox="0 0 160 160" aria-hidden="true" focusable="false">
              <circle className="dashboard-progress-track" cx="80" cy="80" r="70" />
              {summary.completionRate > 0 && (
                <circle className="dashboard-progress-fill" cx="80" cy="80" r="70"
                  pathLength="100" strokeDasharray={`${summary.completionRate * 100} 100`}
                  transform="rotate(-90 80 80)" />
              )}
            </svg>
            <div className="dashboard-progress-value">
              <strong>{percent}</strong>
              <span>{summary.counts.completed} із {summary.counts.measures} виконано</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function DepartmentProgress({ api, programId, departments }) {
  return (
    <section className="dashboard-panel" aria-labelledby="department-progress-title">
      <div className="dashboard-panel-heading department-progress-heading">
        <h2 id="department-progress-title">Виконання за підрозділами</h2>
        <p>Виконано з усіх поточних періодів</p>
      </div>
      <ul className="department-progress-list" role="list">
        {departments.map((department) => (
          <DepartmentProgressRow key={department.id} api={api} programId={programId} department={department} />
        ))}
      </ul>
    </section>
  );
}

function DepartmentProgressRow({ api, programId, department }) {
  const query = new URLSearchParams({ programId, departmentId: department.id, pageSize: "1" });
  const request = useDashboardQuery(api, `/dashboard?${query}`);
  const counts = request.data?.counts;

  return (
    <li>
      <strong>{department.title}</strong>
      <RequestState request={request} label={department.title} />
      {counts && (counts.measures > 0 ? (
        <div className="department-progress-value">
          <span className="department-progress-track" aria-hidden="true">
            <span style={{ width: `${(counts.completed / counts.measures) * 100}%` }} />
          </span>
          <span>{counts.completed} із {counts.measures}</span>
        </div>
      ) : <p>Немає поточних періодів.</p>)}
    </li>
  );
}

function MeasureList({ items, periods, onOpenMeasure }) {
  return (
    <div className="table-scroll dashboard-table" role="region" aria-label="Заходи огляду" tabIndex={0}>
      <table role="table" aria-labelledby="dashboard-list-title">
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Код і захід</th>
            <th role="columnheader" scope="col">Період</th>
            <th role="columnheader" scope="col">Строк</th>
            <th role="columnheader" scope="col">Результат</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {items.map((item) => (
            <tr key={`${item.measureId}:${item.periodKey}`} role="row">
              <td role="cell">
                <button type="button" className="link" onClick={() => onOpenMeasure(item)}>
                  {item.code} · {item.title}
                </button>
              </td>
              <td role="cell">
                <span className="dashboard-cell-label" aria-hidden="true">Період</span>
                {periodLabel(item.periodKey, periods)}
              </td>
              <td role="cell">
                <span className="dashboard-cell-label" aria-hidden="true">Строк</span>
                <time dateTime={item.deadline ?? undefined}>{formatDate(item.deadline)}</time>
              </td>
              <td role="cell">
                <span className="dashboard-cell-label" aria-hidden="true">Результат</span>
                <span className="dashboard-status" data-status={item.resultStatus}>
                  {resultStatuses[item.resultStatus] || "Ще не подано"}
                </span>
                {item.outcome && resultOutcomes[item.outcome] && (
                  <span className="dashboard-outcome">
                    {item.resultStatus !== "approved" && "Підсумок виконавця: "}
                    {resultOutcomes[item.outcome]}
                  </span>
                )}
                {item.reviewComment && (
                  <p className="result-return-note">Зауваження: {item.reviewComment}</p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskFlags({ api, scope, periods, onOpenMeasure }) {
  const [filter, setFilter] = useState({ ruleCode: "", page: 1 });
  const query = new URLSearchParams({
    ...scope,
    ...(filter.ruleCode ? { ruleCode: filter.ruleCode } : {}),
    page: String(filter.page),
  });
  const request = useDashboardQuery(api, `/risk-flags?${query}`);
  return (
    <section className="dashboard-panel dashboard-flags-panel" aria-labelledby="dashboard-flags-title">
      <div className="dashboard-heading dashboard-panel-heading dashboard-flags-heading">
        <h2 id="dashboard-flags-title">Сигнали ризику</h2>
        <label>
          Правило
          <select value={filter.ruleCode} onChange={(event) => setFilter({ ruleCode: event.target.value, page: 1 })}>
            <option value="">Усі правила</option>
            {Object.entries(ruleLabels).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="dashboard-panel-body">
        <RequestState request={request} label="сигнали ризику" />
        {request.data && (
          <>
            <p className="count dashboard-signal-count" role="status">Сигналів: {request.data.total}</p>
            {request.data.items.length ? (
              <ul className="dashboard-flags" role="list">
                {request.data.items.map((item) => (
                  <RiskFlag key={`${item.measureId}:${item.periodKey}:${item.ruleCode}`}
                    item={item} periods={periods} onOpenMeasure={onOpenMeasure} />
                ))}
              </ul>
            ) : <p className="empty">За цим фільтром сигналів немає.</p>}
            <Pagination data={request.data} label="Сторінки сигналів"
              onPageChange={(page) => setFilter({ ...filter, page })} />
          </>
        )}
      </div>
    </section>
  );
}

function RiskFlag({ item, periods, onOpenMeasure }) {
  const title = ruleLabels[item.ruleCode] || "Сигнал ризику";
  const sourceValues = item.sourceValues ?? {};
  const sources = Object.entries(sourceLabels).filter(([key]) => sourceValues[key] != null);
  return (
    <li>
      <details>
        <summary>
          <DashboardIcon name={item.ruleCode === "due_soon" ? "clock" : "alert"}
            tone={item.ruleCode === "due_soon" ? undefined : "danger"} />
          <span className="dashboard-flag-summary">
            <strong>{title}</strong>
            <span>{item.code} · {item.title}</span>
          </span>
          <DashboardIcon name="chevron" />
        </summary>
        <div className="dashboard-flag-body">
          <p className="count">{periodLabel(item.periodKey, periods)}</p>
          <p>{item.explanation}</p>
          {sources.length > 0 && (
            <dl>
              {sources.map(([key, label]) => (
                <SourceValue key={key} field={key} label={label} value={sourceValues[key]} />
              ))}
            </dl>
          )}
          {item.suggestedAction && (
            <p><strong>Рекомендована дія:</strong> {item.suggestedAction}</p>
          )}
          <button type="button" className="link" onClick={() => onOpenMeasure(item)}>
            {item.code} · {item.title}
          </button>
        </div>
      </details>
    </li>
  );
}

function SourceValue({ field, label, value }) {
  const displayedValue = ["deadline", "today"].includes(field)
    ? formatDate(value)
    : sourceValueLabels[field]?.[value] ?? value;
  return <><dt>{label}</dt><dd>{displayedValue}</dd></>;
}
