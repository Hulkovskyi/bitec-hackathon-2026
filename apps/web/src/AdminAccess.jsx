import { useEffect, useState } from "react";
import { minimumAccountPasswordLength } from "../../../shared/account-password.mjs";
import { roleNames } from "./permissions.js";
import "./account.css";

const tabs = { accounts: "Облікові записи", roles: "Ролі", applications: "Заявки", revoked: "Відкликані доступи" };
const statuses = { pending: "На розгляді", approved: "Схвалено", rejected: "Відхилено" };
const dateTime = new Intl.DateTimeFormat("uk-UA", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Kyiv",
});

function ErrorMessage({ error }) {
  return error && <p className="error" role="alert">{error.message}</p>;
}

function EditorActions({ busy, incomplete, onCancel, label }) {
  return (
    <div className="account-switch">
      <button disabled={busy || incomplete}>{label}</button>
      <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Скасувати</button>
    </div>
  );
}

function AccessAssignment({ account, roles, departments, label, busy, error, onSave, onCancel, children }) {
  const [roleId, setRoleId] = useState(account?.roleId ?? "");
  const [departmentIds, setDepartmentIds] = useState(account?.departmentIds ?? []);
  const adminRole = roles.find(({ id }) => id === roleId)?.baseRole === "admin";

  function submit(event) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    onSave({ ...fields, roleId, departmentIds: adminRole ? [] : departmentIds });
  }

  return (
    <form className="access-editor" onSubmit={submit} autoComplete="off">
      {children}
      <label>
        Роль
        <select value={roleId} onChange={(event) => setRoleId(event.target.value)} required disabled={busy}>
          <option value="">Оберіть роль</option>
          {roles.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      {adminRole ? <p className="count">Доступ до всіх програм і підрозділів.</p> : (
        <fieldset disabled={busy}>
          <legend>Підрозділи доступу</legend>
          {departments.length > 0 ? (
            <div className="access-checklist access-departments">
              {departments.map(({ id, title, programCode, programTitle }) => (
                <label key={id}>
                  <input type="checkbox" checked={departmentIds.includes(id)} onChange={(event) => {
                    const checked = event.target.checked;
                    setDepartmentIds((current) => checked ? [...current, id] : current.filter((value) => value !== id));
                  }} />
                  <span>{title}<small>{programCode} · {programTitle}</small></span>
                </label>
              ))}
            </div>
          ) : <p className="count">У програмах ще немає підрозділів.</p>}
          {!departmentIds.length && <p className="count">Дані програм будуть доступні після призначення підрозділу.</p>}
        </fieldset>
      )}
      <ErrorMessage error={error} />
      <EditorActions busy={busy} incomplete={!roleId} onCancel={onCancel} label={label} />
    </form>
  );
}

function AccountProfileFields({ account, managers, busy }) {
  const primaryAdministrator = account?.roleId === "admin" && account.username === "admin";
  const availableManagers = managers.filter(({ id }) => id !== account?.id);
  const currentManagerMissing = account?.managerId && !availableManagers.some(({ id }) => id === account.managerId);
  return (
    <>
      <label>ПІБ<input name="fullName" defaultValue={account?.fullName} maxLength={160} required disabled={busy} /></label>
      <label>Підрозділ<input name="department" defaultValue={account?.department} maxLength={160} required disabled={busy} /></label>
      <label>Посада<input name="position" defaultValue={account?.position} maxLength={160} required disabled={busy} /></label>
      <label>
        Керівник
        <select name="managerId" defaultValue={account?.managerId ?? ""} required={!account} disabled={busy}>
          <option value="">{account ? "Без керівника" : "Оберіть керівника"}</option>
          {currentManagerMissing && <option value={account.managerId}>{account.managerName}</option>}
          {availableManagers.map(({ id, fullName, username }) => (
            <option key={id} value={id}>{fullName} · {username}</option>
          ))}
        </select>
      </label>
      <label>
        Логін
        <input name="username" defaultValue={account?.username} autoCapitalize="none" spellCheck={false}
          readOnly={primaryAdministrator} minLength={3} maxLength={64} required disabled={busy} />
      </label>
    </>
  );
}

function AccountProfileEditor({ account, managers, busy, error, onSave, onCancel }) {
  return (
    <form className="access-editor" aria-label="Редагування профілю" onSubmit={(event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      onSave({ ...fields, managerId: fields.managerId || null });
    }}>
      <AccountProfileFields account={account} managers={managers} busy={busy} />
      <ErrorMessage error={error} />
      <EditorActions busy={busy} onCancel={onCancel} label="Зберегти профіль" />
    </form>
  );
}

