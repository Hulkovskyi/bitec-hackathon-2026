import { useState } from "react";
import { DeleteAction } from "./DeleteAction.jsx";
import "./account.css";

function DepartmentForm({ department, busy, error, onSave, onCancel }) {
  function submit(event) {
    event.preventDefault();
    onSave(Object.fromEntries(new FormData(event.currentTarget)));
  }

  return (
    <form className="access-editor" onSubmit={submit} aria-label={department ? "Редагування підрозділу" : "Новий підрозділ"}>
      <label>Код<input name="code" maxLength={50} defaultValue={department?.code ?? ""} required disabled={busy} autoFocus /></label>
      <label>Назва<input name="title" maxLength={200} defaultValue={department?.title ?? ""} required disabled={busy} /></label>
      {error && <p className="error" role="alert">{error.message}</p>}
      <div className="account-switch">
        <button disabled={busy}>{department ? "Зберегти зміни" : "Створити підрозділ"}</button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Скасувати</button>
      </div>
    </form>
  );
}

export function DepartmentAdmin({ api, program, departments, onChange }) {
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/admin/programs/${program.id}/departments`;

  function open(next) {
    setEditor(next);
    setError(null);
    setNotice("");
  }

  async function save(method, id, fields, message) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api(id ? `${path}/${id}` : path, { method, body: JSON.stringify(fields) });
      setEditor(null);
      setNotice(message);
      onChange();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDepartment(id) {
    setNotice("");
    await api(`${path}/${id}`, { method: "DELETE" });
    setNotice("Підрозділ видалено.");
    onChange();
  }

  return (
    <section className="access-management" aria-labelledby="department-management-title">
      <h1 id="department-management-title">Підрозділи</h1>
      {notice && <p className="access-notice" role="status">{notice}</p>}
      {editor?.type === "create" ? (
        <DepartmentForm busy={busy} error={error} onCancel={() => open(null)}
          onSave={(fields) => save("POST", null, fields, "Підрозділ створено.")} />
      ) : (
        <button type="button" onClick={() => open({ type: "create" })} disabled={busy}>Додати підрозділ</button>
      )}
      {departments.length ? (
        <ul className="access-items">
          {departments.map((department) => (
            <li key={department.id} className="access-entry">
              <header>
                <div><h2>{department.title}</h2><p className="count">{department.code}</p></div>
                {editor?.id !== department.id && (
                  <div className="account-switch">
                    <button type="button" className="secondary" disabled={busy}
                      onClick={() => open({ type: "edit", id: department.id })}>Редагувати</button>
                    <DeleteAction label="Видалити підрозділ" prompt={`Видалити «${department.title}»?`}
                      onDelete={() => deleteDepartment(department.id)} />
                  </div>
                )}
              </header>
              {editor?.id === department.id && (
                <DepartmentForm department={department} busy={busy} error={error} onCancel={() => open(null)}
                  onSave={(fields) => save("PATCH", department.id, fields, "Зміни збережено.")} />
              )}
            </li>
          ))}
        </ul>
      ) : <p className="count">У програмі ще немає підрозділів.</p>}
    </section>
  );
}
