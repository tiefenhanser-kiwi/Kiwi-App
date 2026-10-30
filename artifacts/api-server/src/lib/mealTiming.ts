// WS9 D-WS9-235 — the meal's time is DERIVED from its steps, not authored.
//
// BUG-245 measured the alternative: 1,458 of 1,555 meals (93.8%) claimed less
// time than their own steps take, median 20 minutes short, p90 48. The
// meal-level scalar was written by one AI call and the steps by a later,
// independent one, with nothing reconciling them — so the number a shopper
// reads had no relationship to the recipe underneath it.
//
// ⚠️ TWO CLOCKS, NEVER THREE (WS9 BUG-337 / D-WS9-297 ruling 5).
// `cookingScheduler` owns the wall clock. THIS FILE is the second clock: a thin
// adapter that reads the scheduler's numbers for the stamp the card shows. There
// is no third.
//
// The rule is written down because it was already broken. `artifacts/kiwi/lib/
// cooking/stepTiming.ts` grew a `remainingMinutes` that SUMS step minutes, and
// Cook Mode's footer showed it as elapsed time: measured on the 13-plan census,
// 48 of 54 meals overstated, median 43% over, worst 167% — the Carne Asada Tacos
// footer read 116 minutes beside a card reading 88, from the same steps. Both
// numbers were "right" about their own arithmetic and one of them was not a
// clock. Anything that sums step minutes and presents the result as time
// remaining is a third clock; the wire already carries
// `SequencedStep.startOffsetMinutes` for exactly this, and the footer reads it
// now (`remainingMinutesToServe`).
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
  type IgnoredTag,
  type SchedulerDish,
  type SchedulerPhase,
} from "./cookingScheduler";
import { logger } from "./logger";
import { feastDishOvenRacks } from "./ovenRacks";
import { FEAST_MEAL_TAG } from "./prepWeekAggregation";
import { mealBirdOf, withBirdRoast } from "./birdWeight";
import { FEAST_DAY_PREFIX } from "./feastWeek";

export interface MealTiming {
  /** Wall-clock start-to-plate, D-WS9-122's definition. Null when underivable. */
  totalMinutes: number | null;
  /** Hands-on minutes. Null when underivable. */
  activeMinutes: number | null;
  /**
   * Per-dish durations, keyed by dishId. Empty when underivable. WS9 D-WS9-239:
   * each is the dish ALONE as the scheduler walked it (its critical path once
   * `parallelGroup` tags are honoured; the serial sum when it carries none).
   */
  dishTotals: Map<string, number>;
  /**
   * WS9 D-WS9-239 — every `parallelGroup` tag the scheduler ignored, with why.
   * Empty on an untagged meal. Surfaced so the stamp path can log them at warn;
   * the scheduler itself is dependency-free and logs nothing.
   */
  ignoredTags: IgnoredTag[];
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
 * `dishTotals` come off the scheduler's per-dish durations (WS9 D-WS9-239),
 * NOT a serial sum taken here: a dish's own steps may overlap once it carries
 * `parallelGroup` tags, and a serial sum would stamp a tagged single-dish
 * meal's Dish.estimatedTimeMinutes LONGER than the meal it is the whole of.
 * Untagged (every row until 1c), the two numbers are the same.
 */
export function deriveMealTiming(
  dishes: SchedulerDish[],
  /** THX-3 (BUG-449) — a feast: its oven frees when the bird comes out (cookingScheduler planOven). */
  opts: { feastOven?: boolean } = {},
): MealTiming {
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
    return { totalMinutes: null, activeMinutes: null, dishTotals: new Map(), ignoredTags: [] };
  }

  const result = scheduleCookingSequence(withSteps, opts.feastOven ? { feastOven: true } : {});

  // The scheduler returns 0/0 only for an input it considered empty, which the
  // guard above already excluded. Treat a 0 total as underivable rather than
  // writing it: a meal that takes no time is not a thing.
  if (result.totalEstimatedMinutes <= 0) {
    return { totalMinutes: null, activeMinutes: null, dishTotals: new Map(), ignoredTags: [] };
  }

  // WS9 BUG-270 — the scheduler walks base + the default path only, so a dish
  // whose every step is a `bought` alternate has no duration (no such dish
  // exists in the catalog; the guard keeps an `undefined` out of the stamp,
  // where it would silently leave the authored number in place).
  const dishTotals = new Map<string, number>();
  for (const d of withSteps) {
    const duration = result.dishDurations[d.dishId];
    if (duration !== undefined) dishTotals.set(d.dishId, duration);
  }

  return {
    totalMinutes: result.totalEstimatedMinutes,
    activeMinutes: result.activeEstimatedMinutes,
    dishTotals,
    ignoredTags: result.ignoredTags,
  };
}

