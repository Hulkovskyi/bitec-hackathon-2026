import { useEffect, useState } from "react";
import { halfYears, kyivToday } from "./periods.js";
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

const officialRuleLabels = {
  RF1: "Прострочення",
  RF2: "Брак підтвердних матеріалів",
  RF3: "Ризик майже не змінився",
  RF4: "Опис дублює зміст заходу",
  RF5: "Цілі індикатора не досягнуто",
  RF6: "Повторні порушення строків",
  RF7a: "Фактична дата поза періодом",
  RF7b: "Докази датовано після виконання",
  RF7c: "Бракує пояснення невиконання",
  RF7d: "Високий ризик без заходів впливу",
  RF7e: "Опис заповнено до настання строку",
};

const flagSources = { live: "Поточний моніторинг", official: "Зріз організаторів" };

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
  periodEnd: "Кінець звітного періоду",
  sourceAsOf: "Дата архівного зрізу",
  status: "Стан у джерелі",
  evidenceCount: "Кількість підтверджень",
  riskCode: "Код ризику",
  unit: "Одиниця виміру",
  readingDate: "Дата вимірювання",
  progressPercent: "Прогрес до цілі, %",
  thresholdPercent: "Поріг, %",
  similarityPercent: "Подібність опису, %",
  hasNumber: "Указано число",
  hasLink: "Є посилання",
  deadlineChangeCount: "Кількість перенесень строку",
  overdueCount: "Кількість прострочених заходів",
  overdueCodes: "Коди прострочених заходів",
  actualDate: "Фактична дата виконання",
  firstEvidenceDate: "Дата першого підтвердження",
  descriptionPresent: "Є опис результату",
  riskScore: "Бал ризику",
  riskLevel: "Рівень ризику",
  linkedMeasureCount: "Кількість заходів впливу",
  riskDataSource: "Джерело даних ризику",
  indicatorDataSource: "Джерело напряму індикатора",
};