function RemovalConfirmation({ busy, error, onCancel, onConfirm, label, children }) {
  return (
    <form className="access-editor" onSubmit={(event) => {
      event.preventDefault();
      onConfirm();
    }}>
      <p className="count">{children}</p>
      <ErrorMessage error={error} />
      <EditorActions busy={busy} onCancel={onCancel} label={label} />
    </form>
  );
}

function AccountCreation({ managers, roles, departments, onSave, onCancel, busy, error }) {
  return (
    <div className="access-entry">
      <h3>Новий обліковий запис</h3>
      <AccessAssignment roles={roles} departments={departments} label="Створити обліковий запис"
        onSave={onSave} onCancel={onCancel} busy={busy} error={error}>
        <AccountProfileFields managers={managers} busy={busy} />
        <label>
          Пароль
          <input name="password" type="password" autoComplete="new-password" aria-describedby="new-account-password-help"
            minLength={minimumAccountPasswordLength} maxLength={128} required disabled={busy} />
        </label>
        <p id="new-account-password-help" className="count">Від {minimumAccountPasswordLength} до 128 символів</p>
      </AccessAssignment>
    </div>
  );
}

function RejectionEditor({ onSave, onCancel, busy, error }) {
  return (
    <form className="access-editor" onSubmit={(event) => {
      event.preventDefault();
      onSave(new FormData(event.currentTarget).get("reason"));
    }}>
      <label>
        Причина відхилення
        <textarea name="reason" maxLength={1000} required disabled={busy} />
      </label>
      <ErrorMessage error={error} />
      <EditorActions busy={busy} onCancel={onCancel} label="Відхилити заявку" />
    </form>
  );
}

