// WS9 D-WS9-235 — the meal's time is DERIVED from its steps, not authored.
//
// BUG-245 measured the alternative: 1,458 of 1,555 meals (93.8%) claimed less
// time than their own steps take, median 20 minutes short, p90 48. The
// meal-level scalar was written by one AI call and the steps by a later,
// independent one, with nothing reconciling them — so the number a shopper
// reads had no relationship to the recipe underneath it.
//
// ⚠️ THIS FILE OWNS NO PARALLELISM RULES AND MUST NEVER GROW ANY. Hans:
// "we did a lot of work on this and what counts as parallel or not, so the
// rules are there." `cookingScheduler` decides what overlaps — unattended is
// {preheat, rest, hold} OR (cook AND NOT isTimingSensitive) — and both derived
// numbers come straight off its result. This is a thin adapter: DB shapes in,
// scheduler call, numbers out. If a future change needs different overlap
// behaviour, it belongs in the scheduler with its tests, not here.
import {
  scheduleCookingSequence,
  type SchedulerDish,
} from "./cookingScheduler";

export interface MealTiming {
  /** Wall-clock start-to-plate, D-WS9-122's definition. Null when underivable. */
  totalMinutes: number | null;
  /** Hands-on minutes. Null when underivable. */
  activeMinutes: number | null;
  /** Per-dish serial totals, keyed by dishId. Empty when underivable. */
  dishTotals: Map<string, number>;
}

/**
 * Derive a meal's timing from its dishes' steps.
 *
 * Returns NULLS, never zeros, when nothing is derivable (no dishes, or no
 * dish has a step). That distinction is load-bearing: `0` is a claim that the
 * meal takes no time, and a caller writing it into `estimatedTimeMinutes`
 * would replace an honest-but-unverified number with a definitely-wrong one.
 * Null means "I cannot say", and the caller keeps what it had.
 *
 * `dishTotals` are SERIAL sums of each dish's own steps. Dishes overlap each
 * other — that is the scheduler's job — but a dish's own steps do not: measured
 * across the catalog, `parallelGroup` is set on 0 of 25,564 steps, so there is
 * no recorded intra-dish parallelism to honour.
 */
export function deriveMealTiming(dishes: SchedulerDish[]): MealTiming {
  const withSteps = dishes.filter((d) => d.steps.length > 0);
  if (withSteps.length === 0) {
    return { totalMinutes: null, activeMinutes: null, dishTotals: new Map() };
  }

  const result = scheduleCookingSequence(withSteps);

  // The scheduler returns 0/0 only for an input it considered empty, which the
  // guard above already excluded. Treat a 0 total as underivable rather than
  // writing it: a meal that takes no time is not a thing.
  if (result.totalEstimatedMinutes <= 0) {
    return { totalMinutes: null, activeMinutes: null, dishTotals: new Map() };
  }

  const dishTotals = new Map<string, number>();
  for (const d of withSteps) {
    dishTotals.set(
      d.dishId,
      d.steps.reduce((sum, s) => sum + s.estimatedMinutes, 0),
    );
  }

  return {
    totalMinutes: result.totalEstimatedMinutes,
    activeMinutes: result.activeEstimatedMinutes,
    dishTotals,
  };
}
