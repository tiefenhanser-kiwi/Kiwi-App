// QA-NIGHT-2 A — Cook Mode's "Done in prep" fold and its "You prepped this"
// chips, computed by the APP'S OWN functions (kiwi/lib/cooking/cookSession.ts),
// not a model of them, so R7 cannot drift from the app again (QA-NIGHT-1's model
// kept the pre-CLIENT-6 fold and reported BUG-583/584 after both were fixed).
//
// What app/cook-session.tsx does, and what this file passes it:
//   • a plan launch: the fold reads the plan's prep-week payload (POST
//     …/prep-week's result) and its completions — here the week session and the
//     household's ticks;
//   • Recipes tab → "Yes, I prepped" (no plan on the launch): the meal is read
//     through its item in THIS WEEK's plan (preppedReadPlanItemId) with
//     ?prepped=1, and the fold takes that plan's free structure with every
//     undemoted step done (preppedAnswerPlanId → preppedAnswerFold). No such
//     plan: nothing folds;
//   • either way doneInPrepStepKeys(steps, prep, mealId, checked, meal.dishes)
//     and prepChips(…, done) on the steps as the meal read serves them.
//
// The kiwi package is CommonJS to tsx: read each module through its namespace
// (QA-COOK-1's appView.ts does the same).
import * as cookSessionNs from "../../../kiwi/lib/cooking/cookSession";

import type { PlanMeal, PrepStep, RecipeStep } from "./types";

const cjs = <T>(ns: T): T => (ns as { default?: T }).default ?? ns;
const { doneInPrepStepKeys, prepChips, preppedAnswerFold, preppedAnswerPlanId, preppedReadPlanItemId } = cjs(cookSessionNs);

export { preppedAnswerPlanId, preppedReadPlanItemId };

/** The fold's input: the prep steps it reads and the keys it counts as done. */
export type FoldStep = Pick<PrepStep, "stepKey" | "title"> & Partial<Pick<PrepStep, "instructions" | "coversCookSteps" | "containerNames" | "containerId" | "skipSuggested">>;

export interface FoldInput {
  steps: FoldStep[];
  checked: Set<string>;
}

export interface MealFold {
  /** "dishId#idx" keys the app folds into "Done in prep". */
  done: Set<string>;
  /** "dishId#idx" → the chips the app adds to a step it shows in full. */
  chips: Map<string, { containerId: string; label: string }[]>;
}

/** A plan launch: the week's payload and the plan's ticks. */
export function planFold(prepSteps: PrepStep[], ticked: Set<string>): FoldInput {
  return { steps: prepSteps, checked: new Set(ticked) };
}

/** "Yes, I prepped": the structure of the plan the app folds by, every undemoted step done. */
export function answerFold(structure: { steps: FoldStep[] }): FoldInput {
  const f = preppedAnswerFold(structure as Parameters<typeof preppedAnswerFold>[0]);
  return { steps: f.prep.phases.flatMap((p) => [...p.steps]) as FoldStep[], checked: new Set(f.checked) };
}

/** The app's fold and chips for one meal's Cook Mode read ("dishId#idx" → step). */
export function appFold(meal: PlanMeal, after: Record<string, RecipeStep>, fold: FoldInput | null): MealFold {
  if (!fold) return { done: new Set(), chips: new Map() };
  // CookStep as the screen builds it from the read: the key is ours ("dishId#idx");
  // meal-owned steps carry no dishId, so no prep step can cover them.
  const steps = Object.entries(after).map(([key, s]) => {
    const dishId = key.split("#")[0];
    return {
      key, text: s.text, phaseType: s.phaseType, estimatedMinutes: s.estimatedMinutes, isTimingSensitive: false,
      ...(dishId !== "meal" ? { dishId, stepIndex: s.stepIndex } : {}),
      ...(s.preppedRefs ? { preppedRefs: s.preppedRefs } : {}),
    };
  });
  const prep = { phases: [{ steps: fold.steps }] };
  const done = doneInPrepStepKeys(steps as never, prep as never, meal.mealId, fold.checked, meal.dishes);
  const chips = prepChips(steps as never, prep as never, meal.mealId, fold.checked, done);
  return { done, chips };
}
