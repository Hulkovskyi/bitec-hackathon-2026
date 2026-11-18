export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function invalid(message = "Некоректні дані запиту") {
  throw new ApiError(400, "validation_error", message);
}
export function keys(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid("Відсутні обов’язкові або передані невідомі поля");
}
export function text(value, max = 200, empty = false) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (!empty && !value.trim())
  )
    invalid("Некоректний текст");
  return value.trim();
}
export function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    invalid("Некоректний UUID");
  return value.toLowerCase();
}
export function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalid("Некоректна календарна дата");
  return value;
}
export function choice(value, allowed) {
  if (!allowed.includes(value)) invalid();
  return value;
}
export function flag(value) {
  if (typeof value !== "boolean") invalid("Очікується boolean");
  return value;
}
export function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
export function pagination(query) {
  const parse = (value, fallback) =>
    value === undefined
      ? fallback
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? positive(Number(value))
        : invalid();
  const page = parse(query.page, 1),
    pageSize = parse(query.pageSize, 20);
  if (pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) invalid();
  return { page, pageSize };
}
