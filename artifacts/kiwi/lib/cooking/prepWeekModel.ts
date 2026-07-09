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
  // WS7-8b BUG-011 — the header/footer prep-time must reflect KEPT steps only.
  // The server's result.totalEstimatedMinutes sums EVERY step including
  // skipSuggested-demoted ones (prepWeekAssembly.ts), so we recompute here from
  // steps where skipSuggested !== true. Same clamp the server used (1..240) so a
  // fully-demoted plan floors at 1 min rather than showing 0.
  //
  // WS7-8b Block 2 (D-WS7-184) — RENDER-OMIT: demoted (skipSuggested === true)
  // steps are dropped from the rendered list entirely (not just zeroed in the
  // minute total). This is the render half of the coupled omit + server-exclude
  // change: once they're gone from `phase.steps`, PrepWeekScreen's "Done with
  // phase" batch (phase.steps.map(st => st.stepKey)) naturally stops writing
  // their keys, and the server (loadPrepStepSet) excludes them from the required-
  // set so the meal can still reach isPrepped. The minute total is unchanged by
  // the omit: the dropped steps are exactly the ones that already contributed 0
  // to keptMinutes below.
  let keptMinutes = 0;

  const phases: PrepPhaseVM[] = result.phases.map((phase) => {
    const keptSteps = phase.steps.filter((step) => step.skipSuggested !== true);
    const steps: PrepStepVM[] = keptSteps.map((step) => {
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
    keptMinutes += steps.reduce(
      (n, s) => n + (s.skipSuggested ? 0 : s.estimatedMinutes),
      0,
    );

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
    // BUG-011 — kept-steps only, clamped to the server's 1..240 range.
    totalEstimatedMinutes: Math.min(240, Math.max(1, keptMinutes)),
    phases,
    doneCount: weekDone,
    totalCount: weekTotal,
    allDone: weekDone === weekTotal,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// ── Meal-label lookup builder (from the plan detail) ────────────────────────

/**
 * The minimal plan-item shape this builder needs — a structural subset of
 * `PlanDetailItem` (lib/api/plans.ts), declared locally so this pure module
 * never imports the plans API surface. `usePlan(...).data.items` satisfies it.
 */
export interface PlanItemForLabel {
  mealId: string;
  /** Day-of-week string (PlanDetailItem.assignedDayOfWeek); null when unassigned. */
  assignedDayOfWeek: string | null;
  /** The expanded meal; null when the row is missing/archived server-side. */
  meal: { title: string } | null;
}

/**
 * Build a {@link MealLabelLookup} from a plan's items: mealId → { name, day }.
 * Pure. Block 2 calls this with `usePlan(planId).data.items` and injects the
 * result into {@link buildPrepWeekModel} so destination rows can show
 * "Chicken Fajitas · Tuesday".
 *
 * MULTI-SLOT COLLAPSE (D-WS7-182, owner WS9): if the SAME meal is scheduled to
 * more than one day, only the FIRST slot's day is retained — the map is keyed by
 * mealId. This is a display-only label limitation; the server's per-step
 * attribution via `contributesToMealIds` is unaffected. Logged, not fixed.
 */
export function buildMealLabelLookup(
  items: readonly PlanItemForLabel[],
): MealLabelLookup {
  const map = new Map<string, MealLabelInfo>();
  for (const item of items) {
    // First slot wins — see the multi-slot collapse note above.
    if (!map.has(item.mealId)) {
      map.set(item.mealId, {
        name: item.meal?.title ?? null,
        day: item.assignedDayOfWeek,
      });
    }
  }
  return (mealId: string) => map.get(mealId);
}
