import { useEffect, useId, useState } from "react";
import { roleNames } from "./permissions.js";

export function RolePreviewPicker({ api, onStart, onCancel }) {
  const [items, setItems] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [requestError, setRequestError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const id = useId();

  useEffect(() => {
    const controller = new AbortController();
    api("/role-preview/options", { signal: controller.signal })
      .then(({ items }) => {
        if (!controller.signal.aborted) setItems(items);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setRequestError(cause);
      });
    return () => controller.abort();
  }, [api, attempt]);

  async function start(event) {
    event.preventDefault();
    if (saving) return;
    const userId = new FormData(event.currentTarget).get("userId");
    setSaveError(null);
    setSaving(true);
    try {
      await onStart(userId);
    } catch (cause) {
      setSaveError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card role-preview-picker" aria-labelledby={id}>
      <h2 id={id}>Перегляд від імені користувача</h2>
      <p>Кабінет відкриється з роллю й підрозділами вибраного користувача. Зміни даних будуть недоступні.</p>
      {items ? (
        items.length ? (
          <form onSubmit={start}>
            <label>
              Користувач
              <select name="userId" defaultValue="" required disabled={saving} autoFocus>
                <option value="" disabled>Оберіть користувача</option>
                {items.map(({ id, displayName, roleName, role }) => (
                  <option key={id} value={id}>{roleName ?? roleNames[role]} · {displayName}</option>
                ))}
              </select>
            </label>
            {saveError && <p className="error" role="alert">{saveError.message}</p>}
            <div className="account-switch">
              <button disabled={saving}>{saving ? "Відкриття…" : "Почати перегляд"}</button>
              <button className="secondary" type="button" onClick={onCancel} disabled={saving}>Скасувати</button>
            </div>
          </form>
        ) : (
          <>
            <p className="empty">Немає активних користувачів, доступних для перегляду.</p>
            <button className="secondary" type="button" onClick={onCancel}>Закрити</button>
          </>
        )
      ) : (
        <>
          {requestError ? <p className="error" role="alert">{requestError.message}</p>
            : <p className="count" role="status">Завантажуємо користувачів…</p>}
          <div className="account-switch">
            {requestError && <button type="button" onClick={() => {
              setRequestError(null);
              setAttempt((value) => value + 1);
            }}>Повторити</button>}
            <button className="secondary" type="button" onClick={onCancel}>Закрити</button>
          </div>
        </>
      )}
    </section>
  );
}

export function RolePreviewBanner({ preview, onExit, busy, error }) {
  return (
    <div className="role-preview-banner">
      <div>
        <p role="status">
          <strong>Режим перегляду</strong>
          {!preview.unavailable && <> · {preview.displayName} · {preview.roleName}</>}
        </p>
        <p>{preview.unavailable ? "Цей користувач більше недоступний для перегляду." : "Зміни даних недоступні."}</p>
        {error && <p className="error" role="alert">{error.message}</p>}
      </div>
      <button className="secondary" type="button" onClick={onExit} disabled={busy}>
        {busy ? "Вихід…" : "Вийти з режиму перегляду"}
      </button>
    </div>
  );
}
