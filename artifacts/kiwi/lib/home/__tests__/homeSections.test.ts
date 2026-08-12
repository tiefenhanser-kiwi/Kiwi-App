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

// ── WS9-2 2c Commit 2 — the loading lead ────────────────────────────────────
// Before this commit, "GET /home is in flight" and "this user genuinely has no
// plan" produced the SAME section list. Home therefore asserted something false
// for the duration of every cold request. These tests pin the distinction.

test("loading: the lead slot is HELD by a placeholder, not collapsed", () => {
  // isFirstRun/hasActivePlan are false-by-default here, not false-by-fact —
  // exactly the pre-fix input that used to silently yield ["makeLane"].
  assert.deepEqual(
    homeSectionOrder({
      isFirstRun: false,
      hasActivePlan: false,
      hasRail: false,
      isLoading: true,
    }),
    ["leadLoading", "makeLane"],
  );
});

test("loading PRE-EMPTS both leads — no arc flash, no premature this-week module", () => {
  // A returning user must never see the first-run treatment (D-WS9-026), and a
  // stale-cache hasActivePlan must not paint a strip we cannot yet fill.
  assert.deepEqual(
    homeSectionOrder({
      isFirstRun: true,
      hasActivePlan: true,
      hasRail: true,
      isLoading: true,
    }),
    ["leadLoading", "makeLane", "rail"],
  );
});

test("loading resolves: the placeholder is replaced by the real lead, order unchanged", () => {
  const loading = homeSectionOrder({
    isFirstRun: false,
    hasActivePlan: true,
    hasRail: true,
    isLoading: true,
  });
  const settled = homeSectionOrder({
    isFirstRun: false,
    hasActivePlan: true,
    hasRail: true,
    isLoading: false,
  });
  assert.deepEqual(loading, ["leadLoading", "makeLane", "rail"]);
  assert.deepEqual(settled, ["thisWeek", "makeLane", "rail"]);
  // Same arity and same tail — the swap is in place, so nothing below it moves.
  assert.equal(loading.length, settled.length);
  assert.deepEqual(loading.slice(1), settled.slice(1));
});

test("isLoading is optional — omitting it is identical to passing false", () => {
  // Back-compat guard: every pre-2c caller omits the flag.
  const omitted = homeSectionOrder({
    isFirstRun: true,
    hasActivePlan: false,
    hasRail: true,
  });
  const explicit = homeSectionOrder({
    isFirstRun: true,
    hasActivePlan: false,
    hasRail: true,
    isLoading: false,
  });
  assert.deepEqual(omitted, explicit);
  assert.ok(!omitted.includes("leadLoading"));
});
