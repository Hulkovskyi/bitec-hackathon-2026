import assert from "node:assert/strict";
import test from "node:test";
import { kyivDate } from "../src/registry.js";
import { evaluateRiskFlags, startedDeadlines } from "../src/risk-flags.js";

const schedule = (id, overrides = {}) => ({
  id,
  program_id: "demo",
  department_id: "demo-a",
  schedule_type: "one_time",
  period_start: "2026-01-01",
  period_end: "2026-12-31",
  effective_from: "2026-01-01",
  planned_date: "2026-11-10",
  active: 1,
  baseline: 0,
  target: 100,
  direction: "increase",
  ...overrides,
});

function result(measureId, overrides = {}) {
  const {
    period_key = "once",
    revision = 1,
    ...fields
  } = overrides;
  return {
    id: `${measureId}/${period_key}/${revision}`,
    measure_id: measureId,
    period_key,
    revision,
    status: "approved",
    outcome: "completed",
    measured_value: 100,
    ...fields,
  };
}

function entry(plan, revisions = [], evidenceOverrides = {}) {
  return {
    plan,
    revisions,
    evidenceByResult: new Map(revisions.map((revision) => [
      revision.id,
      evidenceOverrides[revision.id] ?? [{ intact: true }],
    ])),
  };
}

const on = (date) => ({ today: () => date });
const codes = ({ items }) => items.map(({ measureId, periodKey, ruleCode }) =>
  [measureId, periodKey, ruleCode].join(":")
);

test("A–G produce the contract signals for 17 November with out-of-scope X excluded", () => {
  const e1 = result("E", { period_key: "2026-H1" });
  const g1 = result("G", { status: "submitted", outcome: "not_completed", measured_value: null });
  const fixtures = [
    entry(schedule("A"), [result("A")]),
    entry(schedule("B"), [result("B", { outcome: "partial", measured_value: 50 })]),
    entry(schedule("C", { planned_date: "2026-11-20" }), [result("C", { status: "draft" })]),
    entry(schedule("D", { planned_date: "2026-11-17" })),
    entry(schedule("E", { schedule_type: "continuous", planned_date: null }), [e1]),
    entry(schedule("F", { baseline: 10, target: 20 }), [result("F", { measured_value: 10 })]),
    entry(schedule("G", { planned_date: "2026-12-01" }), [g1], { [g1.id]: [] }),
    entry(schedule("X", { program_id: "other", department_id: "other-a" })),
  ];
  const visible = fixtures.filter(({ plan }) => plan.program_id === "demo" && plan.department_id === "demo-a");
  const flags = evaluateRiskFlags(visible, on("2026-11-17"));

  assert.deepEqual(codes(flags), [
    "B:once:overdue",
    "B:once:target_not_met",
    "C:once:due_soon",
    "D:once:due_soon",
    "F:once:target_not_met",
    "F:once:closed_without_improvement",
    "G:once:missing_evidence",
  ]);
  assert.deepEqual(flags.counts, { overdue: 1, overdueMeasures: 1 });
  assert.deepEqual(flags.items[0].sourceValues, { deadline: "2026-11-10", today: "2026-11-17", daysOverdue: 7 });
  assert.deepEqual(flags.items.at(-1).sourceValues, { revision: 1, issue: "no_current_evidence" });
  assert.ok(flags.items.every(({ explanation, suggestedAction }) => explanation && suggestedAction));
});

