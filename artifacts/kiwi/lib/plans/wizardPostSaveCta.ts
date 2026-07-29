// WS7-5b-mobile Block A — post-save CTA decider for the Plan Details screen.
//
// The wizard's "Plan Details" screen has two CTAs whose targets shift after
// "Save for Later" succeeds. The flip is load-bearing: /save and /activate
// share a `!isWizardDraft` guard server-side, so once a draft has been saved,
// calling /activate on the same draft id returns 404. Post-save, the
// "Save and Use" button must repurpose to "Use this week" and target
// `PATCH /plans/:savedPlanId { isActiveThisWeek: true }` instead — that PATCH
// hits the new real plan id, not the dead draft id.
//
// Split out into a pure helper so the regression that matters most — the
// 404-dead-tap — can be pinned by a state-machine unit test rather than a
// full screen-render test.

/**
 * Decision shape rendered by the Plan Details screen's two CTAs.
 *
 * Returned by `decidePlanDetailsCta(savedPlanId)`:
 *
 * - `savedPlanId === null` → the user has not yet tapped "Save for Later".
 *   The "Save and Use" button targets the draft-activate endpoint with the
 *   draft id (`useTarget.kind === "draft-activate"`).
 * - `savedPlanId !== null` → "Save for Later" succeeded; the draft id is
 *   dead. The button repurposes to "Use this week" and targets
 *   `PATCH /plans/:savedPlanId` (`useTarget.kind === "patch-plan"`). The
 *   "Save for Later" button is also marked saved so it cannot be re-tapped
 *   into a 404.
 */
export interface PlanDetailsCtaDecision {
  saveButton: {
    label: string;
    /** True after a successful save — the button must be disabled / show the saved state so it cannot be tapped into a 404. */
    saved: boolean;
  };
  useButton: {
    label: string;
  };
  /**
   * Where the "Save and Use" / "Use this week" button must POST/PATCH.
   * - "draft-activate": call activateWizardDraft(draftId) — pre-save only.
   * - "patch-plan": call patchPlan(savedPlanId, { isActiveThisWeek: true }) —
   *   post-save only; targets the saved plan id, NOT the dead draft id.
   */
  useTarget:
    | { kind: "draft-activate" }
    | { kind: "patch-plan"; planId: string };
}

export interface DecidePlanDetailsCtaOptions {
  /**
   * Label for the use button in its PRE-SAVE (draft-activate) state. Defaults
   * to "Save and Use" — the wizard-plan-details surface. WS9 Block 3c
   * (D-WS9-032) reuses this decider on the shared Plan Review draft surface and
   * passes "Use This Week" there. Post-save the label is always "Use this week"
   * regardless (the draft is already gone), so this only overrides the pre-save
   * text.
   */
  activateLabel?: string;
}

/**
 * Decide the two CTAs' labels + the use-button target, given the current
 * post-save state. Pure function so the load-bearing post-save flip can be
 * pinned by a unit test without rendering the screen.
 *
 * @param savedPlanId the new plan id returned by saveWizardDraft, or null
 *   pre-save. Once non-null, the draft id is dead — the use button must
 *   target PATCH /plans/:savedPlanId, not /wizard/drafts/:draftId/activate.
 * @param opts optional surface overrides (see DecidePlanDetailsCtaOptions).
 */
export function decidePlanDetailsCta(
  savedPlanId: string | null,
  opts: DecidePlanDetailsCtaOptions = {},
): PlanDetailsCtaDecision {
  if (savedPlanId === null) {
    return {
      saveButton: { label: "Save for Later", saved: false },
      useButton: { label: opts.activateLabel ?? "Save and Use" },
      useTarget: { kind: "draft-activate" },
    };
  }
  return {
    saveButton: { label: "Saved to My Plans", saved: true },
    useButton: { label: "Use this week" },
    useTarget: { kind: "patch-plan", planId: savedPlanId },
  };
}
