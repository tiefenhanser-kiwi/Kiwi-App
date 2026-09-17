// BUG-293 — AddMealToPlanSheet's plan-row date range. It used to parse the
// plan's YYYY-MM-DD with new Date() (UTC midnight) and format it with local
// toLocaleDateString, so west of UTC "2026-09-16" rendered as Sep 15. It now
// delegates to lib/plans/planRowMeta.formatPlanDateRange (Block 3's path:
// parseLocalDate underneath) — the same shape the My Plans row reads, not a
// third date path. These assertions hold in every TZ the runner is given.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPlanDateRange } from "@/lib/plans/planRowMeta";
import { formatDateRange } from "../AddMealToPlanSheet";

test("BUG-293: a YYYY-MM-DD range reads as its own calendar days — never a day early", () => {
  assert.equal(formatDateRange("2026-09-16", "2026-09-21"), "Sep 16 – Sep 21");
  assert.equal(formatDateRange("2026-10-01", "2026-10-07"), "Oct 1 – Oct 7");
  assert.equal(formatDateRange("2026-01-31", "2026-02-01"), "Jan 31 – Feb 1");
});

test("BUG-293: one day collapses; a missing end reads as empty (the row hides it)", () => {
  assert.equal(formatDateRange("2026-09-16", "2026-09-16"), "Sep 16");
  assert.equal(formatDateRange("2026-09-16", null), "");
  assert.equal(formatDateRange(null, "2026-09-16"), "");
  assert.equal(formatDateRange(null, null), "");
});

test("BUG-293: it IS the My Plans row's path — byte-identical to formatPlanDateRange", () => {
  for (const [s, e] of [
    ["2026-09-16", "2026-09-21"],
    ["2026-12-31", "2027-01-04"],
    ["2026-05-05", "2026-05-05"],
  ] as const) {
    assert.equal(formatDateRange(s, e), formatPlanDateRange(s, e));
  }
});
