import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HalfYearReport } from "./HalfYearReport.jsx";
import { ProgramDashboard } from "./ProgramDashboard.jsx";
import { ResultPanel } from "./ResultPanel.jsx";
import { halfYears } from "./periods.js";
import { Glyph, SignIn, Workspace } from "./Workspace.jsx";
import "./styles.css";

const roleNames = {
  executor: "Виконавець",
  coordinator: "Координатор",
  leader: "Керівник",
  analyst: "Аналітик",
  admin: "Адміністратор",
};
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(
      data?.error?.message || "Не вдалося виконати запит",
    );
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}
function ErrorMessage({ error }) {
  return error ? (
    <p className="error" role="alert">
      {error.message || error}
    </p>
  ) : null;
}
function App() {
  const [users, setUsers] = useState([]),
    [user, setUser] = useState(null),
    [choice, setChoice] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api("/demo/users", { signal: controller.signal }),
      api("/me", { signal: controller.signal }).catch((e) => {
        if (e.code === "unauthenticated") return null;
        throw e;
      }),
    ])
      .then(([result, current]) => {
        setUsers(result.items);
        setChoice(current?.id || result.items[0]?.id || "");
        setUser(current);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e.code === "not_found"
              ? "Деморежим вимкнено. Запустіть сервер з DEMO_MODE=true."
              : e,
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  async function login(event) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setUser(null);
    try {
      await api("/demo/session", {
        method: "POST",
        body: JSON.stringify({ userId: choice }),
      });
      setUser(await api("/me"));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  async function logout() {
    setLoading(true);
    setError(null);
    try {
      await api("/session", { method: "DELETE" });
      setUser(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  const sessionForm = (
    <form className="session-form" onSubmit={login}>
      <label>
        Демокористувач
        <select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={loading || !users.length}>
          {users.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName} · {roleNames[entry.role]}
            </option>
          ))}
        </select>
      </label>
      <button disabled={loading || !choice}>{user ? "Змінити користувача" : "Увійти"}</button>
    </form>
  );
  const errorMessage = <ErrorMessage error={error} />;
  return user ? (
    <Registry key={user.id} user={user} sessionForm={sessionForm} logout={logout} busy={loading} sessionError={errorMessage} />
  ) : <SignIn sessionForm={sessionForm} loading={loading} error={errorMessage} />;
}
function Registry({ user, sessionForm, logout, busy, sessionError }) {
  const [programs, setPrograms] = useState([]),
    [programId, setProgramId] = useState(""),
    [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/programs", { signal: controller.signal })
      .then((r) => {
        setPrograms(r.items);
        setProgramId(r.items[0]?.id || "");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, []);
  const programPicker = (
    <label className="program-select">
      <span>Програма</span>
      <select value={programId} onChange={(event) => setProgramId(event.target.value)} disabled={!programs.length}>
        {programs.map((program) => (
          <option key={program.id} value={program.id}>{program.title}</option>
        ))}
      </select>
    </label>
  );
  const shell = { user, role: roleNames[user.role], sessionForm, logout, busy, programPicker };
  const program = programs.find(({ id }) => id === programId);
  return program ? (
    <Program key={program.id} program={program} user={user} shell={shell} sessionError={sessionError} />
  ) : (
    <Workspace {...shell}>
      {sessionError}
      <ErrorMessage error={error} />
      {!error && <p role="status">Програм немає або вони завантажуються.</p>}
    </Workspace>
  );
}

const registryPageSize = 20;
const lastRegistryPage = (total) => Math.max(1, Math.ceil(total / registryPageSize));

function formatRegistryDate(value) {
  if (!value) return "—";
  return value.split("-").reverse().join(".");
}

// Search uses the same server-filtered list and loads its pages only when needed.
async function registryPage(query, searching, signal) {
  const parameters = new URLSearchParams(query);
  if (!searching) return api("/measures?" + parameters, { signal });
  parameters.set("page", "1");
  parameters.set("pageSize", "100");
  const first = await api("/measures?" + parameters, { signal });
  const items = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / first.pageSize); page += 1) {
    parameters.set("page", String(page));
    const response = await api("/measures?" + parameters, { signal });
    items.push(...response.items);
  }
  return { ...first, items };
}

function Program({ program, user, shell, sessionError }) {
  const [view, setView] = useState(user.role === "admin" ? "registry" : "dashboard");
  const [options, setOptions] = useState(null),
    [result, setResult] = useState(null),
    [error, setError] = useState(null);
  const [page, setPage] = useState(1),
    [section, setSection] = useState(""),
    [active, setActive] = useState(""),
    [search, setSearch] = useState(""),
    [periodKey, setPeriodKey] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null),
    [editing, setEditing] = useState(false),
    [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(null);
  const detailView = useRef(0);
  const detailHeading = useRef(null);
  const focusOnDetail = useRef(false);
  const searchTerm = search.trim().toLocaleLowerCase("uk");
  const searching = Boolean(searchTerm);
  const serverPage = searching ? 1 : page;
  useEffect(() => () => {
    detailView.current += 1;
    detailRequest.current?.abort();
  }, []);
  useEffect(() => {
    if (!selected || !focusOnDetail.current || !detailHeading.current) return;
    focusOnDetail.current = false;
    detailHeading.current.focus();
  }, [selected]);
  const reflectPlanLock = useCallback((id, planFrozen) => {
    setSelected((current) => current?.id === id && current.planFrozen !== planFrozen
      ? { ...current, planFrozen }
      : current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      programId: program.id,
      page: String(serverPage),
      pageSize: String(registryPageSize),
      ...(section ? { sectionId: section } : {}),
      ...(active ? { active } : {}),
      ...(periodKey ? { periodKey } : {}),
    });
    Promise.all([
      api(`/programs/${program.id}/registry-options`, {
        signal: controller.signal,
      }),
      registryPage(query, searching, controller.signal),
    ])
      .then(([o, r]) => {
        if (controller.signal.aborted) return;
        setOptions(o);
        const lastPage = lastRegistryPage(r.total);
        if (!searching && serverPage > lastPage) {
          // A save can remove the only row on the current server page.
          setResult(null);
          setPage(lastPage);
          return;
        }
        setResult(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [program.id, serverPage, section, active, periodKey, refresh, searching]);
  function clearDetail() {
    detailView.current += 1;
    detailRequest.current?.abort();
    detailRequest.current = null;
    focusOnDetail.current = false;
    setDetailLoading(false);
    setSelected(null);
    setEditing(false);
  }
  function changePage(offset) {
    clearDetail();
    if (!searching) setResult(null);
    setPage((p) => p + offset);
  }
  async function open(id, {
    requestedPeriod = periodKey,
    focusHeading = false,
    sourceResultId = null,
  } = {}) {
    clearDetail();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetailLoading(true);
    setError(null);
    try {
      const query = requestedPeriod
        ? `?${new URLSearchParams({ periodKey: requestedPeriod })}` : "";
      const measure = await api("/measures/" + id + query, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        focusOnDetail.current = focusHeading;
        setSelected({ ...measure, sourceResultId });
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e);
    } finally {
      if (!controller.signal.aborted) {
        detailRequest.current = null;
        setDetailLoading(false);
      }
    }
  }
  function openDashboardMeasure({ measureId, periodKey: requestedPeriod, resultId }) {
    if (view === "approvals") {
      setView("review");
      open(measureId, { requestedPeriod, focusHeading: true, sourceResultId: resultId });
      return;
    }
    setView("registry");
    if (section || active || searching || page !== 1 || periodKey !== requestedPeriod) {
      setResult(null);
      setSection("");
      setActive("");
      setSearch("");
      setPage(1);
      setPeriodKey(requestedPeriod);
    }
    open(measureId, { requestedPeriod, focusHeading: true, sourceResultId: resultId });
  }
  function beginSave() {
    const originView = detailView.current;
    return (value) => {
      // The write still changes the registry after its form has been left.
      setRefresh((n) => n + 1);
      if (detailView.current !== originView) return;

      const compatiblePeriod = value.scheduleType === "one_time"
        ? periodKey === "once"
        : halfYears(value.effectiveFrom, program.periodEnd).some(({ key }) => key === periodKey);
      if (periodKey && compatiblePeriod) {
        open(value.id);
      } else {
        if (periodKey) {
          setPeriodKey("");
          setPage(1);
          setResult(null);
        }
        setSelected(value);
        setEditing(false);
      }
    };
  }
  function closeForm() {
    detailView.current += 1;
    setEditing(false);
  }
  function navigate(next) {
    if (next === view) return;
    clearDetail();
    setView(next);
  }
  function resetList() {
    clearDetail();
    setResult(null);
    setPage(1);
  }
  const resultAnchor = useRef(null);
  const matches = searching && result
    ? result.items.filter((item) => `${item.code} ${item.title}`.toLocaleLowerCase("uk").includes(searchTerm))
    : null;
  const total = matches?.length ?? result?.total ?? 0;
  const lastPage = lastRegistryPage(total);
  const visiblePage = matches ? Math.min(page, lastPage) : page;
  useEffect(() => {
    if (page !== visiblePage) setPage(visiblePage);
  }, [page, visiblePage]);
  const rows = matches
    ? matches.slice((visiblePage - 1) * registryPageSize, visiblePage * registryPageSize)
    : result?.items ?? [];
  const viewMode = view === "dashboard" ? "overview" : view;
  const programContext = (
    <p>{program.title} <span aria-hidden="true">·</span> {formatRegistryDate(program.periodStart)} — {formatRegistryDate(program.periodEnd)}</p>
  );
  const resultPanel = selected && (
    <ResultPanel key={`${selected.id}:${selected.periodKey ?? periodKey}:${selected.sourceResultId ?? ""}`}
      measure={selected} sourceResultId={selected.sourceResultId} program={program} user={user} options={options} api={api} onPlanLockChange={reflectPlanLock} />
  );

  if (view === "review") {
    return (
      <Workspace {...shell} activeView="approvals" onNavigate={navigate}>
        {sessionError}
        <header className="section-heading">
          <div>
            <h1 ref={detailHeading} tabIndex={-1}>
              {selected ? `${selected.code} · ${selected.title}` : "Погодження результату"}
            </h1>
            {programContext}
          </div>
          <button className="secondary" type="button" onClick={() => navigate("approvals")}>
            До черги погодження
          </button>
        </header>
        <ErrorMessage error={error} />
        {detailLoading && <p className="count" role="status">Завантаження результату…</p>}
        {resultPanel}
      </Workspace>
    );
  }

  return (
    <Workspace {...shell} activeView={view} onNavigate={navigate}>
      {sessionError}
      {view === "registry" && <header className="section-heading">
        <div>
          <h1>Реєстр заходів</h1>
          {programContext}
        </div>
        {user.role === "coordinator" && options && (
          <button type="button" className="with-icon" onClick={() => {
            clearDetail();
            setEditing(true);
          }}>
            <Glyph name="plus" size={18} /> Додати захід
          </button>
        )}
      </header>}
      {view === "report" ? (
        <HalfYearReport program={program} api={api} onOpenMeasure={openDashboardMeasure} />
      ) : view !== "registry" ? (
        <ProgramDashboard key={viewMode} mode={viewMode} program={program} userRole={user.role}
          programContext={programContext} departments={options?.departments ?? []}
          api={api} onOpenMeasure={openDashboardMeasure} />
      ) : (
        <>
          <div className={selected && !editing ? "register-grid register-grid-split" : "register-grid"}>
            <section className="register-list" aria-label="Перелік заходів">
              <div className="registry-filters">
                <label className="registry-search">
                  <span>Пошук заходів</span>
                  <span className="search-field">
                    <Glyph name="search" size={17} />
                    <input type="search" placeholder="Код або назва" value={search}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (Boolean(next.trim()) !== searching) setResult(null);
                        clearDetail();
                        setSearch(next);
                        setPage(1);
                      }} />
                  </span>
                </label>
                <label>
                  Розділ
                  <select value={section} onChange={(event) => {
                    resetList();
                    setSection(event.target.value);
                  }}>
                    <option value="">Усі розділи</option>
                    {options?.sections.map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.code}. {entry.title}</option>
                    ))}
                  </select>
                </label>
                <label className="registry-period">
                  Період реєстру
                  <select value={periodKey} onChange={(event) => {
                    resetList();
                    setPeriodKey(event.target.value);
                  }}>
                    <option value="">Поточний перегляд</option>
                    <option value="once">Одноразові заходи</option>
                    {halfYears(program.periodStart, program.periodEnd).map(({ key, label }) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Стан запису
                  <select value={active} onChange={(event) => {
                    resetList();
                    setActive(event.target.value);
                  }}>
                    <option value="">Усі стани</option>
                    <option value="true">Активні</option>
                    <option value="false">Неактивні</option>
                  </select>
                </label>
              </div>
              <div className="register-content">
                <ErrorMessage error={error} />
                {error && (
                  <button className="secondary" type="button" onClick={() => setRefresh((value) => value + 1)}>
                    Повторити завантаження
                  </button>
                )}
                {loading && <p className="count" role="status">Завантаження реєстру…</p>}
                {result && (
                  <>
                    <p className="register-count" role="status">Доступних заходів: {total}</p>
                    {rows.length > 0 ? (
                      <RegistryTable items={rows} selectedId={selected?.id} departments={options?.departments}
                        disabled={detailLoading} onOpen={(id) => open(id, { focusHeading: true })} />
                    ) : (
                      <p className="empty">{searching
                        ? "За цим запитом заходів немає."
                        : "За вибраними фільтрами немає доступних заходів."}</p>
                    )}
                    {lastPage > 1 && (
                      <nav className="register-pagination" aria-label="Сторінки реєстру">
                        <button className="secondary" type="button" disabled={visiblePage === 1 || loading}
                          onClick={() => changePage(-1)}>Попередня</button>
                        <span>Сторінка {visiblePage}</span>
                        <button className="secondary" type="button" disabled={visiblePage >= lastPage || loading}
                          onClick={() => changePage(1)}>Наступна</button>
                      </nav>
                    )}
                  </>
                )}
                {detailLoading && <p className="count" role="status">Завантаження картки…</p>}
              </div>
            </section>
            {selected && !editing && (
              <article className="registry-inspector" aria-label="Картка заходу">
                <header className="registry-inspector-header">
                  <div>
                    <span className="measure-code">{selected.code}</span>
                    <h2 ref={detailHeading} tabIndex={-1} aria-label={`${selected.code} · ${selected.title}`}>{selected.title}</h2>
                  </div>
                  <button className="secondary icon-button" type="button" aria-label="Закрити картку"
                    onClick={() => {
                      const id = selected.id;
                      clearDetail();
                      requestAnimationFrame(() => document.getElementById("measure-" + id)?.focus());
                    }}>
                    <Glyph name="close" size={17} />
                  </button>
                </header>
                <p className="inspector-status"><ActivePill active={selected.active} /></p>
                {selected.description && <p className="inspector-description">{selected.description}</p>}
                <dl className="inspector-facts">
                  <dt>Підрозділ</dt>
                  <dd>{options?.departments.find((entry) => entry.id === selected.departmentId)?.title || "—"}</dd>
                  <dt>Початок дії</dt>
                  <dd>{formatRegistryDate(selected.effectiveFrom)}</dd>
                  <dt>Строк</dt>
                  <dd>{selected.scheduleType === "continuous" ? "Постійно" : formatRegistryDate(selected.plannedDate)}</dd>
                  <dt>Індикатор</dt>
                  <dd>{selected.indicator.title}: {selected.indicator.baseline} → {selected.indicator.target} {selected.indicator.unit}</dd>
                  <dt>Ризик</dt>
                  <dd>{options?.risks.find((entry) => entry.id === selected.riskId)?.title || "Не застосовується"}</dd>
                  <dt>Версія запису</dt>
                  <dd>{selected.version}</dd>
                </dl>
                <div className="inspector-actions">
                  <button className="secondary with-icon" type="button"
                    onClick={() => resultAnchor.current?.focus()}>
                    До результату <Glyph name="arrow" size={17} />
                  </button>
                  {user.role === "coordinator" && (
                    selected.planFrozen ? <p className="count">План зафіксовано після подання результату.</p>
                      : <button className="link" type="button" onClick={() => setEditing(true)}>Редагувати захід</button>
                  )}
                </div>
              </article>
            )}
          </div>
          {selected && !editing && (
            <div ref={resultAnchor} tabIndex={-1} className="registry-result">
              {resultPanel}
            </div>
          )}
          {editing && options && (
            <MeasureForm key={selected?.id || "new"} original={selected} options={options} program={program}
              onSaveStart={beginSave} onCancel={closeForm} onReload={() => open(selected.id)} />
          )}
        </>
      )}
    </Workspace>
  );
}

function ActivePill({ active }) {
  return <span className={active ? "active-pill" : "active-pill inactive-pill"}>{active ? "Активний" : "Неактивний"}</span>;
}

function RegistryTable({ items, selectedId, departments = [], disabled, onOpen }) {
  return (
    <div className="table-scroll registry-table" tabIndex={0} role="region" aria-label="Заходи реєстру">
      <table role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">Захід</th>
            <th scope="col" role="columnheader">Строк</th>
            <th scope="col" role="columnheader">Стан</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {items.map((item) => (
            <tr key={item.id} role="row" data-selected={item.id === selectedId}>
              <td role="cell">
                <button className="link measure-link" id={"measure-" + item.id} type="button" disabled={disabled}
                  aria-current={item.id === selectedId ? "true" : undefined}
                  onClick={() => onOpen(item.id)}>
                  <span className="measure-code">{item.code}</span> · {item.title}
                </button>
                <span className="registry-department">
                  {departments.find((entry) => entry.id === item.departmentId)?.title}
                </span>
              </td>
              <td role="cell">
                <span className="registry-cell-label" aria-hidden="true">Строк</span>
                {item.scheduleType === "continuous" ? "Постійно" : formatRegistryDate(item.plannedDate)}
              </td>
              <td role="cell">
                <span className="registry-cell-label" aria-hidden="true">Стан</span>
                <ActivePill active={item.active} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MeasureForm({
  original,
  options,
  program,
  onSaveStart,
  onCancel,
  onReload,
}) {
  const firstDepartment = options.departments[0]?.id || "";
  const [value, setValue] = useState(() =>
    original
      ? {
          ...original,
          executorId: original.baseExecutorId ?? original.executorId,
          indicator: { ...original.indicator },
        }
      : {
          sectionId: options.sections[0]?.id || "",
          departmentId: firstDepartment,
          executorId:
            options.executors.find((e) =>
              e.departmentIds.includes(firstDepartment),
            )?.id || "",
          riskId: null,
          code: "",
          title: "",
          description: "",
          scheduleType: "one_time",
          plannedDate: program.periodEnd,
          active: true,
          indicator: {
            title: "",
            unit: "%",
            baseline: 0,
            target: 100,
            direction: "increase",
          },
        },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const change = (key, v) => setValue((old) => ({ ...old, [key]: v }));
  const indicator = (key, v) =>
    setValue((old) => ({ ...old, indicator: { ...old.indicator, [key]: v } }));
  const riskRequired =
    options.sections.find((s) => s.id === value.sectionId)?.code === 2;
  async function submit(event) {
    event.preventDefault();
    const finishSave = onSaveStart();
    setBusy(true);
    setError(null);
    const body = Object.fromEntries(
      [
        "sectionId",
        "departmentId",
        "executorId",
        "riskId",
        "code",
        "title",
        "description",
        "scheduleType",
        "plannedDate",
      ].map((key) => [key, value[key]]),
    );
    body.indicator = Object.fromEntries(
      ["title", "unit", "direction"].map((key) => [key, value.indicator[key]]),
    );
    body.indicator.baseline = Number(value.indicator.baseline);
    body.indicator.target = Number(value.indicator.target);
    if (original) {
      body.version = original.version;
      body.active = value.active;
    }
    try {
      finishSave(
        await api("/measures" + (original ? "/" + original.id : ""), {
          method: original ? "PATCH" : "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>{original ? "Редагування заходу" : "Новий захід"}</h2>
      <ErrorMessage error={error} />
      {error?.code === "version_conflict" && (
        <button type="button" className="secondary" onClick={onReload}>
          Оновити картку
        </button>
      )}
      <fieldset disabled={busy}>
        <div className="form-grid">
          <label>
            Розділ
            <select
              required
              value={value.sectionId}
              onChange={(e) =>
                setValue((v) => ({
                  ...v,
                  sectionId: e.target.value,
                  riskId: null,
                }))
              }
            >
              {options.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}. {s.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Підрозділ
            <select
              required
              value={value.departmentId}
              onChange={(e) =>
                setValue((v) => ({
                  ...v,
                  departmentId: e.target.value,
                  executorId:
                    options.executors.find((u) =>
                      u.departmentIds.includes(e.target.value),
                    )?.id || "",
                }))
              }
            >
              {options.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            {original ? "Базовий виконавець" : "Виконавець"}
            <select
              required
              value={value.executorId}
              onChange={(e) => change("executorId", e.target.value)}
            >
              <option value="">Оберіть виконавця</option>
              {options.executors
                .filter((e) => e.departmentIds.includes(value.departmentId))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
            </select>
          </label>
          {riskRequired && (
            <label>
              Ризик
              <select
                required
                value={value.riskId || ""}
                onChange={(e) => change("riskId", e.target.value || null)}
              >
                <option value="">Оберіть ризик</option>
                {options.risks.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} · {r.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Код
            <input
              required
              maxLength={50}
              value={value.code}
              onChange={(e) => change("code", e.target.value)}
            />
          </label>
          <label>
            Назва заходу
            <input
              required
              maxLength={200}
              value={value.title}
              onChange={(e) => change("title", e.target.value)}
            />
          </label>
          <label>
            Тип строку
            <select
              value={value.scheduleType}
              onChange={(e) =>
                setValue((v) => ({
                  ...v,
                  scheduleType: e.target.value,
                  plannedDate:
                    e.target.value === "continuous" ? null : program.periodEnd,
                }))
              }
            >
              <option value="one_time">Одноразовий</option>
              <option value="continuous">Постійний</option>
            </select>
          </label>
          {value.scheduleType === "one_time" && (
            <label>
              Планова дата
              <input
                type="date"
                required
                min={program.periodStart}
                max={program.periodEnd}
                value={value.plannedDate || ""}
                onChange={(e) => change("plannedDate", e.target.value)}
              />
            </label>
          )}
        </div>
        <label>
          Опис
          <textarea
            maxLength={4000}
            value={value.description}
            onChange={(e) => change("description", e.target.value)}
          />
        </label>
        <h3>Плановий індикатор</h3>
        <div className="form-grid">
          <label>
            Назва індикатора
            <input
              required
              maxLength={200}
              value={value.indicator.title}
              onChange={(e) => indicator("title", e.target.value)}
            />
          </label>
          <label>
            Одиниця виміру
            <input
              required
              maxLength={50}
              value={value.indicator.unit}
              onChange={(e) => indicator("unit", e.target.value)}
            />
          </label>
          <label>
            Базове значення
            <input
              required
              type="number"
              step="any"
              value={value.indicator.baseline}
              onChange={(e) => indicator("baseline", e.target.value)}
            />
          </label>
          <label>
            Цільове значення
            <input
              required
              type="number"
              step="any"
              value={value.indicator.target}
              onChange={(e) => indicator("target", e.target.value)}
            />
          </label>
          <label>
            Напрям
            <select
              value={value.indicator.direction}
              onChange={(e) => indicator("direction", e.target.value)}
            >
              <option value="increase">Збільшення</option>
              <option value="decrease">Зменшення</option>
              <option value="maintain">Збереження</option>
            </select>
          </label>
        </div>
        {original && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={value.active}
              onChange={(e) => change("active", e.target.checked)}
            />
            Активний запис
          </label>
        )}
        <div className="actions">
          <button>{busy ? "Зберігаємо…" : "Зберегти захід"}</button>
          <button type="button" className="secondary" onClick={onCancel}>
            Скасувати
          </button>
        </div>
      </fieldset>
    </form>
  );
}
createRoot(document.getElementById("root")).render(<App />);