// ── PREP-1 G (BUG-418) — A FEAST'S CLOCK IS THURSDAY'S ─────────────────────────
//
// A Thanksgiving feast spreads its work over the week: "Make ahead (Monday):" the
// cranberry sauce, "Make ahead (Tuesday night):" the brine, and only "On Thursday:"
// the roast. Scheduled as one sequence, Monday's simmer and Wednesday's pie bake
// landed on Thursday's clock — Vegetarian read 238 total / 218 hands-on, about 101
// of those hands-on minutes being Monday–Wednesday work.
//
// So for a meal tagged `thanksgiving-feast` the make-ahead RUNS are left out before
// the scheduler sees the steps. The run is THX-2G-F's reading (scripts/thx2/
// thx2Checks.ts capMakeAheadMinutes): it starts at a step opening "Make ahead (" and
// ends before the step opening "On Thursday:" — the model prefixes a run's first
// step and leaves the simmer or bake inside it unprefixed. Not a parallelism rule:
// which steps happen on the day is a fact about the recipe, and the scheduler still
// decides everything about how the day's steps overlap.
//
// PREP-2 item 3 — the bird's "Thaw (start Friday):" step is a run of its own too (a
// week-before step, cooked from the Hub's thaw row), so it starts a run the same
// way. The same reading drives the feast's Cook Mode (cookingSequence.ts) and its
// client mirror (artifacts/kiwi lib/cooking/feastDay.ts).
const MAKE_AHEAD_RUN_START = /^\s*(?:make ahead \(\s*[a-z]+(?:\s+night)?\s*\)|thaw \([^)]*\))\s*:/i;
// SERVER-8 (D-WS9-351) — "On Thursday:", and the "On feast day:" that replaces it in a
// later release; the shared vectors (artifacts/kiwi lib/cooking/__tests__/feastDayVectors.mts) pin both.
const ON_THURSDAY = FEAST_DAY_PREFIX;

