import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountEntry } from "./AccountEntry.jsx";
import { AdminAccess } from "./AdminAccess.jsx";
import { DeleteAction } from "./DeleteAction.jsx";
import { EvidenceCleanup } from "./EvidenceCleanup.jsx";
import { DepartmentAdmin } from "./DepartmentAdmin.jsx";
import { HalfYearReport } from "./HalfYearReport.jsx";
import { ProgramDashboard } from "./ProgramDashboard.jsx";
import { ProgramAdmin } from "./ProgramAdmin.jsx";
import { ProgramReference } from "./ProgramReference.jsx";
import { RegistryImport } from "./RegistryImport.jsx";
import { OfficialMeasureResult, ResultPanel } from "./ResultPanel.jsx";
import { measurePeriods, recurrenceLabels } from "./measure-schedule.js";
import { formatRegistryDate, halfYears, kyivToday } from "./periods.js";
import { Glyph, SignIn, Workspace } from "./Workspace.jsx";
import { hasPermission, roleNames } from "./permissions.js";
import "./styles.css";

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
  if (response.status === 204) return null;
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(
      data?.error?.message || `Не вдалося виконати запит (HTTP ${response.status}).`,
    );
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function ErrorMessage({ error }) {
  return error ? (
    <p className="error" role="alert">
      {error.message || error}
    </p>
  ) : null;
}
function App() {
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState("");
  const [sessionChecking, setSessionChecking] = useState(true);
  const [previewExit, setPreviewExit] = useState({ busy: false, error: null });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const sessionChannel = useRef(null);
  const refreshSession = useCallback(() => {
    setSessionChecking(true);
    setLoading(true);
    setUser(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!window.BroadcastChannel) return;
    const channel = new BroadcastChannel("dacm-session");
    sessionChannel.current = channel;
    channel.onmessage = ({ data }) => {
      if (data === "changed") refreshSession();
    };
    return () => {
      sessionChannel.current = null;
      channel.close();
    };
  }, [refreshSession]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api("/me", { signal: controller.signal })
      .then((current) => {
        if (controller.signal.aborted) return;
        if ((current.authKind === "password" || current.authKind === "preview") && current.status === "approved") {
          setUser(current);
        } else if (current.authKind === "password") {
          setError("Адміністратор ще не відкрив доступ до цього облікового запису.");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.status !== 401) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSessionChecking(false);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (!user) return;
    let controller;
    function checkSession() {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      const check = new AbortController();
      controller = check;
      api("/me", { signal: check.signal })
        .then((current) => {
          if (!check.signal.aborted && JSON.stringify(current) !== JSON.stringify(user)) {
            setUser((value) => value === user ? current : value);
          }
        })
        .catch((cause) => {
          if (!check.signal.aborted && cause.status === 401) {
            setUser((value) => value === user ? null : value);
          }
        });
    }
    document.addEventListener("visibilitychange", checkSession);
    return () => {
      controller?.abort();
      document.removeEventListener("visibilitychange", checkSession);
    };
  }, [user]);

  const sessionApi = useCallback(async (path, options) => {
    try {
      return await api(path, options);
    } catch (cause) {
      if (cause.status === 401 && !options?.signal?.aborted) {
        setUser((current) => current === user ? null : current);
      }
      if (cause.code === "role_preview_unavailable" && user?.preview && !options?.signal?.aborted) {
        refreshSession();
      }
      throw cause;
    }
  }, [user, refreshSession]);

  async function authenticate(credentials) {
    setLoading(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify(credentials) });
      setNotice("");
      sessionChannel.current?.postMessage("changed");
      refreshSession();
    } catch (e) {
      setError(e);
      setLoading(false);
    }
  }
  async function changePassword(credentials) {
    try {
      await api("/auth/password", { method: "POST", body: JSON.stringify(credentials) });
    } catch (cause) {
      if (cause.status === 401 && cause.code !== "invalid_credentials") refreshSession();
      throw cause;
    }
    setNotice("Пароль змінено. Увійдіть із новим паролем.");
    sessionChannel.current?.postMessage("changed");
    refreshSession();
  }

  async function startRolePreview(userId) {
    await sessionApi("/role-preview", { method: "PUT", body: JSON.stringify({ userId }) });
    sessionChannel.current?.postMessage("changed");
    refreshSession();
  }

  async function exitRolePreview() {
    setPreviewExit({ busy: true, error: null });
    try {
      await sessionApi("/role-preview", { method: "DELETE" });
      sessionChannel.current?.postMessage("changed");
      refreshSession();
      setPreviewExit({ busy: false, error: null });
    } catch (cause) {
      setPreviewExit({ busy: false, error: cause });
    }
  }

  async function logout() {
    setLoading(true);
    setError(null);
    try {
      await api("/session", { method: "DELETE" }).catch((e) => {
        if (e.status !== 401) throw e;
      });
      sessionChannel.current?.postMessage("changed");
      refreshSession();
    } catch (e) {
      setError(e);
      setLoading(false);
    }
  }
  const errorMessage = <ErrorMessage error={error} />;
  if (sessionChecking) {
    return <SignIn title="Перевіряємо сеанс"><p role="status">Завантажуємо доступ…</p></SignIn>;
  }
  if (!user) {
    return <AccountEntry loading={loading} error={errorMessage} notice={notice} onLogin={authenticate} />;
  }
  const rolePreview = user.preview
    ? { onExit: exitRolePreview, ...previewExit }
    : user.role === "admin" ? { api: sessionApi, onStart: startRolePreview } : null;
  const accessKey = JSON.stringify([user.authKind, user.id, user.roleId, user.permissions, user.scopes]);
  return <Registry key={accessKey} api={sessionApi} user={user}
    logout={logout} changePassword={user.preview ? null : changePassword} rolePreview={rolePreview}
    busy={loading} sessionError={errorMessage} />;
}
function Registry({ api, user, logout, changePassword, rolePreview, busy, sessionError }) {
  const manageAccess = !user.preview && user.authKind === "password" && user.role === "admin";
  const importRegistry = !user.preview && hasPermission(user, "registry.import", user.role === "admin");
  const unavailable = Boolean(user.preview?.unavailable);
  const [navigation, setNavigation] = useState(manageAccess ? "access" : null);
  const [attempt, setAttempt] = useState(0);
  const [programs, setPrograms] = useState(null),
    [programId, setProgramId] = useState(""),
    [error, setError] = useState(null);
  useEffect(() => {
    if (unavailable) return;
    const controller = new AbortController();
    setError(null);
    setPrograms(null);
    api("/programs", { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        setPrograms(r.items);
        setProgramId((current) => r.items.some(({ id }) => id === current) ? current : r.items[0]?.id ?? "");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [api, attempt, unavailable]);
  const programPicker = (
    <label className="program-select">
      <span>Програма</span>
      <select value={programId} onChange={(event) => setProgramId(event.target.value)} disabled={!programs?.length}>
        {programs?.map((program) => (
          <option key={program.id} value={program.id}>{program.title}</option>
        ))}
      </select>
    </label>
  );
  const shell = {
    user, role: user.roleName ?? roleNames[user.role], logout, changePassword, rolePreview, busy, programPicker,
    manageAccess, importRegistry,
  };
  const program = programs?.find(({ id }) => id === programId);
  const showAccess = manageAccess && navigation === "access";
  const showImport = importRegistry && navigation === "registryImport";
  const showPrograms = manageAccess && navigation === "programManagement";
  if (unavailable) return <Workspace {...shell} programPicker={null} programNavigation={false}>{sessionError}</Workspace>;
  if (showAccess || showImport || showPrograms) {
    return (
      <Workspace {...shell} programPicker={null} programNavigation={Boolean(program)}
        activeView={navigation} onNavigate={setNavigation}>
        {sessionError}
        {showAccess && <AdminAccess api={api} currentUserId={user.id} />}
        {showImport && <RegistryImport api={api} onImported={() => setAttempt((value) => value + 1)} />}
        {showPrograms && <ProgramAdmin api={api} programs={programs} error={error}
          onRetry={() => setAttempt((value) => value + 1)} onChange={(id) => {
            if (id) setProgramId(id);
            setAttempt((value) => value + 1);
          }} />}
      </Workspace>
    );
  }
  return program ? (
    <Program key={program.id} api={api} program={program} user={user} shell={shell} sessionError={sessionError}
      initialView={navigation} onNavigate={setNavigation} />
  ) : (
    <Workspace {...shell} programNavigation={false} onNavigate={manageAccess || importRegistry ? setNavigation : null}>
      {sessionError}
      <ErrorMessage error={error} />
      {!error && <p role="status">{programs ? "Немає доступних програм." : "Завантаження програм…"}</p>}
      {(error || programs) && (
        <button type="button" className="secondary" onClick={() => setAttempt((value) => value + 1)}>
          Оновити список програм
        </button>
      )}
    </Workspace>
  );
}

const registryPageSize = 20;
const lastRegistryPage = (total) => Math.max(1, Math.ceil(total / registryPageSize));

function scheduleLabel(measure) {
  if (measure.scheduleType === "continuous") return "Постійно";
  if (measure.scheduleType === "periodic") return recurrenceLabels[measure.recurrence] ?? "Періодично";
  return formatRegistryDate(measure.plannedDate);
}

function Program({ api, program, user, shell, sessionError, initialView, onNavigate }) {
  const [reportPeriod, setReportPeriod] = useState(null);
  const [signalSubject, setSignalSubject] = useState(null);
  const [registryNotice, setRegistryNotice] = useState("");
  const [view, setView] = useState(initialView ?? (
    hasPermission(user, "analytics.read", true) ? "dashboard" : "registry"
  ));
  const canEditRegistry = !user.preview && hasPermission(user, "registry.write", user.role === "coordinator");
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
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState(null);
  const detailRequest = useRef(null);
  const detailView = useRef(0);
  const detailHeading = useRef(null);
  const focusOnDetail = useRef(false);
  const searchTerm = search.trim().normalize("NFC").toLocaleLowerCase("uk");
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

  const [optionsError, setOptionsError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setOptionsError(null);
    api(`/programs/${program.id}/registry-options`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setOptions(value); })
      .catch((cause) => { if (!controller.signal.aborted) setOptionsError(cause); });
    return () => controller.abort();
  }, [api, program.id, refresh]);
  useEffect(() => {
    if (view !== "registry") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      programId: program.id,
      page: String(page),
      pageSize: String(registryPageSize),
      ...(section ? { sectionId: section } : {}),
      ...(active ? { active } : {}),
      ...(periodKey ? { periodKey } : {}),
      ...(searchTerm ? { q: searchTerm } : {}),
    });
    const load = async () => {
      try {
        const value = await api("/measures?" + query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const lastPage = lastRegistryPage(value.total);
        if (page > lastPage) {
          setResult(null);
          setPage(lastPage);
        } else {
          setResult(value);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const timeout = searchTerm ? setTimeout(load, 180) : null;
    if (timeout === null) load();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [api, program.id, page, section, active, periodKey, refresh, searchTerm, view]);
  function clearDetail() {
    detailView.current += 1;
    detailRequest.current?.abort();
    detailRequest.current = null;
    focusOnDetail.current = false;
    setDetailLoading(false);
    setDetailError(null);
    setSelected(null);
    setEditing(false);
  }
  function changePage(offset) {
    clearDetail();
    setResult(null);
    setPage((p) => p + offset);
  }
  async function open(id, {
    requestedPeriod = periodKey,
    focusHeading = false,
    sourceResultId = null,
    source,
  } = {}) {
    clearDetail();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetailLoading(true);
    try {
      const query = new URLSearchParams();
      if (source === "official") query.set("source", source);
      else if (requestedPeriod) query.set("periodKey", requestedPeriod);
      const measure = await api("/measures/" + id + (query.size ? "?" + query : ""), {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        focusOnDetail.current = focusHeading;
        setSelected({ ...measure, sourceResultId,
          ...(measure.officialResult && requestedPeriod ? { periodKey: requestedPeriod } : {}) });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setDetailError({ cause: e, retry: () => open(id, { requestedPeriod, focusHeading, sourceResultId, source }) });
      }
    } finally {
      if (!controller.signal.aborted) {
        detailRequest.current = null;
        setDetailLoading(false);
      }
    }
  }
  function openDashboardMeasure({ measureId, periodKey: requestedPeriod, resultId, source }) {
    if (view === "approvals") {
      setView("review");
      open(measureId, { requestedPeriod, focusHeading: true, sourceResultId: resultId, source });
      return;
    }
    setView("registry");
    onNavigate("registry");
    if (section || active || searchTerm || page !== 1 || periodKey !== requestedPeriod) {
      setResult(null);
      setSection("");
      setActive("");
      setSearch("");
      setPage(1);
      setPeriodKey(requestedPeriod);
    }
    open(measureId, { requestedPeriod, focusHeading: true, sourceResultId: resultId, source });
  }
  function openSignalSubject(subject) {
    clearDetail();
    setSignalSubject(subject);
    const next = subject.type === "risk" ? "corruptionRisks" : "dashboard";
    setView(next);
    onNavigate(next);
  }
  function beginSave() {
    const originView = detailView.current;
    return (value) => {
      // The write still changes the registry after its form has been left.
      setRefresh((n) => n + 1);
      if (detailView.current !== originView) return;

      const compatiblePeriod = measurePeriods(value, program).some(({ key }) => key === periodKey);
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
    setSignalSubject(null);
    onNavigate(next);
    if (!["access", "registryImport", "programManagement"].includes(next)) setView(next);
  }
  function resetList() {
    clearDetail();
    setResult(null);
    setPage(1);
  }
  const resultAnchor = useRef(null);
  const missingRegistrySetup = options && (!options.departments.length
    ? "Спочатку додайте підрозділ."
    : !options.executors.length ? "Спочатку призначте виконавця з активним обліковим записом." : "");
  const total = result?.total ?? 0;
  const lastPage = lastRegistryPage(total);
  const rows = result?.items ?? [];
  const viewMode = view === "dashboard" ? "overview" : view;
  const deletionView = detailView.current;
  const programContext = (
    <p>{program.title} <span aria-hidden="true">·</span> {formatRegistryDate(program.periodStart)} — {formatRegistryDate(program.periodEnd)}</p>
  );
  const resultPanel = selected && (
    <ResultPanel key={`${selected.id}:${selected.periodKey ?? periodKey}:${selected.sourceResultId ?? ""}`}
      measure={selected} sourceResultId={selected.sourceResultId} program={program} user={user} options={options} api={api} onPlanLockChange={reflectPlanLock} />
  );

  const detailFailure = detailError && (
    <>
      <ErrorMessage error={detailError.cause} />
      <button className="secondary" type="button" onClick={detailError.retry}>
        Повторити завантаження картки
      </button>
    </>
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
        {detailFailure}
        {detailLoading && <p className="count" role="status">Завантаження результату…</p>}
        {resultPanel}
      </Workspace>
    );
  }

  return (
    <Workspace {...shell} activeView={view} onNavigate={navigate}>
      {sessionError}
      {shell.manageAccess && (view === "registry" || view === "departments") && (
        <EvidenceCleanup api={api} revision={refresh} />
      )}
      {view === "registry" && <header className="section-heading">
        <div>
          <h1 id="registry-title" tabIndex={-1}>Реєстр заходів</h1>
          {programContext}
        </div>
        {canEditRegistry && options && (program.periodEnd < kyivToday() ? (
          <p className="count">Період програми завершено.</p>
        ) : missingRegistrySetup ? (
          <p className="count">{missingRegistrySetup}</p>
        ) : (
          <button type="button" className="with-icon" onClick={() => {
            clearDetail();
            setEditing(true);
          }}>
            <Glyph name="plus" size={18} /> Додати захід
          </button>
        ))}
      </header>}
      {view === "departments" ? (
        <>
          <ErrorMessage error={optionsError} />
          {optionsError && <button className="secondary" type="button" onClick={() => setRefresh((n) => n + 1)}>Повторити завантаження</button>}
          {options ? <DepartmentAdmin key={program.id} api={api} program={program}
            departments={options.departments} onChange={() => setRefresh((value) => value + 1)} />
            : !optionsError && <p className="count" role="status">Завантаження підрозділів…</p>}
        </>
      ) : view === "passport" || view === "corruptionRisks" ? (
        <ProgramReference view={view} program={program} programContext={programContext}
          departments={options?.departments ?? []} api={api} readOnly={Boolean(user.preview)}
          catalogAdmin={shell.manageAccess} onCatalogChange={() => setRefresh((value) => value + 1)}
          focusedRiskId={signalSubject?.type === "risk" ? signalSubject.id : undefined} />
      ) : view === "report" ? (
        <HalfYearReport program={program} api={api} selectedPeriod={reportPeriod}
          onPeriodChange={setReportPeriod} onOpenMeasure={openDashboardMeasure} />
      ) : view !== "registry" ? (
        <ProgramDashboard key={viewMode} mode={viewMode} program={program} userRole={user.role}
          programContext={programContext} departments={options?.departments ?? []}
          api={api} onOpenMeasure={openDashboardMeasure} onOpenSubject={openSignalSubject}
          canOpenRisk={hasPermission(user, "risks.read", user.role !== "executor")}
          initialDepartmentId={signalSubject?.type === "department" ? signalSubject.id : ""} />
      ) : (
        <>
          {registryNotice && <p className="access-notice" role="status">{registryNotice}</p>}
          <div className={selected && !editing ? "register-grid register-grid-split" : "register-grid"}>
            <section className="register-list" aria-label="Перелік заходів">
              <div className="registry-filters">
                <label className="registry-search">
                  <span>Пошук заходів</span>
                  <span className="search-field">
                    <Glyph name="search" size={17} />
                    <input type="search" maxLength={200} placeholder="Код або назва" value={search}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next.trim().normalize("NFC").toLocaleLowerCase("uk") !== searchTerm) resetList();
                        setSearch(next);
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
                <ErrorMessage error={error ?? optionsError} />
                {(error || optionsError) && (
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
                      <p className="empty">{searchTerm
                        ? "За цим запитом заходів немає."
                        : "За вибраними фільтрами немає доступних заходів."}</p>
                    )}
                    {lastPage > 1 && (
                      <nav className="register-pagination" aria-label="Сторінки реєстру">
                        <button className="secondary" type="button" disabled={page === 1 || loading}
                          onClick={() => changePage(-1)}>Попередня</button>
                        <span>Сторінка {page}</span>
                        <button className="secondary" type="button" disabled={page >= lastPage || loading}
                          onClick={() => changePage(1)}>Наступна</button>
                      </nav>
                    )}
                  </>
                )}
                {detailFailure}
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
                  <dd>{scheduleLabel(selected)}</dd>
                  <dt>Індикатор</dt>
                  <dd>{selected.indicator.title}: {selected.indicator.baseline ?? "—"} → {selected.indicator.target ?? "—"} {selected.indicator.unit ?? ""}</dd>
                  <dt>Ризик</dt>
                  <dd>{selected.riskId
                    ? options?.risks.find((entry) => entry.id === selected.riskId)?.title ?? "Назва недоступна"
                    : "Не застосовується"}</dd>
                  <dt>Версія запису</dt>
                  <dd>{selected.version}</dd>
                </dl>
                <div className="inspector-actions">
                  <button className="secondary with-icon" type="button"
                    onClick={() => resultAnchor.current?.focus()}>
                    До результату <Glyph name="arrow" size={17} />
                  </button>
                  {canEditRegistry && (
                    selected.planFrozen ? <p className="count">План зафіксовано після подання результату.</p>
                      : <button className="link" type="button" onClick={() => setEditing(true)}>Редагувати захід</button>
                  )}
                </div>
                {shell.manageAccess && <DeleteAction key={selected.id} label="Видалити захід" confirmLabel="Видалити назавжди"
                  prompt={`Остаточно видалити захід «${selected.code}» та всі його результати, призначення й докази?`} onDelete={async () => {
                    const outcome = await api(`/measures/${selected.id}`, { method: "DELETE", body: JSON.stringify({ version: selected.version }) });
                    setRefresh((value) => value + 1);
                    if (detailView.current !== deletionView) return;
                    clearDetail();
                    setRegistryNotice(outcome
                      ? `Захід «${selected.code}» видалено. Файли доказів очікують очищення.`
                      : `Захід «${selected.code}» видалено.`);
                    requestAnimationFrame(() => document.getElementById("registry-title")?.focus());
                  }} />}
              </article>
            )}
          </div>
          {selected && !editing && (
            <div ref={resultAnchor} tabIndex={-1} className="registry-result">
              {selected.officialResult && <OfficialMeasureResult result={selected.officialResult} measureId={selected.id} user={user} api={api} />}
              {resultPanel}
            </div>
          )}
          {editing && options && (
            <MeasureForm api={api} key={selected?.id || "new"} original={selected} options={options} program={program}
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
                {scheduleLabel(item)}
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
  api,
  original,
  options,
  program,
  onSaveStart,
  onCancel,
  onReload,
}) {
  const firstDepartment = options.departments.find(({ id }) =>
    options.executors.some(({ departmentIds }) => departmentIds.includes(id)))?.id ?? options.departments[0]?.id ?? "";
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
          recurrence: null,
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
  const availableExecutors = options.executors.filter((item) => item.departmentIds.includes(value.departmentId));
  const today = kyivToday();
  const effectiveFrom = original?.effectiveFrom ?? (today > program.periodStart ? today : program.periodStart);
  const riskRequired =
    options.sections.find((s) => s.id === value.sectionId)?.code === 2;
  const permitsAnnual = original?.recurrence === "annual_april_may" || measurePeriods({
    scheduleType: "periodic",
    recurrence: "annual_april_may",
    effectiveFrom: original?.effectiveFrom ?? today,
  }, program).length > 0;
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
        "recurrence",
        "plannedDate",
      ].map((key) => [key, value[key]]),
    );
    body.indicator = {
      title: value.indicator.title,
      unit: value.indicator.unit?.trim() || null,
      baseline: value.indicator.baseline == null || value.indicator.baseline === "" ? null : Number(value.indicator.baseline),
      target: value.indicator.target == null || value.indicator.target === "" ? null : Number(value.indicator.target),
      direction: value.indicator.direction || null,
    };
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
              {value.executorId && !availableExecutors.some(({ id }) => id === value.executorId) &&
                <option value={value.executorId}>Поточний виконавець недоступний</option>}
              {availableExecutors.map((e) => (
                <option key={e.id} value={e.id}>{e.displayName}</option>
              ))}
            </select>
            {!availableExecutors.length && !value.executorId && (
              <span className="count">У цього підрозділу ще немає виконавця з активним доступом.</span>
            )}
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
              onChange={(e) => {
                const scheduleType = e.target.value;
                setValue((v) => ({
                  ...v,
                  scheduleType,
                  recurrence: scheduleType === "periodic" ? v.recurrence ?? "monthly" : null,
                  plannedDate: scheduleType === "one_time" ? program.periodEnd : null,
                }));
              }}
            >
              <option value="one_time">Одноразовий</option>
              <option value="continuous">Постійний</option>
              <option value="periodic">Періодичний</option>
            </select>
          </label>
          {value.scheduleType === "periodic" && (
            <label>
              Повторюваність
              <select required value={value.recurrence ?? ""} onChange={(e) => change("recurrence", e.target.value)}>
                <option value="" disabled>Оберіть повторюваність</option>
                {Object.entries(recurrenceLabels).map(([key, title]) => {
                  const unavailable = key === "annual_april_may" && !permitsAnnual;
                  return <option key={key} value={key} disabled={unavailable}>
                    {unavailable ? `${title} (поза строком програми)` : title}
                  </option>;
                })}
              </select>
            </label>
          )}
          {value.scheduleType === "one_time" && (
            <label>
              Планова дата
              <input
                type="date"
                required
                min={effectiveFrom}
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
              required={!original || original.indicator.unit != null}
              maxLength={50}
              value={value.indicator.unit ?? ""}
              onChange={(e) => indicator("unit", e.target.value)}
            />
          </label>
          <label>
            Базове значення
            <input
              required={!original || original.indicator.baseline != null}
              type="number"
              step="any"
              value={value.indicator.baseline ?? ""}
              onChange={(e) => indicator("baseline", e.target.value)}
            />
          </label>
          <label>
            Цільове значення
            <input
              required={!original || original.indicator.target != null}
              type="number"
              step="any"
              value={value.indicator.target ?? ""}
              onChange={(e) => indicator("target", e.target.value)}
            />
          </label>
          <label>
            Напрям
            <select
              required={!original || original.indicator.direction != null}
              value={value.indicator.direction ?? ""}
              onChange={(e) => indicator("direction", e.target.value)}
            >
              {original && original.indicator.direction == null && <option value="">Не зазначено</option>}
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
