import { useState } from "react";

export function RegistryImport({ api, onImported }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("registry");
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      if (!(file instanceof File) || !file.size || file.size > 1024 * 1024) {
        throw new Error("Оберіть файл JSON розміром до 1 МіБ.");
      }
      const content = await file.text();
      let payload;
      try {
        payload = JSON.parse(content.replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("Не вдалося прочитати файл JSON. Перевірте його формат.");
      }
      const result = await api("/imports/registry", { method: "POST", body: JSON.stringify(payload) });
      setCreated(result.created);
      form.reset();
      onImported();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="access-management" aria-labelledby="registry-import-title">
      <h1 id="registry-import-title">Імпорт реєстру</h1>
      <form className="card" onSubmit={submit}>
        <label>Файл реєстру JSON<input type="file" name="registry" accept=".json,application/json" required disabled={busy} /></label>
        {error && <p className="error" role="alert">{error.message}</p>}
        {created && (
          <p className="access-notice" role="status">
            Імпорт завершено. Додано програм: {created.programs}, заходів: {created.measures}.
          </p>
        )}
        <button disabled={busy}>{busy ? "Імпортуємо…" : "Імпортувати"}</button>
      </form>
    </section>
  );
}
