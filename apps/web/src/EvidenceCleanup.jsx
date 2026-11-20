import { useEffect, useState } from "react";

export function EvidenceCleanup({ api, revision }) {
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api("/admin/evidence-deletions", { signal: controller.signal })
      .then(({ pendingEvidence }) => {
        if (!controller.signal.aborted) setPending(pendingEvidence);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPending(null);
      });
    return () => controller.abort();
  }, [api, revision]);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await api("/admin/evidence-deletions/retry", { method: "POST" });
      setPending(outcome ? outcome.pendingEvidence : 0);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (pending === 0) return null;
  return (
    <section className="card" aria-label="Очищення файлів доказів">
      <p role="status">{pending === null
        ? "Стан очищення файлів тимчасово недоступний."
        : `Файлів доказів у черзі на видалення: ${pending}.`}</p>
      {error && <p className="error" role="alert">{error.message}</p>}
      <button className="secondary" type="button" disabled={busy} onClick={retry}>
        {busy ? "Очищуємо…" : "Повторити очищення файлів"}
      </button>
    </section>
  );
}
