import { useState } from "react";
import { SignIn } from "./Workspace.jsx";
import "./account.css";

const accountTitles = {
  login: "Вхід до системи",
  register: "Реєстрація",
  demo: "Вхід у демосесію",
  draft: "Заявка на доступ",
  pending: "Заявка на розгляді",
  rejected: "Заявку відхилено",
};

function Credentials({ register, username }) {
  return (
    <>
      <label>
        Логін
        <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
          defaultValue={username} minLength={register ? 3 : undefined} maxLength={64} required />
      </label>
      <label>
        Пароль
        <input name="password" type="password" autoComplete={register ? "new-password" : "current-password"}
          aria-describedby={register ? "register-password-help" : undefined}
          minLength={register ? 12 : undefined} maxLength={128} required />
      </label>
      {register && <p id="register-password-help" className="count account-password-help">Від 12 до 128 символів</p>}
    </>
  );
}

export function AccountEntry({ demoForm, loading, error, onLogin, onRegister, onClearError }) {
  const [mode, setMode] = useState("login");
  const [registration, setRegistration] = useState(null);
  const selected = mode === "demo" && !demoForm ? "login" : mode;
  const registering = selected === "register";

  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (registering) {
      if (await onRegister(values)) {
        setRegistration(values.username);
        setMode("login");
      }
    } else {
      await onLogin(values);
    }
  }

  function changeMode(next) {
    onClearError();
    setMode(next);
  }

  return (
    <SignIn title={accountTitles[selected]} demo={selected === "demo"}>
      <div className="account-switch" role="group" aria-label="Спосіб входу">
        <button type="button" className="secondary" aria-pressed={selected === "login"}
          onClick={() => changeMode("login")} disabled={loading}>Вхід</button>
        <button type="button" className="secondary" aria-pressed={selected === "register"}
          onClick={() => changeMode("register")} disabled={loading}>Реєстрація</button>
        {demoForm && (
          <button type="button" className="secondary" aria-pressed={selected === "demo"}
            onClick={() => changeMode("demo")} disabled={loading}>Демовхід</button>
        )}
      </div>
      {selected === "demo" ? (
        <>
          <p>Оберіть демокористувача, щоб відкрити доступні йому заходи та панелі.</p>
          {demoForm}
        </>
      ) : (
        <form key={selected} className="session-form" onSubmit={submit}>
          {registering && (
            <>
              <label>ПІБ<input name="fullName" autoComplete="name" maxLength={160} required /></label>
              <label>Підрозділ<input name="department" maxLength={160} required /></label>
              <label>Посада<input name="position" autoComplete="organization-title" maxLength={160} required /></label>
            </>
          )}
          {!registering && registration && (
            <p role="status">Обліковий запис створено. Увійдіть, щоб подати заявку на доступ.</p>
          )}
          <Credentials register={registering} username={registering ? undefined : registration ?? undefined} />
          <button disabled={loading}>{registering ? "Зареєструватися" : "Увійти"}</button>
        </form>
      )}
      {error}
      {loading && <p role="status" className="count">Завантаження…</p>}
    </SignIn>
  );
}

export function ApplicationStatus({ user, loading, error, onSubmit, onRefresh, onLogout }) {
  const profile = user.profile;
  const draft = user.status === "draft";
  return (
    <SignIn title={accountTitles[user.status]}>
      {draft && <p>Після подання адміністратор розгляне заявку та визначить ваш доступ.</p>}
      {user.status === "pending" && <p>Доступ відкриється після схвалення заявки адміністратором.</p>}
      {user.status === "rejected" && user.decisionReason && (
        <p className="account-reason"><strong>Причина відхилення</strong><br />{user.decisionReason}</p>
      )}
      {profile && (
        <dl className="account-profile">
          <dt>ПІБ</dt><dd>{profile.fullName}</dd>
          <dt>Підрозділ</dt><dd>{profile.department}</dd>
          <dt>Посада</dt><dd>{profile.position}</dd>
          <dt>Логін</dt><dd>{profile.username}</dd>
        </dl>
      )}
      {error}
      <div className="account-switch">
        {draft ? (
          <button type="button" onClick={onSubmit} disabled={loading}>Подати заявку</button>
        ) : (
          <button type="button" className="secondary" onClick={onRefresh} disabled={loading}>Оновити статус</button>
        )}
        <button type="button" className="secondary" onClick={onLogout} disabled={loading}>Вийти</button>
      </div>
      {loading && <p role="status" className="count">Завантаження…</p>}
    </SignIn>
  );
}
