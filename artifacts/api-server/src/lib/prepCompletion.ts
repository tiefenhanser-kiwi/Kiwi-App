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

export interface PrepCompletionState {
  // mealId → prepped? A meal is prepped ⟺ every step contributing to it is
  // checked. A meal with ZERO contributing steps is vacuously prepped (a meal
  // that needs no prep is ready to cook — D-WS7-153 ruling).
  perMeal: Record<string, boolean>;
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
  for (const step of steps) {
    for (const mealId of step.contributesToMealIds) {
      // Only meals in the universe count; a step pointing at a since-removed
      // meal is ignored (it isn't in keysByMeal).
      const list = keysByMeal.get(mealId);
      if (list) list.push(step.stepKey);
    }
  }

  const perMeal: Record<string, boolean> = {};
  let preppedCount = 0;
  for (const mealId of allMealIds) {
    const keys = keysByMeal.get(mealId)!;
    // Vacuous true when keys.length === 0.
    const prepped = keys.every((k) => checkedStepKeys.has(k));
    perMeal[mealId] = prepped;
    if (prepped) preppedCount += 1;
  }

  let derivedPrepStatus: PrepStatus;
  if (allMealIds.length === 0 || preppedCount === 0) {
    derivedPrepStatus = "not_prepped";
  } else if (preppedCount === allMealIds.length) {
    derivedPrepStatus = "prepped";
  } else {
    derivedPrepStatus = "partial";
  }

  return { perMeal, derivedPrepStatus };
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
