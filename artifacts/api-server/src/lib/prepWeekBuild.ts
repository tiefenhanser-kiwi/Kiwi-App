// [prepcook] Part J.0 (census finding 1) — ONE STEP SET, BUILT ONCE.
//
// The Prep the Week route renders from this, and `loadPrepStepSet` (the
// `isPrepped` derivation on GET /plans/:id) derives from it, with the same
// inputs: the plan, its day lags and today. Before this the derivation rebuilt
// the step plan WITHOUT step text and WITHOUT lags (prepStepSet.ts:114), so it
// keyed different steps than the screen showed — `seasonings_dry#dish#…` blends
// no screen ever showed — and it never saw the overlay's protein holds. Ticking
// every step on screen left 12 of 14 census meals not prepped.
//
// What `isPrepped` counts is `isTickable`: a step the cook can tick. A step the
// engine demoted, a step that holds no container (the wash, a cook-day line) and
// a protein the overlay holds for cook day are not in the denominator. A meal
// with zero tickable steps is prepped (Hans's vacuous rule, D-WS7-153).

import type { LoadPrepWeekInputResult } from "./prepWeekAggregation";
import { buildPrepCombineInput } from "./prepCombineAdapter";
import { combinePrep } from "./prepCombineEngine";
import {
  buildStepPlan,
  storageClosesByStepKey,
  type PlannedStep,
  type StepPlan,
} from "./prepWeekAssembly";
import { overlayHoldsForCookDay, type StorageContext } from "./prepStorage";

export interface PrepWeekBuild {
  stepPlan: StepPlan;
  /** stepKey → what the storage overlay needs, from today's cook days. */
  storageContexts: Map<string, StorageContext>;
}

export interface BuildPrepWeekOptions {
  /** Prep Selected Meals: the plan is built whole, then scoped (A3). */
  scopeMealIds?: readonly string[];
}

export function buildPrepWeekPlan(
  load: Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">,
  opts: BuildPrepWeekOptions = {},
): PrepWeekBuild {
  const { input, identity } = load;
  // An older caller (or a hand-built test loader) carries no cook days: that is
  // "no day known", the same as a plan with no startDate.
  const cookDays = load.cookDays ?? { prepDay: null, lagByMealId: new Map(), dayNameByMealId: new Map() };
  const combineResult = combinePrep(buildPrepCombineInput(input), identity?.foldedIdByIngredientId);
  // WS7-8a B2b — step text per dishId (folded dish + meal owned) so the engine
  // can judge what is prep and which dishes mix cold.
  const stepTextByDishId = new Map<string, string[]>();
  for (const meal of input.meals) {
    for (const dish of meal.dishes) stepTextByDishId.set(dish.dishId, dish.stepTexts);
  }
  const stepPlan = buildStepPlan(
    combineResult,
    input.planName,
    stepTextByDishId,
    cookDays.lagByMealId,
    opts.scopeMealIds ? { scopeMealIds: new Set(opts.scopeMealIds) } : {},
  );

  // D-WS9-298 — what the overlay needs, keyed by stepKey, from the STEP PLAN so it
  // is today's dates whether the prose came from the cache or not.
  const mealNameById = new Map(input.meals.map((m) => [m.mealId, m.mealName]));
  const closesByStepKey = storageClosesByStepKey(stepPlan.steps, stepPlan.containerExtras);
  const storageContexts = new Map<string, StorageContext>();
  for (const st of stepPlan.steps) {
    const names = st.components.map((c) => c.ingredientName);
    const notes = st.components.flatMap((c) => [
      c.preparationNote ?? "",
      ...c.measures.map((x) => x.preparationNote ?? ""),
    ]);
    // D-WS9-301 rule 13 — the held line names the day and the meal. The LATEST
    // meal is the one the lag is from.
    const latest = st.contributesToMealIds
      .map((id) => ({ id, lag: cookDays.lagByMealId.get(id) ?? -1 }))
      .sort((x, y) => y.lag - x.lag)[0];
    const dayName = latest ? cookDays.dayNameByMealId.get(latest.id) : undefined;
    const mealName = latest ? mealNameById.get(latest.id) : undefined;
    storageContexts.set(st.stepKey, {
      daysUntilCook: st.daysUntilCook,
      ...(dayName ? { dayName } : {}),
      ...(mealName ? { mealName } : {}),
      phase: st.phase,
      // The BOWL NAME is part of the text on purpose: "Fajita spice blend" says
      // what the mixture IS; without it a dry blend read as loose produce.
      text: [...names, ...notes].join(" "),
      bowlName: st.bowlName,
      ingredientNames: names,
      ...(closesByStepKey.has(st.stepKey) ? { closes: closesByStepKey.get(st.stepKey)! } : {}),
      ...(st.marinadeJoin ? { marinadeJoin: st.marinadeJoin } : {}),
    });
  }

  const build = { stepPlan, storageContexts };
  assignCoversCookSteps(build, load);
  return build;
}

