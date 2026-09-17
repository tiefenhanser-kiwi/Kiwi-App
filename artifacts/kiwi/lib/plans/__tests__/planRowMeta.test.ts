// WS9 Plan-flow redesign (D-WS9-191) Block 3 Part B — BUG-290: the My Plans
// row's meal count + date range line.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPlanDateRange, formatShortDate, planRowMeta } from "../planRowMeta";

test("planRowMeta: '{n} meals · {start} – {end}' on an instance row", () => {
  assert.equal(
    planRowMeta({ source: "instance", startDate: "2026-09-16", endDate: "2026-09-21", mealCount: 5 }),
    "5 meals · Sep 16 – Sep 21",
  );
  assert.equal(
    planRowMeta({ source: "instance", startDate: "2026-09-16", endDate: "2026-09-17", mealCount: 1 }),
    "1 meal · Sep 16 – Sep 17",
  );
});

test("planRowMeta: two same-named plans read apart by the line", () => {
  const a = planRowMeta({ source: "instance", startDate: "2026-09-16", endDate: "2026-09-21", mealCount: 5 });
  const b = planRowMeta({ source: "instance", startDate: "2026-09-16", endDate: "2026-09-19", mealCount: 3 });
  assert.notEqual(a, b);
});

test("planRowMeta: whichever half the row has; neither → null; templates → null", () => {
  assert.equal(planRowMeta({ source: "instance", startDate: null, endDate: null, mealCount: 4 }), "4 meals");
  assert.equal(
    planRowMeta({ source: "instance", startDate: "2026-09-16", endDate: "2026-09-21", mealCount: null }),
    "Sep 16 – Sep 21",
  );
  assert.equal(planRowMeta({ source: "instance", startDate: "2026-09-16", endDate: "2026-09-21" }), "Sep 16 – Sep 21");
  assert.equal(planRowMeta({ source: "instance", startDate: null, endDate: null, mealCount: null }), null);
  assert.equal(planRowMeta({ source: "template", startDate: null, endDate: null, mealCount: 5 }), null);
  // A zero-meal plan says so rather than hiding it.
  assert.equal(planRowMeta({ source: "instance", startDate: null, endDate: null, mealCount: 0 }), "0 meals");
});

test("dates read as LOCAL calendar days — a YYYY-MM-DD never rolls back a day (parseLocalDate, not new Date)", () => {
  assert.equal(formatShortDate("2026-10-01"), "Oct 1");
  assert.equal(formatShortDate("2026-01-31"), "Jan 31");
  assert.equal(formatPlanDateRange("2026-09-16", "2026-09-16"), "Sep 16");
  assert.equal(formatPlanDateRange("2026-09-16", null), null);
  assert.equal(formatPlanDateRange(null, "2026-09-16"), null);
});