function RoleEditor({ role, permissionOptions, onSave, onCancel, busy, error }) {
  return (
    <form className="access-editor" onSubmit={(event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      onSave({
        name: values.get("name"),
        ...(role ? {} : { baseRole: values.get("baseRole") }),
        permissions: values.getAll("permission"),
      });
    }}>
      <label>Назва ролі<input name="name" defaultValue={role?.name} maxLength={100} required disabled={busy} /></label>
      {!role && (
        <label>
          Базова роль
          <select name="baseRole" defaultValue="" required disabled={busy}>
            <option value="">Оберіть базову роль</option>
            {Object.entries(roleNames).filter(([base]) => base !== "admin").map(([base, name]) => (
              <option key={base} value={base}>{name}</option>
            ))}
          </select>
        </label>
      )}
      <fieldset disabled={busy}>
        <legend>Дозволи</legend>
        <p className="count">Редагування й вимірювання ризиків включають їх перегляд. Історія призначень включає перегляд журналу дій.</p>
        <div className="access-checklist">
          {permissionOptions.map(({ key, label }) => (
            <label key={key}>
              <input type="checkbox" name="permission" value={key} defaultChecked={role?.permissions.includes(key)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorMessage error={error} />
      <EditorActions busy={busy} onCancel={onCancel} label={role ? "Зберегти роль" : "Створити роль"} />
    </form>
  );
}

function AccountList({ accounts, managers, roles, departments, applications, revoked, currentUserId, editor, onEdit, onSave, busy, error }) {
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const departmentsById = new Map(departments.map((department) => [department.id, department]));
  if (accounts.length === 0) {
    return <p className="empty">{applications ? "За цим фільтром заявок немає."
      : revoked ? "Немає відкликаних доступів." : "Немає схвалених облікових записів."}</p>;
  }
  return (
    <ul className="access-items" role="list">
      {accounts.map((account) => {
        const role = rolesById.get(account.roleId);
        const editType = editor?.id === account.id ? editor.type : null;
        const applicationPath = `/admin/applications/${account.id}/decision`;
        const accountPath = `/admin/accounts/${account.id}`;
        const allowedToRemove = account.id !== currentUserId
          && !(account.roleId === "admin" && account.username === "admin");
        const scopeLabels = account.departmentIds.map((id) => departmentsById.get(id))
          .filter(Boolean).map(({ programCode, title }) => `${programCode} · ${title}`);
        return (
          <li key={account.id} className="access-entry">
            <header>
              <div>
                <h3>{account.fullName}</h3>
                <p className="count">{account.username} · {account.position} · {account.department}</p>
              </div>
              {applications && <span className="access-status" data-status={account.status}>{statuses[account.status]}</span>}
            </header>
            {applications && account.submittedAt && <p className="count">Подано <time dateTime={account.submittedAt}>{dateTime.format(new Date(account.submittedAt))}</time></p>}
            {account.decisionReason && <p className="account-reason">{account.decisionReason}</p>}
            {role && (
              <dl className="account-profile">
                <dt>Роль</dt><dd>{role.name}</dd>
                <dt>Керівник</dt><dd>{account.managerName ?? "—"}</dd>
                <dt>Доступ</dt><dd>{role.baseRole === "admin" ? "Усі програми й підрозділи" : scopeLabels.join(", ") || "—"}</dd>
              </dl>
            )}
            {editType === "profile" ? (
              <AccountProfileEditor account={account} managers={managers} onCancel={() => onEdit(null)} busy={busy} error={error}
                onSave={(profile) => onSave(accountPath + "/profile", "PATCH", profile, "Дані профілю оновлено.")} />
            ) : editType === "revoke" ? (
              <RemovalConfirmation onCancel={() => onEdit(null)} busy={busy} error={error} label="Підтвердити відкликання"
                onConfirm={() => onSave(accountPath, "DELETE", undefined, "Доступ відкликано.")}>
                Вхід і чинні сеанси буде вимкнено. Історія дій збережеться.
              </RemovalConfirmation>
            ) : editType === "reject" ? (
              <RejectionEditor onCancel={() => onEdit(null)} busy={busy} error={error}
                onSave={(reason) => onSave(applicationPath, "POST", { decision: "reject", reason }, "Заявку відхилено.")} />
            ) : editType ? (
              <AccessAssignment key={editType} account={editType === "assign" ? account : null}
                roles={roles} departments={departments} label={editType === "approve" ? "Схвалити заявку"
                  : editType === "restore" ? "Відновити доступ" : "Зберегти доступ"}
                onCancel={() => onEdit(null)} busy={busy} error={error}
                onSave={(assignment) => {
                  if (editType === "approve") {
                    onSave(applicationPath, "POST", { decision: "approve", ...assignment }, "Заявку схвалено.");
                  } else if (editType === "restore") {
                    onSave(accountPath + "/restore", "POST", assignment, "Доступ відновлено.");
                  } else {
                    onSave(accountPath, "PATCH", assignment, "Доступ оновлено.");
                  }
                }} />
            ) : (
              <div className="account-switch">
                {applications && account.status === "pending" && (
                  <>
                    <button type="button" onClick={() => onEdit({ id: account.id, type: "approve" })} disabled={busy}>Схвалити</button>
                    <button type="button" className="secondary" onClick={() => onEdit({ id: account.id, type: "reject" })} disabled={busy}>Відхилити</button>
                  </>
                )}
                <button type="button" className="secondary" onClick={() => onEdit({ id: account.id, type: "profile" })}
                  disabled={busy}>Редагувати профіль</button>
                {!applications && !revoked && allowedToRemove && (
                  <>
                    <button type="button" className="secondary" onClick={() => onEdit({ id: account.id, type: "assign" })}
                      disabled={busy}>Змінити роль і доступ</button>
                    <button type="button" className="secondary" onClick={() => onEdit({ id: account.id, type: "revoke" })}
                      disabled={busy}>Відкликати доступ</button>
                  </>
                )}
                {revoked && (
                  <button type="button" className="secondary" onClick={() => onEdit({ id: account.id, type: "restore" })}
                    disabled={busy}>Відновити доступ</button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RoleList({ roles, permissions, editor, onEdit, onSave, busy, error }) {
  const labelByKey = new Map(permissions.map(({ key, label }) => [key, label]));
  labelByKey.set("registry.import", "Імпортувати реєстр");
  return (
    <>
      {editor?.type === "create" ? (
        <div className="access-entry access-new-role">
          <h3>Нова роль</h3>
          <RoleEditor permissionOptions={permissions} onCancel={() => onEdit(null)} busy={busy} error={error}
            onSave={(value) => onSave("/admin/roles", "POST", value, "Роль створено.")} />
        </div>
      ) : <button type="button" onClick={() => onEdit({ type: "create" })} disabled={busy}>Створити роль</button>}
      <ul className="access-items" role="list">
        {roles.map((role) => (
          <li key={role.id} className="access-entry">
            <header>
              <div>
                <h3>{role.name}</h3>
                <p className="count">{role.system ? "Системна роль" : `Базова роль · ${roleNames[role.baseRole]}`}</p>
              </div>
              {role.editable && editor?.id !== role.id && (
                <div className="account-switch">
                  <button type="button" className="secondary" onClick={() => onEdit({ id: role.id, type: "edit" })}
                    aria-label={`Редагувати роль ${role.name}`} disabled={busy}>Редагувати</button>
                  {!role.system && (
                    <button type="button" className="secondary" onClick={() => onEdit({ id: role.id, type: "delete" })}
                      aria-label={`Видалити роль ${role.name}`} disabled={busy}>Видалити</button>
                  )}
                </div>
              )}
            </header>
            {editor?.id === role.id && editor.type === "delete" ? (
              <RemovalConfirmation onCancel={() => onEdit(null)} busy={busy} error={error} label="Підтвердити видалення"
                onConfirm={() => onSave(`/admin/roles/${role.id}`, "DELETE", undefined, "Роль видалено.")}>
                Видалити роль «{role.name}»?
              </RemovalConfirmation>
            ) : editor?.id === role.id ? (
              <RoleEditor role={role} permissionOptions={permissions} onCancel={() => onEdit(null)} busy={busy} error={error}
                onSave={(value) => onSave(`/admin/roles/${role.id}`, "PATCH", value, "Роль оновлено.")} />
            ) : (
              <details className="access-permissions">
                <summary>Дозволи ({role.permissions.length})</summary>
                {role.permissions.length > 0 ? (
                  <ul>{role.permissions.map((key) => <li key={key}>{labelByKey.get(key) ?? key}</li>)}</ul>
                ) : <p className="count">Додаткових дозволів немає.</p>}
              </details>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function AdminAccess({ api, currentUserId }) {
  const [tab, setTab] = useState("accounts");
  const [filter, setFilter] = useState("pending");
  const [editor, setEditor] = useState(null);
  const [data, setData] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api("/admin/access", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error); });
    return () => controller.abort();
  }, [api, attempt]);

  function reload() {
    setLoadError(null);
    setData(null);
    setAttempt((value) => value + 1);
  }

  function edit(next) {
    setEditor(next);
    setSaveError(null);
    setNotice("");
  }

  async function save(path, method, value, message) {
    setBusy(true);
    setSaveError(null);
    try {
      await api(path, { method, body: JSON.stringify(value) });
      setEditor(null);
      setNotice(message);
      reload();
    } catch (error) {
      setSaveError(error);
    } finally {
      setBusy(false);
    }
  }

  const applications = tab === "applications";
  const revoked = tab === "revoked";
  const accountStatus = applications ? filter : revoked ? "revoked" : "approved";
  const accounts = data?.accounts.filter(({ status }) => status === accountStatus);
  const managers = data?.accounts.filter(({ status }) => status === "approved");
  const editProps = { editor, onEdit: edit, onSave: save, busy, error: saveError };
  return (
    <section className="access-management" aria-labelledby="access-title">
      <h1 id="access-title">Користувачі й ролі</h1>
      <div className="account-switch" role="group" aria-label="Керування доступом">
        {Object.entries(tabs).map(([key, label]) => (
          <button key={key} type="button" className="secondary" aria-pressed={tab === key} disabled={busy}
            onClick={() => { setTab(key); edit(null); }}>{label}</button>
        ))}
      </div>
      {notice && <p className="access-notice" role="status">{notice}</p>}
      {!data && !loadError && <p role="status">Завантажуємо дані доступу…</p>}
      {loadError && (
        <>
          <ErrorMessage error={loadError} />
          <button type="button" className="secondary" onClick={reload}>Повторити</button>
        </>
      )}
      {data && (tab === "roles" ? (
        <RoleList roles={data.roles} permissions={data.permissions} {...editProps} />
      ) : (
        <>
          {applications && (
            <div className="access-filter-bar">
              <label className="access-filter">
                Статус заявки
                <select value={filter} onChange={(event) => { setFilter(event.target.value); edit(null); }} disabled={busy}>
                  {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <button type="button" className="secondary" onClick={() => { setNotice(""); reload(); }}
                disabled={busy || Boolean(editor)}>Оновити заявки</button>
            </div>
          )}
          {tab === "accounts" && (editor?.type === "createAccount" ? (
            <AccountCreation managers={managers} roles={data.roles} departments={data.departments}
              onSave={(value) => save("/admin/accounts", "POST", value, "Обліковий запис створено.")}
              onCancel={() => edit(null)} busy={busy} error={saveError} />
          ) : (
            <button type="button" onClick={() => edit({ type: "createAccount" })} disabled={busy}>
              Додати обліковий запис
            </button>
          ))}
          <AccountList accounts={accounts} managers={managers}
            roles={data.roles} departments={data.departments} applications={applications} revoked={revoked}
            currentUserId={currentUserId} {...editProps} />
        </>
      ))}
    </section>
  );
}
