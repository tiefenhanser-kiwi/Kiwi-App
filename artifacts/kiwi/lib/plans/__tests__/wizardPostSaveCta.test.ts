// WS7-5b-mobile Block A — tests for the load-bearing post-save CTA flip.
//
// The Plan Details screen's two CTAs change targets after "Save for Later"
// succeeds: pre-save the "Save and Use" button calls draft-activate, post-
// save it calls PATCH /plans/:savedPlanId. The server's `!isWizardDraft`
// guard makes a second tap of draft-activate on a saved draft return 404 —
// these tests pin the flip so the regression can't sneak back in.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decidePlanDetailsCta } from "../wizardPostSaveCta";

// ── pre-save ─────────────────────────────────────────────────────────────

test("decidePlanDetailsCta pre-save (savedPlanId=null): use button targets draft-activate", () => {
  const decision = decidePlanDetailsCta(null);
  assert.equal(decision.saveButton.label, "Save for Later");
  assert.equal(decision.saveButton.saved, false);
  assert.equal(decision.useButton.label, "Save and Use");
  assert.equal(decision.useTarget.kind, "draft-activate");
});

test("decidePlanDetailsCta pre-save with activateLabel override: use button relabels, target unchanged", () => {
  // WS9 Block 3c (D-WS9-032) — the shared Plan Review draft surface reuses this
  // decider but labels the use button "Use This Week". Only the label changes;
  // the pre-save target stays draft-activate.
  const decision = decidePlanDetailsCta(null, { activateLabel: "Use This Week" });
  assert.equal(decision.useButton.label, "Use This Week");
  assert.equal(decision.useTarget.kind, "draft-activate");
  assert.equal(decision.saveButton.label, "Save for Later");
});

test("decidePlanDetailsCta: activateLabel is ignored post-save (draft already gone)", () => {
  const decision = decidePlanDetailsCta("plan-saved-7", {
    activateLabel: "Use This Week",
  });
  assert.equal(decision.useButton.label, "Use this week");
  assert.equal(decision.useTarget.kind, "patch-plan");
});

// ── post-save (THE load-bearing flip) ─────────────────────────────────────

test("decidePlanDetailsCta post-save: use button targets PATCH /plans/:savedPlanId, NOT draft-activate", () => {
  const decision = decidePlanDetailsCta("plan-saved-7");
  // This is THE pin: post-save, the use-button MUST NOT call /wizard/drafts/
  // :draftId/activate — that endpoint returns 404 once the draft has been
  // saved (server's !isWizardDraft guard). The decider routes to patch-plan
  // with the saved plan id instead.
  assert.equal(decision.useTarget.kind, "patch-plan");
  if (decision.useTarget.kind === "patch-plan") {
    assert.equal(decision.useTarget.planId, "plan-saved-7");
  }
});

test("decidePlanDetailsCta post-save: save button reflects saved state (no re-tap into 404)", () => {
  const decision = decidePlanDetailsCta("plan-saved-7");
  assert.equal(decision.saveButton.saved, true);
  // Label changes so the user sees the saved state — disabling alone would
  // leave a confusing greyed-out "Save for Later" button.
  assert.notEqual(decision.saveButton.label, "Save for Later");
});

test("decidePlanDetailsCta post-save: use button label switches to 'Use this week'", () => {
  const decision = decidePlanDetailsCta("plan-saved-7");
  assert.equal(decision.useButton.label, "Use this week");
});

// ── invariants the screen consumer relies on ─────────────────────────────

test("decidePlanDetailsCta: useTarget.kind is always one of the two declared variants", () => {
  // Spot-check both branches return one of the two discriminator values
  // so the screen's switch can be exhaustive.
  const pre = decidePlanDetailsCta(null);
  const post = decidePlanDetailsCta("plan-x");
  assert.ok(
    pre.useTarget.kind === "draft-activate" ||
      pre.useTarget.kind === "patch-plan",
  );
  assert.ok(
    post.useTarget.kind === "draft-activate" ||
      post.useTarget.kind === "patch-plan",
  );
});
