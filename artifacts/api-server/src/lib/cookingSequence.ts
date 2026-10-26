// WS7-8b BUG-018 B2 — Cooking Sequencer loader (now fully deterministic).
// Per kiwi_ws6_plan.md §3 6d-1 + PRD §13.5.4 / §13.5.5.
//
// Server-side endpoint at Cook Mode launch. Loads all step data from a meal's
// dishes and hands it to the pure scheduler (cookingScheduler.ts), which returns
// one ordered sequence intermixing steps from all dishes with serve-anchored
// offsets + parallel cues.
//
// BUG-018 B2: the Sonnet `sequencer.step_ordering` call is GONE. PRD §13.5.5
// [LOCKED] says the Sequencer "runs deterministically on existing step data" and
// prices it FREE on that basis; the AI was doing single-resource scheduling
// arithmetic it is bad at (corn cold; shorter roast started first). No AI call,
// no LLMCallLog row, no rate limit — the same free path for single- AND
// multi-dish meals. `usedAI` remains on the wire, permanently false.

import type { PrismaClient } from "@prisma/client";

import {
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "./cookingScheduler";
import type { SequencedStep } from "./ai/schemas/sequencer";
import { logger } from "./logger";
import { weeknightMorningFor } from "./heldCookDay";
import { onTheDaySteps } from "./mealTiming";
import { feastDishOvenRacks } from "./ovenRacks";
import { FEAST_MEAL_TAG } from "./prepWeekAggregation";
import { BIRD_MEAL_TAGS, mealBirdOf, withBirdRoast } from "./birdWeight";

// Route handler maps NotFoundError → 404; meal-exists-but-empty maps to
// 400 with the locked copy.
export class CookingSequenceNotFoundError extends Error {
  constructor(mealId: string) {
    super(`meal ${mealId} not found`);
    this.name = "CookingSequenceNotFoundError";
  }
}

export const EMPTY_MEAL_COPY =
  "Kiwi didn't find anything to cook, check the meal to make sure the dishes and ingredients are there.";

export class CookingSequenceEmptyMealError extends Error {
  constructor(mealId: string) {
    super(`meal ${mealId} has nothing to sequence`);
    this.name = "CookingSequenceEmptyMealError";
  }
}

export interface RunCookingSequenceDeps {
  prisma: PrismaClient;
}

export interface RunCookingSequenceParams {
  mealId: string;
  userId: string;
  deps: RunCookingSequenceDeps;
  /**
   * THX-4 (D-WS9-324) — the plan item Cook Mode opened the meal from, so the turkey
   * weight the cook chose there sets the roast. Absent: the one plan item that holds the
   * meal, if exactly one does (the weeknight morning's rule, below).
   */
  planItemId?: string;
}

export interface CookingSequenceResult {
  sequence: SequencedStep[];
  totalEstimatedMinutes: number;
  dishCount: number;
  // Retained on the wire for backward compatibility; permanently false now that
  // ordering is computed (no Sonnet call on any path).
  usedAI: boolean;
  /** THX-3d (R4) — a feast's steps merged away (a duplicate preheat): the client must not append them. */
  mergedSteps?: { dishId: string; originalStepIndex: number }[];
}

/** THX-3d round 5 — a feast dish's racks and vessel, as the scheduler reads them. */
const ovenFields = (r: { racks: number; vessel: "sheet" | "dish" | "half" | "unknown" } | null) => ({ ovenRacks: r?.racks ?? null, ovenVessel: r?.vessel ?? null });

export async function runCookingSequence(
  params: RunCookingSequenceParams,
): Promise<CookingSequenceResult> {
  const { mealId, userId, deps } = params;
  const { prisma } = deps;

  // 1. Load meal + dishLinks (with dish metadata) in one round-trip.
  const meal = await prisma.meal.findUnique({
    where: { id: mealId },
    include: {
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        // PREP-3 (R7) — the dish's own foods, so "the rice" of a fried rice is its own.
        // THX-3d round 4 (BUG-496) — and their weights, for a feast's oven racks.
        // THX-4 (D-WS9-324) — and their notes, where a turkey written by count gives its weight.
        include: { dish: { include: { dishIngredients: { select: { quantity: true, unit: true, preparationNote: true, ingredient: { select: { canonicalName: true } } } } } } },
      },
    },
  });

  // 2. Access check — owner OR public. Treat missing + forbidden as 404
  //    so the route handler doesn't leak meal existence to non-owners.
  if (!meal) {
    throw new CookingSequenceNotFoundError(mealId);
  }
  const isOwner = meal.userId === userId;
  // D-WS9-036 (Plan-Gen Arc Block 2) — the shared pool is keyed on isPublic,
  // NOT on userId===null. Owned-but-public community meals (userId set,
  // isPublic:true) are pool members too; the old `userId===null && isPublic`
  // gate 404'd them in Cook Mode. Widen to the isPublic predicate so the
  // pool is coherent with the plans.ts owner-OR-pool gates.
  const isPublic = meal.isPublic === true;
  if (!isOwner && !isPublic) {
    throw new CookingSequenceNotFoundError(mealId);
  }

  // 3. Empty meal — no dishLinks at all.
  if (meal.dishLinks.length === 0) {
    throw new CookingSequenceEmptyMealError(mealId);
  }

  // 4. Bulk-load all steps for the meal's dishes. Polymorphic ownership
  //    means we can't JOIN — separate query keyed by ownerType + ownerId.
  const dishIds = meal.dishLinks.map((dl) => dl.dishId);
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishIds } },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });

  // 5. Empty meal — dishes exist but no steps anywhere.
  if (steps.length === 0) {
    throw new CookingSequenceEmptyMealError(mealId);
  }

  // PREP-2 item 3 — A FEAST'S COOK MODE IS THURSDAY'S. A `thanksgiving-feast` meal
  // spreads its work over the week ("Make ahead (Monday):" the cranberry sauce,
  // "Make ahead (Wednesday night):" the brine, "Thaw (start Friday):" the bird), and
  // those runs are cooked from the Hub's make-ahead rows. So they leave before the
  // scheduler, by the same reading the derived times use (mealTiming
  // onTheDaySteps), and the day's dishes still sequence to finish together. Every
  // other meal passes through exactly as before.
  const isFeast = (meal.tags ?? []).includes(FEAST_MEAL_TAG);
  const stepKey = (s: { ownerId: string; stepIndex: number }) => `${s.ownerId}|${s.stepIndex}`;
  const onTheDay = isFeast
    ? new Set(
        dishIds.flatMap((id) =>
          onTheDaySteps(steps.filter((s) => s.ownerId === id).map((s) => ({ ...s, text: s.stepTextTranslated }))).map(stepKey),
        ),
      )
    : null;
  const dayOnly = onTheDay ? steps.filter((s) => onTheDay.has(stepKey(s))) : steps;

  // 6. Coerce estimatedMinutes 0 → 1 at this boundary (the 15-second
  //    floor decision). All downstream code sees a minimum of 1.
  const normalized = dayOnly.map((s) => ({
    ...s,
    estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
  }));

  // 7. Group steps by dishId. The bulk-load is already ordered by
  //    ownerId then stepIndex, so each per-dish slice is sorted.
  const stepsByDish = new Map<string, typeof normalized>();
  for (const step of normalized) {
    const list = stepsByDish.get(step.ownerId);
    if (list) list.push(step);
    else stepsByDish.set(step.ownerId, [step]);
  }

  const dishCount = meal.dishLinks.length;

  // 8. Build the scheduler input (dishes in positionIndex order, steps in
  //    stepIndex order) and compute the sequence. Pure, deterministic, free —
  //    single- and multi-dish meals take the same path.
  const schedulerDishes: SchedulerDish[] = meal.dishLinks
    .filter((dl) => stepsByDish.has(dl.dishId))
    .map((dl) => ({
      dishId: dl.dishId,
      title: dl.dish.title,
      positionIndex: dl.positionIndex,
      // D-WS9-297 ruling 3 — carried for the served-cold predicate. Free: the
      // dishLinks include already returns every MealDishLink scalar.
      roleLabel: dl.roleLabel,
      ingredientNames: (dl.dish.dishIngredients ?? []).map((i) => i.ingredient.canonicalName),
      // THX-3d round 4 (BUG-496) — a feast dish's racks in the oven, at this copy's servings.
      ...(isFeast
        ? ovenFields(feastDishOvenRacks(
              steps.filter((s) => s.ownerId === dl.dishId).map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated })),
              (stepsByDish.get(dl.dishId) ?? []).map((s) => ({ stepIndex: s.stepIndex, text: s.stepTextTranslated, phaseType: s.phaseType })),
              dl.dish.dishIngredients ?? [],
              dl.dish,
            ))
        : {}),
      steps: (stepsByDish.get(dl.dishId) ?? []).map((s) => ({
        stepIndex: s.stepIndex,
        estimatedMinutes: s.estimatedMinutes,
        phaseType: s.phaseType as SchedulerPhase,
        isTimingSensitive: s.isTimingSensitive,
        // D-WS9-297 ruling 2 — the prose the cue's state is read from. Cook Mode
        // is the ONLY caller that passes it: `mealTiming.ts` derives numbers and
        // a cue moves no number, so the stamps are untouched by this line.
        //
        // 🔴 stepTextTranslated, NOT stepTextRaw. There are two text columns and
        // `toStepShape` renders the TRANSLATED one, so that is the sentence the
        // cook actually reads — a cue derived from the raw column would describe
        // text nobody is shown. They are identical on all 30,718 dev rows today,
        // which is precisely why picking the wrong one would go unnoticed until a
        // row diverged.
        text: s.stepTextTranslated,
        // WS9 D-WS9-239 — the intra-dish overlap token and the component tags
        // the scheduler validates it against. Dropping them here is how a
        // persisted tag silently failed to reach Cook Mode.
        parallelGroup: s.parallelGroup,
        componentKey: s.componentKey,
        pathKey: s.pathKey,
      })),
    }));

  // WS9 BUG-270, as amended by [grocery] B3 (D-WS9-277 Rule 3) — the scheduler
  // selects ONE path per swappable component at its input, so the sequence below
  // is base + the default path. A component's `bought` steps are dropped only
  // when that component HAS a scratch alternative to prefer; a component whose
  // only path is bought keeps its steps, because dropping them left the recipe
  // silently missing the one step that makes it (BUG-121 / BUG-322 — Classic
  // Chicken Noodle Soup with no broth step). The dropped alternates still exist
  // on the meal; the mobile's §27 append (cookSession.sequenceMealSteps) keeps
  // them in the flow, trailing, until D-WS9-148's toggle decides what to show.
  // THX-3 (BUG-449) — a feast's oven frees when the bird comes out; every other
  // meal is scheduled exactly as before.
  // THX-3d round 2 (M) — A WEEKNIGHT'S MORNING CUT. A meal in one of the user's plans
  // whose Prep the Week leaves a cut for its day ("prep the broccoli florets that
  // morning") is sequenced with the morning steps the meal detail shows in that plan
  // (heldCookDay): the cut first, with how it waits, done in the first free window.
  // The scheduler reads a dish's steps in order, so they go in as the morning orders
  // them and come back under their own stepIndex (a new step's is after the dish's
  // last). The meal is the user's copy, so its plan is the one item that holds it.
  // Fails open: any miss sequences the stored steps exactly as before.
  const realIndex = new Map<string, number[]>();
  if (!isFeast && isOwner) {
    try {
      const items = await prisma.mealPlanItem.findMany({
        where: { mealId, planInstance: { userId, isArchived: false } },
        select: { mealPlanInstanceId: true },
        take: 2,
      });
      if (items.length === 1) {
        const morning = await weeknightMorningFor(prisma, {
          planId: items[0].mealPlanInstanceId,
          userId,
          mealId,
          dishes: schedulerDishes.map((d) => ({ dishId: d.dishId, steps: d.steps.map((s) => ({ stepIndex: s.stepIndex, text: s.text ?? "", estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType })) })),
        });
        for (const d of schedulerDishes) {
          const m = morning.get(d.dishId);
          if (!m) continue;
          const byIndex = new Map(d.steps.map((s) => [s.stepIndex, s]));
          realIndex.set(d.dishId, m.map((s) => s.stepIndex));
          d.steps = m.map((s, i) => ({
            isTimingSensitive: false,
            parallelGroup: null,
            componentKey: null,
            pathKey: null,
            ...byIndex.get(s.stepIndex),
            stepIndex: i,
            text: s.text,
            estimatedMinutes: Math.max(1, s.estimatedMinutes),
            phaseType: s.phaseType as SchedulerPhase,
          }));
        }
      }
    } catch (err) {
      realIndex.clear();
      logger.warn({ event: "cooking_sequence_morning_failed", mealId, err }, "Weeknight morning steps failed — stored steps sequenced");
    }
  }
  // THX-4 (D-WS9-324) — THE BIRD THE COOK WEIGHED. A turkey weight chosen on the plan
  // item sets the main roast's minutes (birdWeight withBirdRoast): the bird comes out
  // at the same minute before serving and the day starts earlier or later. A meal with
  // no bird, or no weight chosen, is scheduled exactly as before.
  let dishesToSchedule = schedulerDishes;
  const bird = isOwner && (meal.tags ?? []).some((t) => BIRD_MEAL_TAGS.includes(t))
    ? mealBirdOf({
        tags: meal.tags ?? [],
        dishes: meal.dishLinks.map((dl) => ({
          dishId: dl.dishId,
          title: dl.dish.title,
          rows: (dl.dish.dishIngredients ?? []).map((i) => ({ quantity: i.quantity, unit: i.unit, name: i.ingredient.canonicalName, note: i.preparationNote })),
        })),
      })
    : null;
  if (bird) {
    const items = await prisma.mealPlanItem.findMany({
      where: { mealId, planInstance: { userId, isArchived: false }, ...(params.planItemId ? { id: params.planItemId } : {}) },
      select: { birdWeightLb: true },
      take: 2,
    });
    const lb = items.length === 1 ? items[0].birdWeightLb : null;
    if (lb !== null) dishesToSchedule = withBirdRoast(schedulerDishes, bird, Number(lb));
  }
  const scheduled = scheduleCookingSequence(dishesToSchedule, isFeast ? { feastOven: true } : {});
  const result = realIndex.size === 0 ? scheduled : {
    ...scheduled,
    steps: scheduled.steps.map((e) => {
      const real = realIndex.get(e.dishId);
      return real ? { ...e, originalStepIndex: real[e.originalStepIndex] } : e;
    }),
  };
  // WS9 D-WS9-239 — an ignored tag is a tagging defect, logged and moved past:
  // the step waited (rule 4), so the sequence is the conservative one.
  if (result.ignoredTags.length > 0) {
    logger.warn(
      { event: "cooking_sequence_tags_ignored", mealId, ignoredTags: result.ignoredTags },
      "D-WS9-239: parallelGroup tag(s) ignored at Cook Mode launch",
    );
  }

  return {
    sequence: result.steps,
    totalEstimatedMinutes: result.totalEstimatedMinutes,
    dishCount,
    usedAI: false,
    ...(result.mergedSteps ? { mergedSteps: result.mergedSteps.map((m) => ({ dishId: m.dishId, originalStepIndex: m.stepIndex })) } : {}),
  };
}
