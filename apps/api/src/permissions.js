export const roleBases = ["executor", "coordinator", "leader", "analyst"];

export const permissions = [
  { key: "registry.write", label: "Створювати та редагувати заходи" },
  { key: "workflow.submit", label: "Редагувати й подавати результати та докази" },
  { key: "workflow.review", label: "Перевіряти докази, погоджувати й повертати результати" },
  { key: "workflow.assign", label: "Призначати виконавців за періодом" },
  { key: "audit.read", label: "Переглядати журнал дій" },
  { key: "audit.assignments", label: "Переглядати історію призначень" },
  { key: "program.write", label: "Редагувати паспорт програми" },
  { key: "risks.read", label: "Переглядати корупційні ризики" },
  { key: "risks.write", label: "Редагувати налаштування індикаторів ризику" },
  { key: "risks.measure", label: "Додавати вимірювання ризику" },
  { key: "analytics.read", label: "Переглядати огляд і сигнали" },
  { key: "reports.read", label: "Переглядати й вивантажувати звіти" },
];

const allKeys = permissions.map(({ key }) => key);
const defaults = {
  admin: [...allKeys, "registry.import"],
  executor: ["workflow.submit", "audit.read", "analytics.read"],
  coordinator: ["registry.write", "workflow.review", "workflow.assign", "audit.read", "audit.assignments", "risks.read", "risks.measure", "analytics.read", "reports.read"],
  leader: ["risks.read", "analytics.read", "reports.read"],
  analyst: ["risks.read", "analytics.read", "reports.read"],
};

export function rolePermissions(baseRole, stored) {
  if (baseRole === "admin" || stored == null) return defaults[baseRole] ?? [];
  const effective = new Set(JSON.parse(stored));
  if (effective.has("risks.write") || effective.has("risks.measure")) effective.add("risks.read");
  if (effective.has("audit.assignments")) effective.add("audit.read");
  return [...effective].sort();
}

export function hasPermission(user, key) {
  return (user.role === "admin" ? defaults.admin : user.permissions ?? defaults[user.role])?.includes(key) ?? false;
}

export async function loadPermissions(db, user) {
  const role = await db.prepare(`
    SELECT r.permissions_json FROM credential_accounts a
    JOIN account_roles r ON r.id=a.role_id
    WHERE a.user_id=? AND a.status='approved'
  `).get(user.id);
  return { ...user, permissions: rolePermissions(user.role, role?.permissions_json) };
}