/** A dish's steps, in step order, less its make-ahead runs: what happens on the day. */
export function onTheDaySteps<T extends { text: string }>(steps: readonly T[]): T[] {
  let inRun = false;
  return steps.filter((s) => {
    if (MAKE_AHEAD_RUN_START.test(s.text)) inRun = true;
    else if (ON_THURSDAY.test(s.text)) inRun = false;
    return !inRun;
  });
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
  /**
   * THX-4 (D-WS9-324) — the turkey weight the cook chose on the plan item holding this
   * copy (PATCH /plans/:id/items/:itemId re-stamps with it): the main roast follows it,
   * as in Cook Mode. Absent, the stamp is what it always was.
   */
  opts: { birdWeightLb?: number } = {},
): Promise<MealTiming> {
  const empty: MealTiming = { totalMinutes: null, activeMinutes: null, dishTotals: new Map(), ignoredTags: [] };
  if (dishIds.length === 0) {
    logger.warn({ event: "meal_timing_not_derived", mealId, reason: "no_dishes" },
      "D-WS9-235: no dishes at stamp time; authored time left as-is");
    return empty;
  }

  // Steps only. The dish TITLE is deliberately not read for an everyday meal:
  // SchedulerDish.title feeds composeCue's prose ("while the roast cooks"), and
  // neither derived number depends on it. (A feast's does — see below.)
  const steps = await tx.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishIds } },
    // WS9 D-WS9-239 — parallelGroup + the component tags ride along: the
    // scheduler honours the first and reads the other two only to validate it.
    select: {
      ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true,
      parallelGroup: true, componentKey: true, pathKey: true,
      // PREP-1 G (BUG-418) — read only to find a feast's make-ahead runs.
      stepTextTranslated: true,
    },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });
  // positionIndex comes from the PERSISTED link, not the caller's array order
  // (D-WS9-235 follow-up). POST/PATCH /me/meals payloads carry a client-supplied
  // positionIndex (0–20) that need not be array-ordered, and the backfill reads
  // the link — so this is what keeps a meal re-saved tomorrow on the same
  // number the backfill gave it. Array order is only the fallback for a dish
  // whose link is missing (never on a real write; every caller links first).
  // PREP-1 G (BUG-418) — the meal's tags ride the same read (no extra round trip).
  const links = await tx.mealDishLink.findMany({
    where: { mealId, dishId: { in: dishIds } },
    select: {
      dishId: true, positionIndex: true, roleLabel: true, meal: { select: { tags: true } },
      // THX-3d round 4 (BUG-496) — a feast's oven racks: the vessel its steps name, its
      // rows' weights, its servings (ovenRacks.ts). (BUG-497 item 8) — and what Cook Mode
      // hands the scheduler: the title, the role, the ingredient names. Same round trip.
      dish: { select: { title: true, servingsDefault: true, authoredServingsDefault: true, dishIngredients: { select: { quantity: true, unit: true, preparationNote: true, ingredient: { select: { canonicalName: true } } } } } },
    },
  });
  // PREP-1 G (BUG-418) — a feast's derived times are Thursday's. Every other meal
  // passes its steps through exactly as before.
  const isFeast = links.some((l) => l.meal?.tags?.includes(FEAST_MEAL_TAG));
  // THX-4 — the bird the cook weighed, when a weight is given (its roast reads the prose).
  const bird = opts.birdWeightLb === undefined
    ? null
    : mealBirdOf({
        tags: links[0]?.meal?.tags ?? [],
        dishes: [...links].sort((a, b) => a.positionIndex - b.positionIndex).map((l) => ({
          dishId: l.dishId,
          title: l.dish?.title ?? "",
          rows: (l.dish?.dishIngredients ?? []).map((x) => ({ quantity: x.quantity, unit: x.unit, name: x.ingredient?.canonicalName ?? "", note: x.preparationNote })),
        })),
      });
  const key = (s: { ownerId: string; stepIndex: number }) => `${s.ownerId}|${s.stepIndex}`;
  const onTheDay = isFeast
    ? new Set(
        [...new Set(steps.map((s) => s.ownerId))].flatMap((id) =>
          onTheDaySteps(steps.filter((s) => s.ownerId === id).map((s) => ({ ...s, text: s.stepTextTranslated }))).map(key),
        ),
      )
    : null;
  const byDish = new Map<string, SchedulerDish["steps"]>();
  for (const s of steps) {
    if (onTheDay && !onTheDay.has(key(s))) continue;
    const list = byDish.get(s.ownerId) ?? [];
    list.push({
      stepIndex: s.stepIndex,
      estimatedMinutes: s.estimatedMinutes,
      phaseType: s.phaseType as SchedulerPhase,
      isTimingSensitive: s.isTimingSensitive,
      parallelGroup: s.parallelGroup,
      componentKey: s.componentKey,
      pathKey: s.pathKey,
      // THX-3 (BUG-449) — a feast's oven is read off the prose, so the feast's steps
      // carry it. Every other meal passes none, exactly as before (a cue moves no number).
      ...(isFeast || bird ? { text: s.stepTextTranslated } : {}),
    });
    byDish.set(s.ownerId, list);
  }
  const positionByDish = new Map(links.map((l) => [l.dishId, l.positionIndex]));
  const linkOf = new Map(links.map((l) => [l.dishId, l]));
  /** THX-3d round 4 (BUG-496) — a feast dish's racks in the oven; nothing on any other meal. */
  const racksOf = (id: string) => {
    const dish = linkOf.get(id)?.dish;
    if (!isFeast || !dish) return undefined;
    const all = steps.filter((s) => s.ownerId === id).map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated }));
    const day = (byDish.get(id) ?? []).map((s) => ({ stepIndex: s.stepIndex, text: s.text ?? "", phaseType: s.phaseType }));
    return feastDishOvenRacks(all, day, dish.dishIngredients, dish) ?? undefined;
  };
  // THX-3d round 4 (BUG-497 item 8) — A FEAST'S TITLES ARE READ. The note above holds for
  // every other meal; a feast's scheduler finds its bird, its raise, its desserts and what
  // is served hot BY TITLE (feastRoastDish, the raise's names, DESSERT_DISH, SERVE_HOT), so
  // with the dish id for a title the stamp found no bird and scheduled the blocks path:
  // production's Classic stamped 282 beside Cook Mode's 278 (dev's: 329 beside 312). It
  // passes what Cook Mode passes (cookingSequence.ts), and the two clocks agree.
  const feastDish = (id: string) => {
    const l = linkOf.get(id);
    if (!isFeast || !l?.dish) return {};
    return { title: l.dish.title, roleLabel: l.roleLabel ?? null, ingredientNames: (l.dish.dishIngredients ?? []).map((x) => x.ingredient?.canonicalName).filter((n): n is string => !!n) };
  };
  const schedulerDishes: SchedulerDish[] = dishIds
    .filter((id) => byDish.has(id))
    .map((id, i) => ({
      dishId: id,
      title: id, // unused for timing on every meal but a feast — see above
      ...feastDish(id),
      positionIndex: positionByDish.get(id) ?? i,
      steps: byDish.get(id)!,
      ...(racksOf(id) !== undefined ? { ovenRacks: racksOf(id)!.racks, ovenVessel: racksOf(id)!.vessel } : {}),
    }));

  const timing = deriveMealTiming(bird ? withBirdRoast(schedulerDishes, bird, opts.birdWeightLb!) : schedulerDishes, isFeast ? { feastOven: true } : {});
  if (timing.totalMinutes === null) {
    logger.warn(
      { event: "meal_timing_not_derived", mealId, dishCount: dishIds.length, stepCount: steps.length, reason: "no_steps" },
      "D-WS9-235: no derivable steps at stamp time; authored time left as-is",
    );
    return empty;
  }
  // WS9 D-WS9-239 — a tag the scheduler set aside is a tagging defect worth a
  // line, not a failure: the step simply waited (rule 4), the number is the
  // conservative one, and the stamp proceeds.
  if (timing.ignoredTags.length > 0) {
    logger.warn(
      { event: "meal_timing_tags_ignored", mealId, ignoredTags: timing.ignoredTags },
      "D-WS9-239: parallelGroup tag(s) ignored at stamp time",
    );
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
