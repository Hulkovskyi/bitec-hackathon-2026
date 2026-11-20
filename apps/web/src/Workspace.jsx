import { hasPermission } from "./permissions.js";

const glyphs = {
  brand: <><path d="M12 3 20 6v5c0 5-3.4 8.1-8 10-4.6-1.9-8-5-8-10V6Z" /><path d="m8.6 11.9 2.3 2.3 4.5-4.5" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  registry: <><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 5V3h6v2M9 11h6m-6 4h6" /></>,
  signals: <><path d="M10.3 4.8 3 18a1.6 1.6 0 0 0 1.4 2.3h15.2A1.6 1.6 0 0 0 21 18l-7.3-13.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3.5h.01" /></>,
  approvals: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  report: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 16v-4m3 4V8m3 8v-6" /></>,
  passport: <><path d="M4 5h6a2 2 0 0 1 2 2v13a3 3 0 0 0-3-3H4Zm16 0h-6a2 2 0 0 0-2 2v13a3 3 0 0 1 3-3h5Z" /><path d="M7 9h2m6 0h2" /></>,
  corruptionRisks: <><path d="M12 3 20 6v5c0 5-3.4 8.1-8 10-4.6-1.9-8-5-8-10V6Z" /><path d="M12 8v4m0 3h.01" /></>,
  access: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m2-14a3 3 0 0 1 0 6m4 8v-2a4 4 0 0 0-3-4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
};

export function Glyph({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {glyphs[name]}
    </svg>
  );
}

function Brand() {
  return (
    <div className="workspace-brand">
      <span className="workspace-brand-mark"><Glyph name="brand" size={23} /></span>
      <span>Цифровий <br />антикорупційний <br />монітор</span>
    </div>
  );
}

const navigation = [
  { key: "dashboard", label: "Огляд", visible: (user) => hasPermission(user, "analytics.read", true) },
  { key: "registry", label: "Реєстр", visible: () => true },
  { key: "passport", label: "Паспорт програми", visible: () => true },
  { key: "corruptionRisks", label: "Корупційні ризики", visible: (user) => hasPermission(user, "risks.read", user.role !== "executor") },
  { key: "signals", label: "Сигнали", visible: (user) => user.role !== "executor" && hasPermission(user, "analytics.read", true) },
  { key: "approvals", label: "Погодження", visible: (user) => hasPermission(user, "workflow.review", user.role === "coordinator") },
  { key: "report", label: "Звіти", visible: (user) => hasPermission(user, "reports.read", user.role !== "executor") },
];

export function SignIn({ title, demo, children }) {
  return (
    <main className="sign-in">
      <div className="sign-in-layout">
        <div className="sign-in-brand">
          <Brand />
          <span className="sign-in-team">Digital Anti-Corruption Monitor<br />ITT-Zholudi</span>
        </div>
        <section className="sign-in-panel">
          {demo && <span className="demo">Синтетичні дані</span>}
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

export function Workspace({
  user, role, sessionForm, logout, busy, programPicker, activeView, onNavigate,
  programNavigation = true, manageAccess = false, importRegistry = false, demo = false, children,
}) {
  const initials = user.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("");
  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-content">До вмісту</a>
      <aside className="workspace-sidebar">
        <div className="workspace-brand-row">
          <Brand />
          {demo && <span className="demo workspace-demo-mobile">Синтетичні дані</span>}
        </div>
        {onNavigate && (
          <nav className="workspace-nav" aria-label="Подання програми">
            {programNavigation && navigation.filter(({ visible }) => visible(user)).map(({ key, label }) => (
              <button key={key} type="button" aria-current={activeView === key ? "page" : undefined}
                onClick={() => onNavigate(key)}>
                <Glyph name={key} />
                <span>{label}</span>
              </button>
            ))}
            {manageAccess && (
              <button type="button" aria-current={activeView === "access" ? "page" : undefined}
                onClick={() => onNavigate("access")}>
                <Glyph name="access" />
                <span>Користувачі й ролі</span>
              </button>
            )}
            {importRegistry && (
              <button type="button" aria-current={activeView === "registryImport" ? "page" : undefined}
                onClick={() => onNavigate("registryImport")}>
                <Glyph name="registry" />
                <span>Імпорт реєстру</span>
              </button>
            )}
          </nav>
        )}
        <span className="workspace-team">ITT-Zholudi</span>
      </aside>
      <div className="workspace-main">
        <header className="workspace-topbar">
          {programPicker}
          <div className="workspace-tools">
            {demo && <span className="demo">Синтетичні дані</span>}
            <details className="workspace-account">
              <summary aria-label={`${demo ? "Демосесія" : "Обліковий запис"} · ${user.displayName} · ${role}`}>
                <span className="account-avatar" aria-hidden="true">{initials}</span>
                <span className="account-name"><strong>{user.displayName}</strong><span>{role}</span></span>
                <Glyph name="chevron" size={16} />
              </summary>
              <div className="account-menu">
                {sessionForm}
                <button type="button" className="secondary" onClick={logout} disabled={busy}>Вийти</button>
              </div>
            </details>
          </div>
        </header>
        <main id="workspace-content" className="workspace-content">{children}</main>
      </div>
    </div>
  );
}
