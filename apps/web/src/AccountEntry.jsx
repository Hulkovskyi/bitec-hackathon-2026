import { SignIn } from "./Workspace.jsx";
import "./account.css";

export function AccountEntry({ loading, error, onLogin }) {
  function submit(event) {
    event.preventDefault();
    if (!loading) onLogin(Object.fromEntries(new FormData(event.currentTarget)));
  }

  return (
    <SignIn title="Вхід до системи">
      <form className="session-form" onSubmit={submit}>
        <label>
          Логін
          <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required />
        </label>
        <label>
          Пароль
          <input name="password" type="password" autoComplete="current-password" maxLength={128} required />
        </label>
        <button disabled={loading}>Увійти</button>
      </form>
      {error}
      {loading && <p role="status" className="count">Завантаження…</p>}
    </SignIn>
  );
}
