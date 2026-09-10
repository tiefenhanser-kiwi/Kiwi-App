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
import type { Prisma } from "@prisma/client";

import {
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "./cookingScheduler";
import { logger } from "./logger";

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
  // CANONICAL DISH ORDER (D-WS9-235 follow-up). The scheduler's single-cook
  // pass breaks ideal-start ties by ARRAY INDEX, so the same dishes handed over
  // in a different order can schedule differently (measured: ±1 minute on
  // five multi-dish meals, one 76 → 77). Every caller — the save-time stamp
  // and the backfill — passes through here, so this is the one place the order
  // is fixed: positionIndex ascending, then dishId ascending. Not the
  // scheduler's concern: it owns overlap rules, not what order it is asked in.
  const withSteps = dishes
    .filter((d) => d.steps.length > 0)
    .sort(
      (a, b) =>
        a.positionIndex - b.positionIndex ||
        (a.dishId < b.dishId ? -1 : a.dishId > b.dishId ? 1 : 0),
    );
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

/**
 * Derive a persisted meal's timing from its PERSISTED steps and stamp it onto
 * the meal + its dishes, inside the caller's transaction.
 *
 * ⚠️ READS THE GRAPH BACK RATHER THAN THE PAYLOAD, for the reason stampAllergens
 * gives two lines below its own call site: the graph is what every other reader
 * sees, so a meal cannot end up stamped against a different input than its
 * neighbour. It also means the backfill and this path derive from byte-identical
 * shapes, so a meal re-saved tomorrow gets the number the backfill would give it.
 *
 * FAILS OPEN, NOT CLOSED. If no step is derivable the authored value is left
 * exactly as it was and activeTimeMinutes stays null — a null the client can
 * recognise as "not derived" rather than a zero it would render as a claim.
 * That should not happen (every persistence path has steps by this point), so
 * it is logged at warn rather than passed over in silence.
 */
export async function stampMealTiming(
  tx: Prisma.TransactionClient,
  mealId: string,
  dishIds: string[],
): Promise<MealTiming> {
  const empty: MealTiming = { totalMinutes: null, activeMinutes: null, dishTotals: new Map() };
  if (dishIds.length === 0) {
    logger.warn({ event: "meal_timing_not_derived", mealId, reason: "no_dishes" },
      "D-WS9-235: no dishes at stamp time; authored time left as-is");
    return empty;
  }

  // Steps only. The dish TITLE is deliberately not read: SchedulerDish.title
  // feeds composeCue's prose ("while the roast cooks"), and neither derived
  // number depends on it. Reading it would add a round-trip and a second table
  // dependency to buy a string this function discards.
  const steps = await tx.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishIds } },
    select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });
  const byDish = new Map<string, SchedulerDish["steps"]>();
  for (const s of steps) {
    const list = byDish.get(s.ownerId) ?? [];
    list.push({
      stepIndex: s.stepIndex,
      estimatedMinutes: s.estimatedMinutes,
      phaseType: s.phaseType as SchedulerPhase,
      isTimingSensitive: s.isTimingSensitive,
    });
    byDish.set(s.ownerId, list);
  }
  // dishIds order is the caller's positional order — the same order the meal's
  // dishLinks carry, so positionIndex here matches what the scheduler sees at
  // cook time.
  const schedulerDishes: SchedulerDish[] = dishIds
    .filter((id) => byDish.has(id))
    .map((id, i) => ({
      dishId: id,
      title: id, // unused for timing — see above
      positionIndex: i,
      steps: byDish.get(id)!,
    }));

  const timing = deriveMealTiming(schedulerDishes);
  if (timing.totalMinutes === null) {
    logger.warn(
      { event: "meal_timing_not_derived", mealId, dishCount: dishIds.length, stepCount: steps.length, reason: "no_steps" },
      "D-WS9-235: no derivable steps at stamp time; authored time left as-is",
    );
    return empty;
  }

  await tx.meal.update({
    where: { id: mealId },
    data: {
      estimatedTimeMinutes: timing.totalMinutes,
      activeTimeMinutes: timing.activeMinutes,
    },
  });
  for (const [dishId, total] of timing.dishTotals) {
    await tx.dish.update({ where: { id: dishId }, data: { estimatedTimeMinutes: total } });
  }
  return timing;
}
