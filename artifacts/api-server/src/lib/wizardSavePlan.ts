// Plan-Gen Arc · Block 2 · D-WS9-038 — the save-time plan contract.
//
// readAndFinalizeWizardDraft produces this; materializeWizardDraft consumes it.
// It replaces the old flat `WizardExpandedPlan` payload so the save path can
// carry a PER-SLOT mix: some slots forked from the shared store, some built live.
// Slots are in original slot order — the array index IS the MealPlanItem
// positionIndex, so store and live slots interleave correctly.
//
// Kept in its own module (plain TS types, not Zod) so wizardFinalize.ts and
// wizardActivation.ts can both import it without an import cycle.

import type { WizardExpandEnrichedMeal } from "./ai/schemas/wizard";

export type WizardSaveSlot =
  // Store-filled slot: fork the shared-pool Meal (steps + dishes come from the
  // source row), bypassing finalize entirely. isPublic was revalidated at
  // partition time, so the id is safe to fork.
  | { kind: "store"; sourceStoreMealId: string }
  // Built slot: a live-generated meal (with finalized steps), materialized from
  // this payload. `writeBack` = publish a pool copy stamped live_writeback.
  // A slot that demoted from store (its id drifted un-public since build-plans)
  // is ALSO a build slot but with writeBack:false — we don't re-publish a meal
  // that was just unpublished.
  | { kind: "build"; meal: WizardExpandEnrichedMeal; writeBack: boolean };

export interface WizardSavePlan {
  candidateId: string;
  title: string;
  tags: string[];
  whyBullets: string[];
  // Servings unification (BUG-046 / D-WS9-070 Option 1) — the PER-RUN household
  // the user set for this generation, carried from the draft payload so the
  // materializer can resolve effectiveHousehold = perRun ?? stored and apply it
  // uniformly to forked AND live slots. Undefined for legacy drafts written
  // before the field existed → materialize falls back to stored household.
  householdSize?: number;
  // In original slot order; index === MealPlanItem.positionIndex.
  slots: WizardSaveSlot[];
}
