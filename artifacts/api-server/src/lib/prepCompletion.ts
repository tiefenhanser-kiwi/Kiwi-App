// WS7-8a Block 3 (D-WS7-153) — prep-completion derivation.
//
// Pure helpers shared by the completion endpoints (cooking.ts), the regenerate
// orphan-prune, and the plan-detail per-meal surfacing (plans.ts). No I/O.
//
// Architecture: checkbox state lives in PrepStepCompletion rows keyed by a
// STABLE stepKey. Per-meal "prepped" and the plan-level prepStatus rollup are
// DERIVED here from those rows joined against the assembled prep structure's
// per-step contributesToMealIds — never stored. The only stored prep flag is
// MealPlanInstance.prepStatus, and only when prepStatusIsManual pins it.

import type { PrepStatus } from "@prisma/client";
import type { PrepWeekResult } from "./ai/schemas/prepWeek";

// Minimal per-step shape the derivation needs (the deterministic step set from
// prepStepSet.ts supplies exactly this).
interface MinimalStep {
  stepKey: string;
  contributesToMealIds: string[];
  /** SERVER-8 C (BUG-568) — done by a carried tick (prepStepSet), not its own key. */
  carried?: boolean;
  /** SERVER-9 C (BUG-582) — done for these meals only, by a subset or one-meal session's tick. */
  doneFor?: readonly string[];
}

// The set of stepKeys in a freshly assembled in-memory result — the orphan-prune
// keep-set on regenerate.
export function stepKeysOfResult(result: PrepWeekResult): Set<string> {
  const keys = new Set<string>();
  for (const phase of result.phases) {
    for (const step of phase.steps) keys.add(step.stepKey);
  }
  return keys;
}

/** THX-3 (BUG-424) — see PrepCompletionState.perMealState. */
export type MealPrepState = "nothing" | "not" | "partly" | "fully";

export interface PrepCompletionState {
  // mealId → prepped? A meal is prepped ⟺ every step contributing to it is
  // checked. A meal with ZERO contributing steps is vacuously prepped (a meal
  // that needs no prep is ready to cook — D-WS7-153 ruling).
  perMeal: Record<string, boolean>;
  /**
   * THX-3 (BUG-424) — the per-meal datum the pill words need. `isPrepped` is true
   * both for a meal with nothing to prep and for one fully ticked, so a Friday
   * leftovers sandwich read "Prepped ✓"; and there was no per-meal partial, so every
   * unticked row read "Mostly prepped" whenever the plan was partly prepped.
   *   nothing — no tickable step contributes to it
   *   not     — steps, none ticked
   *   partly  — some ticked
   *   fully   — all ticked
   * The client lane words it (WEB-4); the name is fixed by the ruling.
   */
  perMealState: Record<string, MealPrepState>;
  // Auto-derived plan rollup from perMeal over the full meal universe.
  derivedPrepStatus: PrepStatus;
}

// Derive per-meal prepped + the auto rollup.
//   allMealIds       — the plan's full meal universe (rollup denominator).
//   steps            — assembled steps (stepKey + contributesToMealIds).
//   checkedStepKeys  — stepKeys with a PrepStepCompletion row. Orphan rows
//                      (key not in `steps`) are ignored by construction: we
//                      only ever test membership of a step's own key.
export function derivePrepCompletion(
  allMealIds: string[],
  steps: MinimalStep[],
  checkedStepKeys: ReadonlySet<string>,
): PrepCompletionState {
  // Build mealId → its contributing stepKeys.
  const keysByMeal = new Map<string, string[]>();
  for (const id of allMealIds) keysByMeal.set(id, []);
  const carriedKeys = new Set<string>();
  // SERVER-9 C — stepKey → the meals a session's scoped tick made it done for.
  const doneFor = new Map<string, ReadonlySet<string>>();
  for (const step of steps) {
    for (const mealId of step.contributesToMealIds) {
      // Only meals in the universe count; a step pointing at a since-removed
      // meal is ignored (it isn't in keysByMeal).
      const list = keysByMeal.get(mealId);
      if (list) list.push(step.stepKey);
      if (step.carried) carriedKeys.add(step.stepKey);
    }
    if (step.doneFor?.length) doneFor.set(step.stepKey, new Set(step.doneFor));
  }
  const checkedFor = (mealId: string) => (k: string) =>
    checkedStepKeys.has(k) || carriedKeys.has(k) || (doneFor.get(k)?.has(mealId) ?? false);

  // PREP-2 item 6 — THE ROLLUP COUNTS ONLY MEALS THAT HAVE SOMETHING TO PREP.
  // A zero-prep meal is still vacuously prepped PER MEAL (Cook Mode's gate reads
  // that: nothing to prep means ready to cook), but it used to count toward the
  // plan's rollup too, so an untouched plan holding one read "partial": Hans's
  // "THX test · Classic", nothing ticked, said "Mostly prepped" for the plan and for
  // four meals, because its Friday leftovers sandwich has no prep steps. The plan
  // is "prepped" only when every meal WITH steps is, and a plan none of whose
  // meals has a step is still "prepped" (the all-easy ruling, D-WS7-153).
  const perMeal: Record<string, boolean> = {};
  const perMealState: Record<string, MealPrepState> = {};
  let withSteps = 0;
  let preppedWithSteps = 0;
  for (const mealId of allMealIds) {
    const keys = keysByMeal.get(mealId)!;
    const isChecked = checkedFor(mealId);
    // Vacuous true when keys.length === 0.
    const prepped = keys.every(isChecked);
    perMeal[mealId] = prepped;
    const ticked = keys.filter(isChecked).length;
    perMealState[mealId] = keys.length === 0 ? "nothing" : ticked === keys.length ? "fully" : ticked === 0 ? "not" : "partly";
    if (keys.length === 0) continue;
    withSteps += 1;
    if (prepped) preppedWithSteps += 1;
  }

  let derivedPrepStatus: PrepStatus;
  if (allMealIds.length === 0) {
    derivedPrepStatus = "not_prepped";
  } else if (preppedWithSteps === withSteps) {
    // Every meal with steps is done — or no meal has any (all-easy).
    derivedPrepStatus = "prepped";
  } else if (preppedWithSteps === 0) {
    derivedPrepStatus = "not_prepped";
  } else {
    derivedPrepStatus = "partial";
  }

  return { perMeal, perMealState, derivedPrepStatus };
}

// The effective status shown to the user: a manual pin wins over the derived
// rollup until cleared (prepStatusIsManual=false returns control to derived).
export function effectivePrepStatus(
  isManual: boolean,
  storedPrepStatus: PrepStatus,
  derivedPrepStatus: PrepStatus,
): PrepStatus {
  return isManual ? storedPrepStatus : derivedPrepStatus;
}