test("due-soon includes day 7 and today, and inactive plans retain overdue only", () => {
  const plan = schedule("A");
  for (const [date, ruleCode, days] of [
    ["2026-11-02", null, null],
    ["2026-11-03", "due_soon", 7],
    ["2026-11-10", "due_soon", 0],
    ["2026-11-11", "overdue", 1],
  ]) {
    const { items } = evaluateRiskFlags([entry(plan)], on(date));
    assert.equal(items.length, ruleCode ? 1 : 0, date);
    if (ruleCode) {
      assert.equal(items[0].ruleCode, ruleCode);
      assert.equal(items[0].sourceValues[ruleCode === "overdue" ? "daysOverdue" : "daysRemaining"], days);
    }
  }

  const disabled = entry({ ...plan, active: 0 }, [result("A", { outcome: "not_completed", measured_value: null })]);
  assert.deepEqual(codes(evaluateRiskFlags([disabled], on("2026-11-10"))), []);
  assert.deepEqual(codes(evaluateRiskFlags([disabled], on("2026-11-11"))), ["A:once:overdue"]);
  const future = entry(schedule("FUTURE", { effective_from: "2026-11-07" }));
  assert.deepEqual(codes(evaluateRiskFlags([future], on("2026-11-03"))), []);
});

test("W4 preserves H1 at Kyiv midnight and starts H2 without an overdue flag", () => {
  const plan = schedule("A", { schedule_type: "continuous", planned_date: null });
  const at = (instant) => ({ today: () => kyivDate(new Date(instant)) });
  const before = evaluateRiskFlags([entry(plan)], at("2026-06-30T20:59:59Z"));
  const after = evaluateRiskFlags([entry(plan)], at("2026-06-30T21:00:00Z"));
  assert.equal(before.asOf, "2026-06-30");
  assert.deepEqual(codes(before), ["A:2026-H1:due_soon"]);
  assert.equal(after.asOf, "2026-07-01");
  assert.deepEqual(codes(after), ["A:2026-H1:overdue"]);
  assert.deepEqual(startedDeadlines(plan, after.asOf), [
    { periodKey: "2026-H1", deadline: "2026-06-30" },
    { periodKey: "2026-H2", deadline: "2026-12-31" },
  ]);
});

test("W5 generates no H1 for a measure effective on 15 July and clips the last deadline", () => {
  const plan = schedule("A", {
    schedule_type: "continuous",
    planned_date: null,
    effective_from: "2026-07-15",
    period_end: "2026-09-10",
  });

  assert.deepEqual(startedDeadlines(plan, "2026-07-14"), []);
  assert.deepEqual(startedDeadlines(plan, "2026-07-15"), [{ periodKey: "2026-H2", deadline: "2026-09-10" }]);
  const { items } = evaluateRiskFlags([entry(plan)], on("2026-09-11"));
  assert.deepEqual(items.map(({ periodKey, sourceValues }) => [periodKey, sourceValues.daysOverdue]), [["2026-H2", 1]]);
});

test("W8 counts distinct overdue periods and measures and respects an allowed-period subset", () => {
  const plan = schedule("A", { schedule_type: "continuous", planned_date: null });
  const when = on("2027-01-01");
  const both = evaluateRiskFlags([entry(plan)], when);
  assert.deepEqual(codes(both), ["A:2026-H1:overdue", "A:2026-H2:overdue"]);
  assert.deepEqual(both.counts, { overdue: 2, overdueMeasures: 1 });

  const onlyH1 = { ...entry(plan), allowedPeriodKeys: new Set(["2026-H1"]) };
  const visible = evaluateRiskFlags([onlyH1], when);
  assert.deepEqual(codes(visible), ["A:2026-H1:overdue"]);
  assert.deepEqual(visible.counts, { overdue: 1, overdueMeasures: 1 });

  const h2 = result("A", { period_key: "2026-H2" });
  const withCompletedH2 = evaluateRiskFlags([entry(plan, [h2])], when);
  assert.deepEqual(codes(withCompletedH2), ["A:2026-H1:overdue"]);
  assert.deepEqual(withCompletedH2.counts, { overdue: 1, overdueMeasures: 1 });
});

test("the newest approved result determines completion and indicator status even with a newer draft", () => {
  const plan = schedule("A");
  const older = result("A", { outcome: "partial", measured_value: 0 });
  const approved = result("A", { revision: 2 });
  const draft = result("A", { revision: 3, status: "draft", outcome: "partial", measured_value: 0 });
  const when = on("2026-11-17");
  const flags = evaluateRiskFlags([entry(plan, [approved, draft, older], { [older.id]: [] })], when);
  assert.deepEqual(codes(flags), []);
  assert.deepEqual(flags.counts, { overdue: 0, overdueMeasures: 0 });
});

