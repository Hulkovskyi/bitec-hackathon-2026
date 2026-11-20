export const roleNames = {
  executor: "Виконавець",
  coordinator: "Координатор",
  leader: "Керівник",
  analyst: "Аналітик",
  admin: "Адміністратор",
};

export function hasPermission(user, key, defaultValue = false) {
  return user.permissions?.includes(key) ?? defaultValue;
}
