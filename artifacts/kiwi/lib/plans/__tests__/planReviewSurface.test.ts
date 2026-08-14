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
// flag, so ADDING a flag without deciding its value in all four states fails
// here rather than shipping as an accidental `undefined`.
//
// ⚠️ SCOPE OF THIS GUARD, STATED HONESTLY: this pins the TABLE. It cannot see
// whether app/plan/[id].tsx still reads the table — that seam is untestable
// until app/ enters the glob. If someone re-introduces an inline
// `isComposted ? … : …` in the JSX, these tests stay green and the guard is
// gone. That is exactly why planReviewSurface.ts carries a comment saying so.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DRAFT_CUSTOMIZABLE_COPY,
  planReviewState,
  planReviewSurface,
  type PlanReviewState,
  type PlanReviewSurface,
} from "../planReviewSurface";

// ── state derivation ────────────────────────────────────────────────────────

test("planReviewState: the four content states", () => {
  assert.equal(
    planReviewState({ isDraft: true, isComposted: false, isActiveThisWeek: false }),
    "draft",
  );
  assert.equal(
    planReviewState({ isDraft: false, isComposted: true, isActiveThisWeek: false }),
    "composted",
  );
  assert.equal(
    planReviewState({ isDraft: false, isComposted: false, isActiveThisWeek: false }),
    "liveInactive",
  );
  assert.equal(
    planReviewState({ isDraft: false, isComposted: false, isActiveThisWeek: true }),
    "liveThisWeek",
  );
});

test("planReviewState: draft wins over every other signal", () => {
  // A draft's planQuery is disabled so isComposted is always false in practice;
  // the precedence is defensive, and pinning it stops a future reorder from
  // rendering a draft as a composted plan (which would show "Use again" on a
  // plan that was never saved).
  assert.equal(
    planReviewState({ isDraft: true, isComposted: true, isActiveThisWeek: true }),
    "draft",
  );
});

test("planReviewState: composted wins over active-this-week", () => {
  // Compost does not clear isActiveThisWeek optimistically, so a just-composted
  // active plan hits this branch. It must NOT render the live surface.
  assert.equal(
    planReviewState({ isDraft: false, isComposted: true, isActiveThisWeek: true }),
    "composted",
  );
});

// ── the matrix ──────────────────────────────────────────────────────────────

const MATRIX: Record<PlanReviewState, PlanReviewSurface> = {
  draft: {
    headerBand: "draftTitle",
    showThisWeekSlot: false,
    showDraftCommitBar: true,
    showDraftCustomizableNote: true,
    showCompostedBar: false,
    showActionPanel: false,
    showMealDefaults: false,
    rowsReadOnly: true,
  },
  composted: {
    headerBand: "staticMeta",
    showThisWeekSlot: false,
    showDraftCommitBar: false,
    showDraftCustomizableNote: false,
    showCompostedBar: true,
    showActionPanel: false,
    showMealDefaults: false,
    rowsReadOnly: true,
  },
  liveInactive: {
    headerBand: "editors",
    showThisWeekSlot: true,
    showDraftCommitBar: false,
    showDraftCustomizableNote: false,
    showCompostedBar: false,
    showActionPanel: true,
    showMealDefaults: true,
    rowsReadOnly: false,
  },
  liveThisWeek: {
    headerBand: "editors",
    showThisWeekSlot: true,
    showDraftCommitBar: false,
    showDraftCustomizableNote: false,
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
  assert.deepEqual(covered, [
    "composted",
    "draft",
    "liveInactive",
    "liveThisWeek",
  ]);
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
  // The panel is five cells wide. In draft and composted, ZERO of those five
  // exist — it is five-or-nothing, not five-minus-two.
  const withPanel = (Object.keys(MATRIX) as PlanReviewState[]).filter(
    (s) => planReviewSurface(s).showActionPanel,
  );
  assert.deepEqual(withPanel, ["liveInactive", "liveThisWeek"]);
});

test("GUARD: a draft never renders a live or composted affordance", () => {
  const s = planReviewSurface("draft");
  assert.equal(s.showActionPanel, false);
  assert.equal(s.showCompostedBar, false);
  assert.equal(s.showThisWeekSlot, false);
  assert.equal(s.rowsReadOnly, true);
  // Its own commit bar and the D-WS9-161 line are the whole surface.
  assert.equal(s.showDraftCommitBar, true);
  assert.equal(s.showDraftCustomizableNote, true);
});

// ── D-WS9-161 copy ──────────────────────────────────────────────────────────

test("D-WS9-161: the draft customization line is verbatim, em dash included", () => {
  assert.equal(
    DRAFT_CUSTOMIZABLE_COPY,
    "This plan is fully customizable — save it to add, swap, or remove meals.",
  );
  // The em dash is the ruled character. A "helpful" hyphen swap is a copy edit
  // to a string that was ruled verbatim.
  assert.ok(DRAFT_CUSTOMIZABLE_COPY.includes("—"), "em dash, not a hyphen");
});

test("D-WS9-161: the line renders ONLY on a draft", () => {
  // It explains why editing is off. On any state where editing is ON, it would
  // be telling the user to save a plan that is already saved.
  const shown = (Object.keys(MATRIX) as PlanReviewState[]).filter(
    (s) => planReviewSurface(s).showDraftCustomizableNote,
  );
  assert.deepEqual(shown, ["draft"]);
});