test("the latest submission owns the evidence signal without changing the approved indicator result", () => {
  const plan = schedule("A");
  const approved = result("A", { outcome: "partial", measured_value: 50 });
  const earlier = result("A", { revision: 2, status: "submitted" });
  const latest = result("A", { revision: 3, status: "submitted" });
  const when = on("2026-11-17");
  const flags = evaluateRiskFlags([
    entry(plan, [latest, earlier, approved], { [latest.id]: [{ intact: true }, { intact: false }] }),
  ], when);
  assert.deepEqual(codes(flags), ["A:once:overdue", "A:once:missing_evidence", "A:once:target_not_met"]);
  assert.equal(flags.items[1].resultId, latest.id);
  assert.deepEqual(flags.items[1].sourceValues, { revision: 3, issue: "integrity_failed" });
  assert.equal(flags.items[2].resultId, approved.id);

  const withMissingFile = evaluateRiskFlags([
    entry(plan, [latest, approved], { [latest.id]: [{ intact: false, missingFile: true }] }),
  ], when);
  assert.equal(withMissingFile.items[1].sourceValues.issue, "missing_file");
  assert.match(withMissingFile.items[1].suggestedAction, /поверніть результат/);
  const approvedWithMissingFile = evaluateRiskFlags([
    entry(plan, [approved], { [approved.id]: [{ intact: false, missingFile: true }] }),
  ], when);
  assert.match(approvedWithMissingFile.items[1].suggestedAction, /сховище доказів/);
  const submissionWithProof = evaluateRiskFlags([
    entry(plan, [latest, approved], { [approved.id]: [] }),
  ], when);
  assert.deepEqual(codes(submissionWithProof), ["A:once:overdue", "A:once:target_not_met"]);
  assert.throws(
    () => evaluateRiskFlags([{ plan, revisions: [latest] }], when),
    /Current evidence must be checked/,
  );
});

test("unreadable current revisions suppress their flags without reviving historical revisions", () => {
  const plan = schedule("A");
  const old = result("A", { outcome: "partial", measured_value: 10 });
  const current = result("A", { revision: 2, outcome: "partial", measured_value: 20 });
  const submitted = result("A", { revision: 3, status: "submitted" });
  const flags = evaluateRiskFlags([{
    plan,
    revisions: [old, current, submitted],
    allowedResultIds: new Set([old.id]),
    evidenceByResult: new Map([[old.id, []]]),
  }], on("2026-11-17"));
  assert.deepEqual(codes(flags), ["A:once:overdue"]);
  assert.equal(flags.items[0].resultId, undefined);
});

test("indicator rules compare at six decimals and distinguish maintain, decrease, and missing data", () => {
  const changes = [
    entry(schedule("rounded"), [result("rounded", { measured_value: 99.9999996 })]),
    entry(schedule("maintain", { baseline: 50, target: 50, direction: "maintain" }), [
      result("maintain", { measured_value: 49.9999989 }),
    ]),
    entry(schedule("decrease", { baseline: 100, target: 50, direction: "decrease" }), [
      result("decrease", { measured_value: 100 }),
    ]),
    entry(schedule("improved", { baseline: 100, target: 50, direction: "decrease" }), [
      result("improved", { measured_value: 60 }),
    ]),
    entry(schedule("missing"), [result("missing", { measured_value: null })]),
  ];
  const flags = evaluateRiskFlags(changes, on("2026-11-17"));
  assert.deepEqual(codes(flags), [
    "maintain:once:target_not_met",
    "decrease:once:target_not_met",
    "decrease:once:closed_without_improvement",
    "improved:once:target_not_met",
  ]);
  assert.deepEqual(flags.items[0].sourceValues, {
    revision: 1,
    baseline: 50,
    target: 50,
    actual: 49.999999,
    direction: "maintain",
  });
});
