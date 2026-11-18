import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ResultPanel } from "./ResultPanel.jsx";
import { halfYears } from "./periods.js";
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
  return (
    <main>
      <header>
        <p className="eyebrow">ITT-Zholudi · Digital Anti-Corruption Monitor</p>
        <h1>Реєстр антикорупційної програми</h1>
        <p className="demo">Синтетичні дані / деморежим</p>
      </header>
      <section className="session" aria-label="Демосесія">
        <form onSubmit={login}>
          <label>
            Демокористувач
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={loading || !users.length}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} · {roleNames[u.role]}
                </option>
              ))}
            </select>
          </label>
          <button disabled={loading || !choice}>Увійти</button>
        </form>
        {user && (
          <p>
            {user.displayName} · {roleNames[user.role]}{" "}
            <button className="secondary" onClick={logout} disabled={loading}>
              Вийти
            </button>
          </p>
        )}
      </section>
      <ErrorMessage error={error} />
      {loading && <p role="status">Завантаження…</p>}
      {user && !loading && <Registry key={user.id} user={user} />}
      {!user && !loading && !error && (
        <p>Оберіть демокористувача, щоб відкрити доступні йому заходи.</p>
      )}
    </main>
  );
}
function Registry({ user }) {
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
  return (
    <>
      <ErrorMessage error={error} />
      <label className="program-select">
        Програма
        <select
          value={programId}
          onChange={(e) => setProgramId(e.target.value)}
        >
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.title}
            </option>
          ))}
        </select>
      </label>
      {programId ? (
        <Program
          key={programId}
          program={programs.find((p) => p.id === programId)}
          user={user}
        />
      ) : (
        !error && <p role="status">Програм немає або вони завантажуються.</p>
      )}
    </>
  );
}
function Program({ program, user }) {
  const [options, setOptions] = useState(null),
    [result, setResult] = useState(null),
    [error, setError] = useState(null);
  const [page, setPage] = useState(1),
    [section, setSection] = useState(""),
    [periodKey, setPeriodKey] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null),
    [editing, setEditing] = useState(false),
    [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(null);
  const detailView = useRef(0);
  useEffect(() => () => {
    detailView.current += 1;
    detailRequest.current?.abort();
  }, []);
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
      page: String(page),
      pageSize: "20",
      ...(section ? { sectionId: section } : {}),
      ...(periodKey ? { periodKey } : {}),
    });
    Promise.all([
      api(`/programs/${program.id}/registry-options`, {
        signal: controller.signal,
      }),
      api("/measures?" + query, { signal: controller.signal }),
    ])
      .then(([o, r]) => {
        if (controller.signal.aborted) return;
        setOptions(o);
        setResult(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [program.id, page, section, periodKey, refresh]);
  function clearDetail() {
    detailView.current += 1;
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetailLoading(false);
    setSelected(null);
    setEditing(false);
  }
  function changePage(offset) {
    clearDetail();
    setResult(null);
    setPage((p) => p + offset);
  }
  async function open(id) {
    clearDetail();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetailLoading(true);
    setError(null);
    try {
      const query = periodKey ? `?${new URLSearchParams({ periodKey })}` : "";
      const measure = await api("/measures/" + id + query, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setSelected(measure);
    } catch (e) {
      if (!controller.signal.aborted) setError(e);
    } finally {
      if (!controller.signal.aborted) {
        detailRequest.current = null;
        setDetailLoading(false);
      }
    }
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
  return (
    <section>
      <div className="section-heading">
        <div>
          <h2>{program.title}</h2>
          <p>
            {program.periodStart} — {program.periodEnd}
          </p>
        </div>
        {user.role === "coordinator" && options && (
          <button
            onClick={() => {
              clearDetail();
              setEditing(true);
            }}
          >
            Створити захід
          </button>
        )}
      </div>
      <div className="form-grid">
        <label>
          Розділ
          <select value={section} onChange={(e) => {
            clearDetail();
            setResult(null);
            setSection(e.target.value);
            setPage(1);
          }}>
            <option value="">Усі доступні розділи</option>
            {options?.sections.map((s) => (
              <option key={s.id} value={s.id}>{s.code}. {s.title}</option>
            ))}
          </select>
        </label>
        <label>
          Період реєстру
          <select value={periodKey} onChange={(e) => {
            clearDetail();
            setResult(null);
            setPeriodKey(e.target.value);
            setPage(1);
          }}>
            <option value="">Поточний перегляд</option>
            <option value="once">Одноразові заходи</option>
            {halfYears(program.periodStart, program.periodEnd).map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <ErrorMessage error={error} />
      {error && (
        <button className="secondary" onClick={() => setRefresh((n) => n + 1)}>
          Повторити завантаження
        </button>
      )}
      {loading && <p role="status">Завантаження реєстру…</p>}
      {result && (
        <>
          <p className="count">Доступних заходів: {result.total}</p>
          {result.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Код і захід</th>
                    <th>Підрозділ</th>
                    <th>Плановий строк</th>
                    <th>Індикатор</th>
                    <th>Стан запису</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <button
                          className="link"
                          disabled={detailLoading}
                          onClick={() => open(m.id)}
                        >
                          {m.code} · {m.title}
                        </button>
                      </td>
                      <td>
                        {
                          options?.departments.find(
                            (d) => d.id === m.departmentId,
                          )?.title
                        }
                      </td>
                      <td>
                        {m.scheduleType === "continuous"
                          ? "Постійно"
                          : m.plannedDate}
                      </td>
                      <td>
                        {m.indicator.baseline} → {m.indicator.target}{" "}
                        {m.indicator.unit}
                      </td>
                      <td>{m.active ? "Активний" : "Неактивний"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">{periodKey
              ? "За вибраний період немає доступних заходів."
              : "У цьому розділі немає доступних заходів."}</p>
          )}
          <nav aria-label="Сторінки реєстру">
            <button
              className="secondary"
              disabled={page === 1 || loading}
              onClick={() => changePage(-1)}
            >
              Попередня
            </button>
            <span>Сторінка {page}</span>
            <button
              className="secondary"
              disabled={page * 20 >= result.total || loading}
              onClick={() => changePage(1)}
            >
              Наступна
            </button>
          </nav>
        </>
      )}
      {detailLoading && <p role="status">Завантаження картки…</p>}
      {selected && !editing && (
        <article className="card">
          <h2>
            {selected.code} · {selected.title}
          </h2>
          <p>{selected.description || "Опис не додано"}</p>
          <dl>
            <dt>Підрозділ</dt>
            <dd>
              {
                options?.departments.find((d) => d.id === selected.departmentId)
                  ?.title
              }
            </dd>
            <dt>Початок дії</dt>
            <dd>{selected.effectiveFrom}</dd>
            <dt>Строк</dt>
            <dd>
              {selected.scheduleType === "continuous"
                ? "Постійно"
                : selected.plannedDate}
            </dd>
            <dt>Індикатор</dt>
            <dd>
              {selected.indicator.title}: {selected.indicator.baseline} →{" "}
              {selected.indicator.target} {selected.indicator.unit}
            </dd>
            <dt>Ризик</dt>
            <dd>
              {options?.risks.find((r) => r.id === selected.riskId)?.title ||
                "Не застосовується"}
            </dd>
            <dt>Версія запису</dt>
            <dd>{selected.version}</dd>
          </dl>
          {user.role === "coordinator" && (
            selected.planFrozen
              ? <p className="count">План зафіксовано після подання результату.</p>
              : <button onClick={() => setEditing(true)}>Редагувати захід</button>
          )}
          <ResultPanel
            key={`${selected.id}:${selected.periodKey ?? periodKey}`}
            measure={selected}
            program={program}
            user={user}
            options={options}
            api={api}
            onPlanLockChange={reflectPlanLock}
          />
        </article>
      )}
      {editing && options && (
        <MeasureForm
          key={selected?.id || "new"}
          original={selected}
          options={options}
          program={program}
          onSaveStart={beginSave}
          onCancel={closeForm}
          onReload={() => open(selected.id)}
        />
      )}
    </section>
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
