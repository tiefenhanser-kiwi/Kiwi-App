// WS7-8b Block 4 (Block 1) — pure Prep the Week (Screen 3) render model.
//
// Maps the server PrepWeekResult into a Screen-3-shaped view model. NO React, NO
// fetching — a pure transform, fully unit-testable. Block 2 assembles the screen
// from this; Block 3 feeds the checked-stepKey set for the done rollups.
//
// DESTINATION LABELS — DECISION LOCKED (Option 1): "where each goes" is a
// display-only list, one row per `contributesToMealId`. NO per-destination
// quantities, NO per-destination checkboxes — the server has no per-destination
// completion granularity (one stepKey per combined step is the only write unit).
//
// DATA QUESTION (answered): the generate response carries ONLY mealIds per step
// (PrepWeekStep.contributesToMealIds: uuid[]) — no meal names, no days. To label
// a destination we need a SEPARATE lookup. The plan detail already in scope on
// the screen (usePlan → PlanDetail.items) has mealId → { meal.title,
// assignedDayOfWeek }. So the lookup is an INJECTED parameter, keeping this
// transform pure (it never fetches): the screen passes a resolver built from the
// plan detail. An unresolved mealId degrades to a stable generic label, never an
// error.

import type { PrepWeekResult, PrepWeekPhaseKey } from "@/lib/api/cooking";

// ── Injected destination-label lookup ───────────────────────────────────────

/** What the screen can tell us about a destination meal (from the plan detail). */
export interface MealLabelInfo {
  /** The meal's display name (PlanDetailItem.meal.title). */
  name?: string | null;
  /** The assigned day, if any (PlanDetailItem.assignedDayOfWeek). */
  day?: string | null;
}

/** mealId → label info, or undefined when the id isn't in the plan detail. */
export type MealLabelLookup = (mealId: string) => MealLabelInfo | undefined;

// Fallback when a mealId can't be resolved (the plan changed, or no lookup was
// provided) — informative, never blank, never an id leak.
const UNRESOLVED_LABEL = "A planned meal";

// ── View-model shapes ───────────────────────────────────────────────────────

/** One display-only destination row under a combined step. */
export interface PrepDestinationVM {
  mealId: string;
  /** Resolved meal name, or null when unresolved. */
  name: string | null;
  /** Resolved day, or null when unknown. */
  day: string | null;
  /** Composed display string, always non-empty (falls back to a generic label). */
  label: string;
}

/** One combined prep step, screen-ready. */
export interface PrepStepVM {
  stepKey: string;
  number: number;
  title: string;
  instructions: string;
  estimatedMinutes: number;
  /** "Combines N meals" — = contributesToMealIds.length. */
  combinesCount: number;
  /** The "where each goes" rows (display-only, one per contributesToMealId). */
  destinations: PrepDestinationVM[];
  storageNote?: string;
  /** AI-suggested skip (do it while cooking). Defaults false when absent. */
  skipSuggested: boolean;
  /** Completion state — true when its stepKey is in the checked set. */
  done: boolean;
}

/** One phase (always 4, fixed server order), with a done rollup. */
export interface PrepPhaseVM {
  phase: PrepWeekPhaseKey;
  title: string;
  skippable: boolean;
  steps: PrepStepVM[];
  /** Checked steps in this phase. */
  doneCount: number;
  /** Total steps in this phase. */
  totalCount: number;
  /** True when every step in the phase is done (vacuously true for 0 steps). */
  allDone: boolean;
}

export interface PrepWeekVM {
  totalEstimatedMinutes: number;
  /** The 4 phases in fixed server order [seasonings_dry … proteins]. */
  phases: PrepPhaseVM[];
  /** Steps checked across all phases. */
  doneCount: number;
  /** Steps across all phases. */
  totalCount: number;
  /** True when every step in the whole week is done (vacuously true if none). */
  allDone: boolean;
}

export interface BuildPrepWeekModelOptions {
  /** Block 3 feeds the persisted checked stepKeys here; default = none checked. */
  checkedStepKeys?: ReadonlySet<string>;
  /** Resolver for destination labels; default = every id unresolved. */
  mealLabel?: MealLabelLookup;
}

// ── Label composition ───────────────────────────────────────────────────────

function composeDestination(
  mealId: string,
  info: MealLabelInfo | undefined,
): PrepDestinationVM {
  const name = info?.name ?? null;
  const day = info?.day ?? null;
  // "Name · Day" when both, otherwise whichever is present, else the fallback.
  const parts = [name, day].filter((p): p is string => !!p && p.length > 0);
  const label = parts.length > 0 ? parts.join(" · ") : UNRESOLVED_LABEL;
  return { mealId, name, day, label };
}

// ── Transform ───────────────────────────────────────────────────────────────

/**
 * Build the Screen-3 view model from a PrepWeekResult. Pure: the same inputs
 * always yield the same model. Phase order is preserved verbatim from the result
 * (the server guarantees the fixed 4-phase order; this transform does not
 * reorder). Per step, `combinesCount`/`destinations` derive from
 * contributesToMealIds, `done` from the checked set, and the phase/week rollups
 * fold the per-step `done` flags.
 */
export function buildPrepWeekModel(
  result: PrepWeekResult,
  options: BuildPrepWeekModelOptions = {},
): PrepWeekVM {
  const checked = options.checkedStepKeys ?? EMPTY_SET;
  const lookup = options.mealLabel;

  let weekDone = 0;
  let weekTotal = 0;

  const phases: PrepPhaseVM[] = result.phases.map((phase) => {
    const steps: PrepStepVM[] = phase.steps.map((step) => {
      const destinations = step.contributesToMealIds.map((mealId) =>
        composeDestination(mealId, lookup?.(mealId)),
      );
      return {
        stepKey: step.stepKey,
        number: step.number,
        title: step.title,
        instructions: step.instructions,
        estimatedMinutes: step.estimatedMinutes,
        combinesCount: step.contributesToMealIds.length,
        destinations,
        storageNote: step.storageNote,
        skipSuggested: step.skipSuggested ?? false,
        done: checked.has(step.stepKey),
      };
    });

    const doneCount = steps.reduce((n, s) => n + (s.done ? 1 : 0), 0);
    const totalCount = steps.length;
    weekDone += doneCount;
    weekTotal += totalCount;

    return {
      phase: phase.phase,
      title: phase.title,
      skippable: phase.skippable,
      steps,
      doneCount,
      totalCount,
      allDone: doneCount === totalCount, // vacuously true when totalCount === 0
    };
  });

  return {
    totalEstimatedMinutes: result.totalEstimatedMinutes,
    phases,
    doneCount: weekDone,
    totalCount: weekTotal,
    allDone: weekDone === weekTotal,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();