/**
 * A step the cook can tick on screen, and therefore one `isPrepped` waits for.
 * The same facts the wire is built from: `demoted` becomes `skipSuggested`
 * (assemblePrepWeekResult), a cook-day line or the wash `holdsNoContainer`, and
 * the overlay's hold is `overlayHoldsForCookDay`, which the overlay itself calls.
 */
export function isTickable(step: PlannedStep, ctx: StorageContext | undefined): boolean {
  if (step.demoted || step.holdsNoContainer || step.cookDaySentence) return false;
  return !overlayHoldsForCookDay(step, ctx);
}

export interface PrepStepRef {
  stepKey: string;
  contributesToMealIds: string[];
}

export function tickableStepRefs(build: PrepWeekBuild): PrepStepRef[] {
  return build.stepPlan.steps
    .filter((s) => isTickable(s, build.storageContexts.get(s.stepKey)))
    .map((s) => ({ stepKey: s.stepKey, contributesToMealIds: s.contributesToMealIds }));
}

/**
 * Part J.0 (A4) — which cook steps each prep step did the work of.
 *
 * A cook step tagged `prep` is COVERED when every ingredient its `amountRefs` name
 * is in a tickable prep step for that meal and dish. Each prep step that handles
 * one of its ingredients lists it, so the client can collapse it to "done in prep"
 * once all of them are ticked. Strict on purpose: a step whose salt, oil or
 * buttermilk was never prepped is not done, and collapsing it would hide the part
 * the cook still has to do.
 *
 * The amountRef ids are the dish's own; the step plan's are the plan's folded food
 * identity, so the join goes through `identity` exactly as combinePrep did.
 */
function assignCoversCookSteps(
  build: PrepWeekBuild,
  load: Pick<LoadPrepWeekInputResult, "input" | "identity">,
): void {
  const folded = (id: string) => load.identity?.foldedIdByIngredientId.get(id) ?? id;
  const stepsByPortion = new Map<string, PlannedStep[]>();
  for (const st of build.stepPlan.steps) {
    if (!isTickable(st, build.storageContexts.get(st.stepKey))) continue;
    for (const c of st.components) {
      for (const m of c.measures) {
        if (!m.mealId || !m.dishId || !m.ingredientId) continue;
        const k = `${m.mealId}|${m.dishId}|${m.ingredientId}`;
        const l = stepsByPortion.get(k) ?? [];
        if (!l.includes(st)) l.push(st);
        stepsByPortion.set(k, l);
      }
    }
  }
  const inPlan = new Set(build.stepPlan.steps.flatMap((s) => s.contributesToMealIds));
  for (const meal of load.input.meals) {
    if (!inPlan.has(meal.mealId)) continue;
    for (const dish of meal.dishes) {
      for (const cs of dish.componentSteps) {
        if (cs.phaseType !== "prep" || cs.ingredientIds.length === 0) continue;
        const covering = cs.ingredientIds.map((id) => stepsByPortion.get(`${meal.mealId}|${dish.dishId}|${folded(id)}`));
        if (covering.some((l) => !l || l.length === 0)) continue;
        for (const st of new Set(covering.flat() as PlannedStep[])) {
          const list = (st.coversCookSteps ??= []);
          if (!list.some((x) => x.mealId === meal.mealId && x.dishId === dish.dishId && x.stepIndex === cs.stepIndex)) {
            list.push({ mealId: meal.mealId, dishId: dish.dishId, stepIndex: cs.stepIndex });
          }
        }
      }
    }
  }
}
