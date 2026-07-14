// WS9 Block 3a — homeSectionOrder: the ruled body order (D-WS9-025 + this-week
// module ruling). Two load-bearing assertions:
//   1. the LEAD (arc / this-week module) sits BEFORE the make lane;
//   2. the utility row is folded into "thisWeek", so first-run (no plan) has NO
//      this-week module — the utility row cannot render without a plan (G5).

import assert from "node:assert/strict";
import { test } from "node:test";

import { homeSectionOrder } from "../homeSections";

test("returning user: this-week module LEADS, above the make lane", () => {
  assert.deepEqual(
    homeSectionOrder({ isFirstRun: false, hasActivePlan: true, hasRail: true }),
    ["thisWeek", "makeLane", "rail"],
  );
});

test("first-run user: arc leads, NO this-week module (so no utility row)", () => {
  const order = homeSectionOrder({
    isFirstRun: true,
    hasActivePlan: false,
    hasRail: true,
  });
  assert.deepEqual(order, ["arc", "makeLane", "rail"]);
  // G5 contract: the utility row lives only inside "thisWeek" — absent here.
  assert.ok(!order.includes("thisWeek"));
});

test("returning user with no rail content: rail omitted, module preserved", () => {
  assert.deepEqual(
    homeSectionOrder({ isFirstRun: false, hasActivePlan: true, hasRail: false }),
    ["thisWeek", "makeLane"],
  );
});

test("empty returning user (between plans): make lane leads, no this-week module", () => {
  assert.deepEqual(
    homeSectionOrder({ isFirstRun: false, hasActivePlan: false, hasRail: false }),
    ["makeLane"],
  );
});

test("legacy null-stamp user with a plan: both leads surface (arc then thisWeek)", () => {
  // No backfill (D-WS9-026) — a pre-migration row can read first-run yet own a
  // plan. Conditions are independent so the module still shows; arc precedes it.
  assert.deepEqual(
    homeSectionOrder({ isFirstRun: true, hasActivePlan: true, hasRail: true }),
    ["arc", "thisWeek", "makeLane", "rail"],
  );
});
