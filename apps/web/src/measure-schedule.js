import { halfYears } from "./periods.js";

export const recurrenceLabels = {
  weekly: "Щотижня",
  monthly: "Щомісяця",
  quarterly: "Щокварталу",
  annual_april_may: "Щороку, квітень–травень",
};

export function measurePeriods(measure, program) {
  const start = measure.effectiveFrom > program.periodStart ? measure.effectiveFrom : program.periodStart;
  const end = program.periodEnd;
  if (measure.scheduleType === "one_time") {
    return [{ key: "once", start, end, deadline: measure.plannedDate, label: "Одноразовий захід" }];
  }
  const periods = halfYears(start, end);
  if (measure.recurrence !== "annual_april_may") {
    return periods.map((period) => ({ ...period, deadline: period.end }));
  }
  return periods.flatMap((period) => {
    const year = period.key.slice(0, 4);
    const mayEnd = `${year}-05-31`;
    if (!period.key.endsWith("-H1") || period.start > mayEnd || period.end < `${year}-04-01`) return [];
    return [{ ...period, deadline: period.end < mayEnd ? period.end : mayEnd }];
  });
}
