export const executionStateLabels = {
  completed: "Виконано",
  partial: "Виконано частково",
  not_completed: "Не виконано",
  not_due: "Строк виконання не настав",
  not_approved: "Не виконано / результат не погоджено",
};

export function reportFilename({ period }) {
  return `half-year-report-${period.key}.csv`;
}

function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))) {
    text = "'" + text;
  }
  return '"' + text.replaceAll('"', '""') + '"';
}

function yesNo(value) {
  if (value == null) return "";
  return value ? "Так" : "Ні";
}

export function formatReportCsv(report) {
  const header = [
    "ID заходу", "Розділ", "Підрозділ", "Код", "Захід", "Плановий строк",
    "Фактичний строк виконання", "Стан виконання",
    "Опис результату виконання заходу або пояснення причин невиконання",
    "Дата результату", "Версія результату", "Перенесено з попереднього періоду",
    "Одиниця виміру", "Базове значення", "Цільове значення", "Фактичне значення", "Ціль досягнуто",
  ];
  const records = report.sections.flatMap(({ title, rows }) =>
    rows.map((row) => [
      row.measureId, title, row.departmentTitle, row.code, row.title, row.plannedDate,
      row.actualDate, executionStateLabels[row.executionState], row.resultDescription,
      row.resultDate, row.resultRevision, yesNo(row.carriedForward),
      row.indicator.unit, row.indicator.baseline, row.indicator.target, row.indicator.actual,
      yesNo(row.indicator.targetReached),
    ]),
  );
  return "\uFEFF" + [header, ...records].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