const sourceValueLabels = {
  status: {
    vykonano: "Виконано", chastkovo: "Виконано частково", ne_vykonano: "Не виконано",
    v_roboti: "У роботі", ne_rozpochato: "Не розпочато",
  },
  riskLevel: { low: "Низький", medium: "Середній", high: "Високий", critical: "Критичний" },
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

export function ProgramDashboard({
  program, userRole, programContext, departments, api, onOpenMeasure, onOpenSubject, canOpenRisk, mode = "overview",
  initialDepartmentId = "",
}) {
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [flagFilter, setFlagFilter] = useState({ source: "live", ruleCode: "" });
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
            <span id="dashboard-department-label">Підрозділ</span>
            <select aria-labelledby="dashboard-department-label" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="">Усі доступні підрозділи</option>
              {departments.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
            </select>
          </label>
        )}
      </header>
      {mode === "signals" ? (
        <RiskFlags key={departmentId} api={api} scope={scope} periods={periods}
          onOpenSubject={onOpenSubject} canOpenRisk={canOpenRisk} onOpenMeasure={onOpenMeasure} showDecisions
          filter={flagFilter} onFilterChange={setFlagFilter} />
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

function RiskFlags(props) {
  if (!props.showDecisions) return <RiskFlagList {...props} />;
  return <RiskDecisions {...props} />;
}

function RiskFlagList({
  api, scope, periods, onOpenMeasure, onOpenSubject, canOpenRisk, showDecisions = false, renderDecision,
  filter: sharedFilter, onFilterChange,
}) {
  const [localFilter, setLocalFilter] = useState({ source: "live", ruleCode: "" });
  const [page, setPage] = useState(1);
  const filter = sharedFilter ?? localFilter;
  function updateFilter(next) {
    (onFilterChange ?? setLocalFilter)(next);
    setPage(1);
  }
  const query = new URLSearchParams({
    ...scope,
    ...(filter.source === "official" ? { source: "official" } : {}),
    ...(filter.ruleCode ? { ruleCode: filter.ruleCode } : {}),
    page: String(page),
  });
  const request = useDashboardQuery(api, `/risk-flags?${query}`);
  const labels = filter.source === "official" ? officialRuleLabels : ruleLabels;
  return (
    <>
      <section className="dashboard-panel dashboard-flags-panel" aria-labelledby="dashboard-flags-title">
        <div className="dashboard-heading dashboard-panel-heading dashboard-flags-heading">
          <h2 id="dashboard-flags-title">Сигнали ризику</h2>
          {showDecisions && (
            <label>
              <span id="dashboard-flag-source-label">Джерело</span>
              <select aria-labelledby="dashboard-flag-source-label" value={filter.source} onChange={(event) => {
                updateFilter({ source: event.target.value, ruleCode: "" });
              }}>
                {Object.entries(flagSources).map(([source, label]) => <option key={source} value={source}>{label}</option>)}
              </select>
            </label>
          )}
          <label>
            <span id="dashboard-flag-rule-label">Правило</span>
            <select aria-labelledby="dashboard-flag-rule-label" value={filter.ruleCode} onChange={(event) => updateFilter({ ...filter, ruleCode: event.target.value })}>
              <option value="">Усі правила</option>
              {Object.entries(labels).map(([code, label]) => (
                <option key={code} value={code}>{filter.source === "official" ? `${code} · ` : ""}{label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="dashboard-panel-body">
          <RequestState request={request} label="сигнали ризику" />
          {request.data && (
            <>
              {request.data.archive && <p className="count">
                {periodLabel(request.data.archive.periodKey, periods)} · станом на {formatDate(request.data.archive.asOf)}
              </p>}
              <p className="count dashboard-signal-count" role="status">Сигналів: {request.data.total}</p>
              {request.data.items.length ? (
                <ul className="dashboard-flags" role="list">
                  {request.data.items.map((item) => (
                    <RiskFlag key={decisionKey(filter.source, item)}
                      item={item} source={filter.source} periods={periods} onOpenMeasure={onOpenMeasure}
                      onOpenSubject={onOpenSubject} canOpenRisk={canOpenRisk}>
                      {renderDecision?.(filter.source, item)}
                    </RiskFlag>
                  ))}
                </ul>
              ) : <p className="empty">{request.data.archive === null
                ? "Для цієї програми немає архівного зрізу."
                : "За цим фільтром сигналів немає."}</p>}
              <Pagination data={request.data} label="Сторінки сигналів"
                onPageChange={setPage} />
            </>
          )}
        </div>
      </section>
    </>
  );
}

function decisionKey(source, item) {
  return [source, item.subjectType ?? "measure", item.subjectId ?? item.measureId, item.periodKey, item.ruleCode].join(":");
}

function RiskDecisions(props) {
  const { api, scope, periods } = props;
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ ...scope, page: String(page) });
  const request = useDashboardQuery(api, `/risk-flag-decisions?${query}`);
  const data = request.data ?? request.previousData;
  const decisions = new Map((data?.items ?? []).map((item) => [decisionKey(item.source, item), item]));

  return (
    <>
      <RiskFlagList {...props} renderDecision={(source, item) => {
        const recorded = decisions.get(decisionKey(source, item));
        if (!data?.canDecide && !recorded) return null;
        const key = {
          programId: scope.programId, source, ruleCode: item.ruleCode,
          subjectType: item.subjectType ?? "measure", subjectId: item.subjectId ?? item.measureId,
          periodKey: item.periodKey,
        };
        return <FlagDecisionEditor api={api} signalKey={key} suggestion={item.suggestedAction}
          canDecide={Boolean(data?.canDecide)} recorded={recorded} onSave={() => {
            setNotice("Рішення зафіксовано.");
            setPage(1);
            request.retry();
          }} />;
      }} />
      <section className="dashboard-panel dashboard-decisions" aria-labelledby="dashboard-decisions-title">
        <h2 id="dashboard-decisions-title">Управлінські рішення</h2>
        {notice && <p className="access-notice" role="status">{notice}</p>}
        <RequestState request={request} label="управлінські рішення" />
        {request.data && (request.data.items.length > 0 ? (
          <ul className="dashboard-decision-list">
            {request.data.items.map((item) => (
              <li key={item.id}>
                <h3>{item.signal.code} · {item.signal.title}</h3>
                <p className="count">{flagSources[item.source]} · {periodLabel(item.periodKey, periods)}</p>
                <DecisionDetails item={item} />
              </li>
            ))}
          </ul>
        ) : <p className="empty">У цьому поданні ще немає зафіксованих рішень.</p>)}
        {request.data?.pageSize && <Pagination data={request.data} label="Сторінки рішень" onPageChange={setPage} />}
      </section>
    </>
  );
}

function DecisionDetails({ item }) {
  return (
    <dl className="dashboard-decision-details">
      <dt>Дія</dt><dd>{item.action}</dd>
      <dt>Відповідальний</dt><dd>{item.assigneeName}</dd>
      <dt>Строк</dt><dd><time dateTime={item.dueDate}>{formatDate(item.dueDate)}</time></dd>
      <dt>Зафіксував</dt><dd>{item.deciderName}</dd>
    </dl>
  );
}

function FlagDecisionEditor({ api, signalKey, suggestion, canDecide, recorded, onSave }) {
  const [editor, setEditor] = useState(null);
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const decision = record ?? recorded;

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const data = await api(`/risk-flag-decisions/assignees?${new URLSearchParams(signalKey)}`);
      setEditor(data);
      if (data.decision) setRecord(data.decision);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    setError(null);
    setBusy(true);
    try {
      const saved = await api("/risk-flag-decisions", {
        method: "PUT",
        body: JSON.stringify({
          ...signalKey, ...payload, version: editor.decision?.version ?? 0, signalVersion: editor.signalVersion,
        }),
      });
      setRecord(saved);
      setEditor(null);
      onSave();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard-flag-decision">
      {decision && !editor && <DecisionDetails item={decision} />}
      {!editor && canDecide && (
        <button type="button" className="secondary" disabled={busy} onClick={open}>
          {busy ? "Завантаження…" : decision ? "Змінити рішення" : "Зафіксувати рішення"}
        </button>
      )}
      {editor && (
        <form onSubmit={save}>
          <fieldset disabled={busy}>
            <label>
              Управлінська дія
              <textarea name="action" required maxLength={2000} rows={3} autoFocus
                defaultValue={editor.decision?.action ?? suggestion ?? ""} />
            </label>
            <div className="form-grid">
              <label>
                Відповідальний
                <select name="assigneeId" required defaultValue={editor.decision?.assigneeId ?? ""}>
                  <option value="">Оберіть відповідального</option>
                  {editor.items.map(({ id, displayName }) => <option key={id} value={id}>{displayName}</option>)}
                </select>
              </label>
              <label>
                Строк виконання
                <input name="dueDate" type="date" required min={kyivToday()}
                  defaultValue={editor.decision?.dueDate ?? ""} />
              </label>
            </div>
          </fieldset>
          <div className="actions">
            <button disabled={busy || !editor.items.length}>{busy ? "Зберігаємо…" : "Зберегти рішення"}</button>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => { setEditor(null); setError(null); }}>Скасувати</button>
          </div>
          {!editor.items.length && <p className="count">У цьому підрозділі немає активних відповідальних користувачів.</p>}
        </form>
      )}
      {error && <p className="error" role="alert">{error.message}</p>}
    </div>
  );
}

function RiskFlag({ item, source, periods, onOpenMeasure, onOpenSubject, canOpenRisk, children }) {
  const title = source === "official"
    ? `${item.ruleCode} · ${officialRuleLabels[item.ruleCode]}`
    : ruleLabels[item.ruleCode] ?? item.ruleCode;
  const sourceValues = item.sourceValues ?? {};
  const sources = Object.entries(sourceLabels).filter(([key]) => sourceValues[key] != null);
  const subject = { type: item.subjectType ?? "measure", id: item.subjectId ?? item.measureId };
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
          {item.measureId ? (
            <button type="button" className="link" onClick={() => onOpenMeasure({ ...item, source })}>
              Відкрити захід {item.code}
            </button>
          ) : onOpenSubject && (subject.type !== "risk" || canOpenRisk) && (
            <button type="button" className="link" onClick={() => onOpenSubject(subject)}>
              {subject.type === "risk" ? "Відкрити ризик" : "Відкрити огляд підрозділу"} {item.code}
            </button>
          )}
          {children}
        </div>
      </details>
    </li>
  );
}

function SourceValue({ field, label, value }) {
  const displayedValue = typeof value === "boolean" ? (value ? "Так" : "Ні")
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value)
      : sourceValueLabels[field]?.[value] ?? String(value);
  return <><dt>{label}</dt><dd>{displayedValue}</dd></>;
}
