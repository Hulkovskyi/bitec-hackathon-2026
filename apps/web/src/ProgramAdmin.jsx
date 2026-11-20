import { useState } from "react";
import { DeleteAction } from "./DeleteAction.jsx";

function ProgramEditor({ api, program, onClose, onSave }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError(null);
    try {
      const response = await api(program ? `/admin/programs/${program.id}` : "/admin/programs", {
        method: program ? "PATCH" : "POST", body: JSON.stringify(fields),
      });
      onSave(response.id, program ? "Програму оновлено." : "Програму додано.");
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="access-editor" aria-label={program ? "Редагування програми" : "Нова програма"} onSubmit={submit}>
      <div className="form-grid">
        <label>Код програми<input name="code" defaultValue={program?.code} maxLength={50} required disabled={busy} autoFocus /></label>
        <label>Назва програми<input name="title" defaultValue={program?.title} maxLength={200} required disabled={busy} /></label>
        <label>Початок програми<input name="periodStart" type="date" defaultValue={program?.periodStart} required disabled={busy} /></label>
        <label>Кінець програми<input name="periodEnd" type="date" defaultValue={program?.periodEnd} required disabled={busy} /></label>
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      <div className="account-switch">
        <button type="submit" disabled={busy}>{busy ? "Збереження…" : "Зберегти програму"}</button>
        <button className="secondary" type="button" onClick={onClose} disabled={busy}>Скасувати</button>
      </div>
    </form>
  );
}

export function ProgramAdmin({ api, programs, error, onChange, onRetry }) {
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  return (
    <section className="card access-management" aria-labelledby="program-admin-title">
      <h1 id="program-admin-title">Програми</h1>
      {notice && <p className="access-notice" role="status">{notice}</p>}
      {error && <>
        <p className="error" role="alert">{error.message}</p>
        <button type="button" className="secondary" onClick={onRetry}>Оновити список програм</button>
      </>}
      {!programs && !error && <p className="count" role="status">Завантаження програм…</p>}
      {editing && <ProgramEditor key={editing.id ?? "new"} api={api} program={editing.id ? editing : null}
        onClose={() => setEditing(null)} onSave={(id, message) => {
          setEditing(null);
          setNotice(message);
          onChange(id);
        }} />}
      {!editing && <button type="button" disabled={!programs} onClick={() => {
        setNotice("");
        setEditing({});
      }}>Додати програму</button>}
      {!editing && programs?.length === 0 && <p className="empty">Програм ще немає.</p>}
      {!editing && programs?.map((program) => (
        <article className="access-entry" key={program.id}>
          <h2>{program.code} · {program.title}</h2>
          <div className="account-switch">
            <button type="button" className="secondary" onClick={() => {
              setNotice("");
              setEditing(program);
            }}>Редагувати програму</button>
            <DeleteAction label="Видалити програму" prompt={`Видалити програму «${program.title}»?`}
              onDelete={async () => {
                await api(`/admin/programs/${program.id}`, { method: "DELETE" });
                setNotice("Програму видалено.");
                onChange();
              }} />
          </div>
        </article>
      ))}
    </section>
  );
}
