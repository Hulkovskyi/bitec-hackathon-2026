import { useEffect, useState } from "react";
import {
  executionStateLabels,
  formatReportCsv,
  reportFilename,
} from "../../../shared/half-year-report.mjs";
import { halfYears, kyivToday } from "./periods.js";
import "./reports.css";

const reportStates = ["completed", "partial", "not_completed", "not_due", "not_approved"];
const ukDateTime = new Intl.DateTimeFormat("uk-UA", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Kyiv",
});
const pluralRules = new Intl.PluralRules("uk-UA");
const ukPercent = new Intl.NumberFormat("uk-UA", {
  style: "percent",
  maximumFractionDigits: 1,
});

function dateLabel(value) {
  if (!value) return "—";
  if (value.length === 10) return value.split("-").reverse().join(".");
  return ukDateTime.format(new Date(value));
}

function downloadReport(report) {
  const csv = formatReportCsv(report);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = reportFilename(report);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function ReportBrief({ summary, onOpenMeasure }) {
  return (
    <section className="report-brief" aria-labelledby="report-brief-title">
      <h2 id="report-brief-title">Аналітична довідка</h2>
      <p>
        {summary.completionRate == null
          ? "Немає даних"
          : `Повністю виконано ${summary.counts.completed} з ${summary.total} ${pluralRules.select(summary.total) === "one" ? "заходу" : "заходів"} (${ukPercent.format(summary.completionRate)}).`}
      </p>
      <dl className="report-totals">
        {reportStates.map((state) => (
          <div key={state}>
            <dt>{executionStateLabels[state]}</dt>
            <dd>{summary.counts[state]}</dd>
          </div>
        ))}
      </dl>
      {summary.problemRows.length > 0 && (
        <>
          <h3>Заходи, що потребують уваги</h3>
          <ul className="report-problems">
            {summary.problemRows.map((row) => (
              <li key={row.measureId}>
                <div>
                  <button type="button" className="link" onClick={() => onOpenMeasure(row)}>
                    {row.code} · {row.title}
                  </button>
                  <small>{row.departmentTitle}</small>
                </div>
                <span>
                  {executionStateLabels[row.executionState]}
                  {row.targetReached === false && " · Цілі індикатора не досягнуто"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ReportSection({ section }) {
  const headingId = `report-section-${section.code}`;
  return (
    <section className="report-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{section.title}</h2>
      {section.rows.length === 0 ? (
        <p className="count">У цьому розділі немає заходів за обраний період.</p>
      ) : (
        <div
          className="table-scroll report-table"
          role="region"
          aria-labelledby={headingId}
          tabIndex={0}
        >
          <table role="table" aria-labelledby={headingId}>
            <colgroup>
              <col className="report-col-measure" />
              <col className="report-col-date" />
              <col className="report-col-state" />
              <col />
            </colgroup>
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Захід і підрозділ</th>
                <th role="columnheader" scope="col">Фактичний строк виконання</th>
                <th role="columnheader" scope="col">Стан виконання</th>
                <th role="columnheader" scope="col">Опис результату виконання заходу або пояснення причин невиконання</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {section.rows.map((row) => (
                <tr key={row.measureId} role="row">
                  <td role="cell">
                    <strong>{row.code} · {row.title}</strong>
                    <small>{row.departmentTitle}</small>
                  </td>
                  <td role="cell">
                    <span className="report-cell-label" aria-hidden="true">Фактичний строк</span>
                    {dateLabel(row.actualDate)}
                    {row.carriedForward && <small>Перенесено з попереднього періоду</small>}
                  </td>
                  <td role="cell">
                    <span className="report-cell-label" aria-hidden="true">Стан виконання</span>
                    {executionStateLabels[row.executionState]}
                  </td>
                  <td role="cell" className="report-description">
                    <span className="report-cell-label" aria-hidden="true">Опис результату або причина невиконання</span>
                    {row.resultDescription ?? "—"}
                    {row.indicator?.actual != null && (
                      <small>
                        Фактичне значення {row.indicator.actual} {row.indicator.unit}
                        {" · "}Ціль {row.indicator.target} {row.indicator.unit}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function HalfYearReport({ program, api, selectedPeriod, onPeriodChange, onOpenMeasure }) {
  const periods = halfYears(program.periodStart, program.periodEnd);
  const today = kyivToday();
  const periodKey = selectedPeriod ?? periods.findLast(({ start }) => start <= today)?.key ?? periods[0]?.key;
  const [response, setResponse] = useState(null);
  const [reload, setReload] = useState(0);
  const current = response?.periodKey === periodKey && response?.reload === reload
    ? response : null;
  const report = current?.report;

  useEffect(() => {
    if (!periodKey) return;
    const controller = new AbortController();
    const [year, half] = periodKey.split("-H");
    const query = new URLSearchParams({ programId: program.id, year, half, format: "json" });
    api("/reports/half-year?" + query, { signal: controller.signal })
      .then((report) => {
        if (!controller.signal.aborted) setResponse({ periodKey, reload, report });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResponse({ periodKey, reload, error });
      });
    return () => controller.abort();
  }, [api, periodKey, program.id, reload]);

  const halfLabel = (key) => periods.find((period) => period.key === key)?.label;
  const dataAsOf = dateLabel(report?.dataAsOf);
  const generatedAt = dateLabel(report?.generatedAt);
  return (
    <section className="report" aria-labelledby="report-title">
      <div className="report-toolbar">
        <h1 id="report-title">Піврічний звіт</h1>
        <label>
          Звітний період
          <select
            value={periodKey ?? ""}
            onChange={(event) => {
              if (event.target.value === periodKey) return;
              setResponse(null);
              onPeriodChange(event.target.value);
            }}
            disabled={!periods.length}
          >
            {periods.length === 0 && <option value="">Немає доступних періодів</option>}
            {periods.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <div className="report-actions">
          <button type="button" className="secondary" disabled={!report} onClick={() => window.print()}>
            Друкувати
          </button>
          <button type="button" disabled={!report} onClick={() => downloadReport(report)}>
            Завантажити CSV
          </button>
        </div>
      </div>
      {periodKey && !current && <p role="status">Завантаження звіту…</p>}
      {current?.error && (
        <div className="report-load-error">
          <p role="alert">{current.error.message}</p>
          <button type="button" className="secondary" onClick={() => setReload((value) => value + 1)}>
            Повторити завантаження
          </button>
        </div>
      )}
      {report && (
        <div className="report-document">
          <h1 className="report-print-title">Піврічний звіт · {report.program.title}</h1>
          <div className="report-meta">
            <p>
              <strong>{halfLabel(report.period.key)}</strong>
              <span>{dateLabel(report.period.start)} — {dateLabel(report.period.end)}</span>
            </p>
            <p>
              <strong>Результати враховано до {dateLabel(report.period.cutoff)}</strong>
              {dataAsOf !== generatedAt && <span>Дані станом на {dataAsOf}</span>}
              <span>Сформовано {generatedAt}</span>
            </p>
          </div>
          {report.sections.map((section) => <ReportSection key={section.code} section={section} />)}
          <ReportBrief summary={report.summary} onOpenMeasure={onOpenMeasure} />
        </div>
      )}
    </section>
  );
}
