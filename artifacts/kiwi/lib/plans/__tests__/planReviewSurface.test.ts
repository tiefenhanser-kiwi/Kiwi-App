// WS9-2 2e Phase 4 — the Plan Review state matrix, pinned.
//
// WHY THIS FILE IS THE SHAPE IT IS: app/plan/[id].tsx is outside the test
// runner's glob, so before 2e NOTHING guarded which controls each plan state
// renders. That is how the composted state shipped with its guard applied to
// the action bar and nowhere else — the name editor, the date editor, the Cook
// This Week pill, Add Meals and every row-level mutation stayed live on a
// soft-deleted plan, with a fully green suite.
//
// The matrix below is the whole spec, not a sample. Every state asserts every
// flag, so ADDING a flag without deciding its value in all three states fails
// here rather than shipping as an accidental `undefined`.
//
// lane-pfc Part C.3 — the "draft" state (and D-WS9-161's line, which only ever
// rendered on it) left the table with the screen's draftId branch: D-WS9-191
// §4.7 ruled the unsaved-draft state out of existence.
//
// ⚠️ SCOPE OF THIS GUARD, STATED HONESTLY: this pins the TABLE. It cannot see
// whether app/plan/[id].tsx still reads the table — that seam is untestable
// until app/ enters the glob. If someone re-introduces an inline
// `isComposted ? … : …` in the JSX, these tests stay green and the guard is
// gone. That is exactly why planReviewSurface.ts carries a comment saying so.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  planReviewState,
  planReviewSurface,
  type PlanReviewState,
  type PlanReviewSurface,
} from "../planReviewSurface";

// ── state derivation ────────────────────────────────────────────────────────

test("planReviewState: the three content states", () => {
  assert.equal(
    planReviewState({ isComposted: true, isActiveThisWeek: false }),
    "composted",
  );
  assert.equal(
    planReviewState({ isComposted: false, isActiveThisWeek: false }),
    "liveInactive",
  );
  assert.equal(
    planReviewState({ isComposted: false, isActiveThisWeek: true }),
    "liveThisWeek",
  );
});

test("planReviewState: composted wins over active-this-week", () => {
  // Compost does not clear isActiveThisWeek optimistically, so a just-composted
  // active plan hits this branch. It must NOT render the live surface.
  assert.equal(
    planReviewState({ isComposted: true, isActiveThisWeek: true }),
    "composted",
  );
});

test("planReviewState (lane-pfc C.3): there is no draft state and no draft input", () => {
  // D-WS9-191 §4.7 — a plan is only ever reviewed after it is saved. The
  // screen can no longer be reached with a draftId, so the table cannot
  // describe one; a state the screen can never set would be the same trap as
  // a flag hard-coded false.
  const states = ["composted", "liveInactive", "liveThisWeek"] as const;
  for (const st of states) assert.ok(!("showDraftCommitBar" in planReviewSurface(st)));
  assert.equal(
    planReviewState({ isComposted: false, isActiveThisWeek: false } as never),
    "liveInactive",
  );
});

// ── the matrix ──────────────────────────────────────────────────────────────

const MATRIX: Record<PlanReviewState, PlanReviewSurface> = {
  composted: {
    headerBand: "staticMeta",
    showThisWeekSlot: false,
    showCompostedBar: true,
    showActionPanel: false,
    showMealDefaults: false,
    rowsReadOnly: true,
  },
  liveInactive: {
    headerBand: "editors",
    showThisWeekSlot: true,
    showCompostedBar: false,
    showActionPanel: true,
    showMealDefaults: true,
    rowsReadOnly: false,
  },
  liveThisWeek: {
    headerBand: "editors",
    showThisWeekSlot: true,
    showCompostedBar: false,
    showActionPanel: true,
    showMealDefaults: true,
    rowsReadOnly: false,
  },
};

for (const state of Object.keys(MATRIX) as PlanReviewState[]) {
  test(`matrix: ${state} renders exactly the ruled surface`, () => {
    assert.deepEqual(planReviewSurface(state), MATRIX[state]);
  });
}

test("matrix: every state is covered — a new state cannot skip the table", () => {
  const covered = Object.keys(MATRIX).sort();
  assert.deepEqual(covered, ["composted", "liveInactive", "liveThisWeek"]);
  // And every flag is a real boolean/string, never an accidental undefined from
  // a half-added field.
  for (const state of covered as PlanReviewState[]) {
    for (const [flag, value] of Object.entries(planReviewSurface(state))) {
      assert.notEqual(value, undefined, `${state}.${flag} must be decided`);
    }
  }
});

// ── D-WS9-159: the composted guard, named so a failure is self-explaining ───

test("GUARD (D-WS9-159): a composted plan exposes NO mutation surface", () => {
  const s = planReviewSurface("composted");
  // Rows: readOnly hides Cook Now + Edit + both Swaps + Remove from plan, and
  // neutralises the 7 day pills.
  assert.equal(
    s.rowsReadOnly,
    true,
    "composted rows must be inert — this is a soft-deleted plan",
  );
  // The header band must be the plain-text presentation, NOT the editors.
  assert.equal(
    s.headerBand,
    "staticMeta",
    "composted must not render the name / date editors",
  );
  // No activation, no five-cell panel (which carries Add Meals + Compost), no
  // editable Breakfast/Lunch fields.
  assert.equal(s.showThisWeekSlot, false, "cannot activate a composted plan");
  assert.equal(s.showActionPanel, false, "no live actions on a composted plan");
  assert.equal(
    s.showMealDefaults,
    false,
    "read-only cannot mean two live text fields",
  );
});

test("GUARD (D-WS9-159): 'Use again' survives — it is the only way back", () => {
  // Compost is a SOFT delete: the items still exist and copyPlan works against
  // them. If this ever goes false, a composted plan becomes a dead-end screen
  // with nothing but a back button.
  assert.equal(planReviewSurface("composted").showCompostedBar, true);
});

test("GUARD: the live states are the ONLY ones carrying the action panel", () => {
  // The panel is five cells wide. In composted, ZERO of those five exist — it
  // is five-or-nothing, not five-minus-two.
  const withPanel = (Object.keys(MATRIX) as PlanReviewState[]).filter(
    (s) => planReviewSurface(s).showActionPanel,
  );
  assert.deepEqual(withPanel, ["liveInactive", "liveThisWeek"]);
});

