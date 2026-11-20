import { useId, useState } from "react";
import { minimumAccountPasswordLength } from "../../../shared/account-password.mjs";

export function PasswordChange({ onSave, onCancel }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const headingId = useId();
  const helpId = useId();
  const errorId = useId();

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const { currentPassword, newPassword, confirmation } = Object.fromEntries(new FormData(form));
    if (newPassword === currentPassword) {
      setError({ field: "newPassword", message: "Виберіть пароль, відмінний від поточного." });
      form.elements.newPassword.focus();
      return;
    }
    if (newPassword !== confirmation) {
      setError({ field: "confirmation", message: "Новий пароль і підтвердження не збігаються." });
      form.elements.confirmation.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ currentPassword, newPassword });
    } catch (cause) {
      setError({
        field: cause.code === "invalid_credentials" ? "currentPassword" : null,
        message: cause.message,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card password-change" aria-labelledby={headingId}>
      <h2 id={headingId}>Зміна пароля</h2>
      <form onSubmit={submit} onInput={() => { if (error) setError(null); }}>
        <fieldset disabled={saving}>
          <label>
            Поточний пароль
            <input name="currentPassword" type="password" autoComplete="current-password" maxLength={128}
              aria-describedby={error?.field === "currentPassword" ? errorId : undefined}
              aria-invalid={error?.field === "currentPassword" || undefined} autoFocus required />
          </label>
          <label>
            Новий пароль
            <input name="newPassword" type="password" autoComplete="new-password" minLength={minimumAccountPasswordLength} maxLength={128}
              aria-describedby={error?.field === "newPassword" ? `${helpId} ${errorId}` : helpId}
              aria-invalid={error?.field === "newPassword" || undefined} required />
            <small className="count" id={helpId}>Від {minimumAccountPasswordLength} до 128 символів</small>
          </label>
          <label>
            Підтвердіть новий пароль
            <input name="confirmation" type="password" autoComplete="new-password" maxLength={128}
              aria-describedby={error?.field === "confirmation" ? errorId : undefined}
              aria-invalid={error?.field === "confirmation" || undefined} required />
          </label>
        </fieldset>
        <p className="count">Після зміни пароля потрібно буде знову увійти на всіх пристроях.</p>
        {error && <p className="error" id={errorId} role="alert">{error.message}</p>}
        <div className="account-switch">
          <button disabled={saving}>{saving ? "Збереження…" : "Зберегти новий пароль"}</button>
          <button type="button" className="secondary" onClick={onCancel} disabled={saving}>Скасувати</button>
        </div>
      </form>
    </section>
  );
}
