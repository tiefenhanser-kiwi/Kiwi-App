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

// ── Sept 29 design review, item 14 — error is its own state ──────────────────
//
// THE DEFECT THIS PINS, stated precisely, because the review stated it wrong and
// a vaguer version of these tests would have let it back in:
//
// On a failed GET /home, React Query reports isLoading false and data undefined.
// So isFirstRun is false (it requires a loaded payload), deriveHeroModel(undefined)
// collapses to "empty" so hasActivePlan is false, and the rail is empty. The
// order that came back was ["makeLane"] — which is NOT the new-account screen.
// A genuine first run renders the teaching arc. The errored screen rendered
// something STRICTLY EMPTIER than either real state, with no explanation, while
// silently implying the user has no plan this week.

test("item 14: an ERROR is not the empty/new-account state", () => {
  // Exactly the inputs a failed load produces.
  const errored = homeSectionOrder({
    isFirstRun: false,
    hasActivePlan: false,
    hasRail: false,
    isLoading: false,
    isError: true,
  });
  assert.deepEqual(errored, ["error"]);

  // The two states it used to be indistinguishable from, with the SAME inputs
  // apart from isError. Both must differ from it.
  const emptyReturning = homeSectionOrder({
    isFirstRun: false,
    hasActivePlan: false,
    hasRail: false,
    isLoading: false,
  });
  const firstRun = homeSectionOrder({
    isFirstRun: true,
    hasActivePlan: false,
    hasRail: false,
    isLoading: false,
  });

  assert.deepEqual(emptyReturning, ["makeLane"], "the pre-fix errored output");
  assert.deepEqual(firstRun, ["arc", "makeLane"]);
  assert.notDeepEqual(errored, emptyReturning, "error must not render as empty");
  assert.notDeepEqual(errored, firstRun, "error must not render as a first run");
  assert.ok(!errored.includes("arc"), "an errored load is not a new account");
});

test("item 14: error is EXCLUSIVE — nothing else renders beside it", () => {
  // Every other input set to the value that would normally ADD a section. If any
  // of them leaks through, the user gets half a screen next to "we couldn't
  // reach Kiwi", which reads as a partial success.
  assert.deepEqual(
    homeSectionOrder({
      isFirstRun: true,
      hasActivePlan: true,
      hasRail: true,
      isLoading: true,
      isError: true,
    }),
    ["error"],
  );
});

test("item 14: a HANG lands in error, not in an eternal placeholder", () => {
  // useHomePayload's AbortController ceiling turns a request that never settles
  // into a rejection, so React Query reports isError and isLoading goes false.
  // This is the state AFTER that conversion, and it must not be leadLoading —
  // the pre-fix behaviour was the "Getting your week…" shim forever.
  const afterTimeout = homeSectionOrder({
    isFirstRun: false,
    hasActivePlan: false,
    hasRail: false,
    isLoading: false,
    isError: true,
  });
  assert.deepEqual(afterTimeout, ["error"]);
  assert.ok(
    !afterTimeout.includes("leadLoading"),
    "a timed-out load must stop claiming it is still loading",
  );

  // And error OUTRANKS loading, which is what makes the conversion safe even if a
  // retry is in flight when the error is still latched: a settled failure is
  // knowledge, a pending request is not.
  assert.deepEqual(
    homeSectionOrder({
      isFirstRun: false,
      hasActivePlan: false,
      hasRail: false,
      isLoading: true,
      isError: true,
    }),
    ["error"],
  );
});

test("item 14: isError absent ⇒ every pre-existing caller is unchanged", () => {
  assert.deepEqual(
    homeSectionOrder({ isFirstRun: false, hasActivePlan: true, hasRail: true }),
    ["thisWeek", "makeLane", "rail"],
  );
});
