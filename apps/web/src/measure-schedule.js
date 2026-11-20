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
    return [{ key: "once", start, end, label: "Одноразовий захід" }];
  }
  const periods = halfYears(start, end);
  if (measure.recurrence !== "annual_april_may") return periods;
  return periods.filter(({ key, start, end }) => {
    const year = key.slice(0, 4);
    return key.endsWith("-H1") && start <= `${year}-05-31` && end >= `${year}-04-01`;
  });
}
