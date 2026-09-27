// Row 13 "Test Kitchen" · Block 2b (BUG-315) — WHICH STEPS A RECIPE RENDERS.
//
// 🔴 WHY THIS FILE EXISTS. The guest recipe screen DID have a steps section. It
// read `meal.steps` — the MEAL-OWNED array — which is empty on exactly the meals
// the Test Kitchen serves: a multi-dish catalog meal carries its steps on
// `dishes[].steps` (8 per dish in the browser pass) and leaves the meal-owned
// array at []. So `meal.steps.length > 0 ? <section/> : null` rendered nothing,
// on every meal, and the section's absence looked like a screen that had no
// steps rather than one reading the wrong field.
//
// app/meal/[id].tsx already got this right, in two locals computed inline
// (`stepsAreGrouped` / `flatSteps`) inside a 700-line component — i.e. inside
// app/**, which the test glob excludes (D-WS9-164), with a member-only screen's
// worth of dependencies around them. That is the "extract the pure part to lib/"
// case in Block 2b's ruling 2: the decision moves here, both screens call it,
// and it is finally pinned by tests.
//
// The rule, unchanged from the member screen (PRD §10.6): steps are genuinely
// DISH-owned only when the meal-owned array is empty. composeMealDetail copies
// meal-owned steps onto every dish as a fallback otherwise, so grouping those
// would print the same steps once per dish.

/** The step-bearing shape both screens hold. Generic in the step type so
 *  neither MealStep nor the dish-detail step shape needs importing here. */
export interface MealStepsSource<S> {
  steps: S[];
  dishes: { steps: S[] }[];
}

/**
 * True when the steps belong to the dishes and should render under per-dish
 * headings; false for the one flat numbered list.
 *
 * Requires all three: more than one dish (a single dish's heading is noise),
 * an empty meal-owned array (else the dish copies are duplicates of it), and at
 * least one dish that actually carries steps (else grouping renders nothing).
 */
export function mealStepsAreGrouped<S>(meal: MealStepsSource<S>): boolean {
  return (
    meal.dishes.length > 1 &&
    meal.steps.length === 0 &&
    meal.dishes.some((dish) => dish.steps.length > 0)
  );
}

/**
 * The flat list: the meal-owned steps when it has any, else every dish's steps
 * in dish order.
 *
 * ⚠️ This is also the answer to "how many steps does the screen render", in
 * BOTH layouts — in the grouped one the meal-owned array is empty by definition,
 * so the per-dish sections render exactly these same steps, regrouped. That
 * invariant is what the BUG-315 test asserts against the payload count.
 */
export function flatMealSteps<S>(meal: MealStepsSource<S>): S[] {
  return meal.steps.length > 0 ? meal.steps : meal.dishes.flatMap((dish) => dish.steps);
}

/**
 * The dishes a grouped layout renders a heading for — the ones with steps. A
 * dish with none gets no empty section.
 */
export function stepBearingDishes<D extends { steps: unknown[] }>(dishes: D[]): D[] {
  return dishes.filter((dish) => dish.steps.length > 0);
}
