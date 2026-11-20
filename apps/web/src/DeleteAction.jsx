import { useRef, useState } from "react";

export function DeleteAction({ label, prompt, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const trigger = useRef(null);

  async function confirm() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
      setConfirming(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  if (!confirming) return <button ref={trigger} className="secondary" type="button"
    onClick={() => setConfirming(true)}>{label}</button>;

  function cancel() {
    setConfirming(false);
    setError(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  return (
    <div>
      <p>{prompt}</p>
      {error && <p className="error" role="alert">{error.message}</p>}
      <div className="account-switch">
        <button className="secondary" type="button" autoFocus disabled={saving} onClick={cancel}>Скасувати</button>
        <button type="button" disabled={saving} onClick={confirm}>{saving ? "Видаляємо…" : label}</button>
      </div>
    </div>
  );
}
