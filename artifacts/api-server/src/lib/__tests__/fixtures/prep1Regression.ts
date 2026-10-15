// PREP-1 F — the non-Thanksgiving regression week. Shared, VERBATIM, by the test
// (prep1Regression.test.ts) and by the one-off generator that ran it against the
// pre-PREP-1 engine (54a1533) to write prep1Regression.pre.json. Keep it free of any
// import that did not exist at 54a1533, so the same file runs on both sides.
//
// Four dinners on four cook days — a shared garlic tub, a dry blend, a protein cooked
// tomorrow, two held for cook day — plus the two kinds of engine demotion Part A takes
// off the wire: whole cherry tomatoes (nothing to cut) and a diced avocado (browns
// once cut). No meal is tagged `thanksgiving-feast`.

type Narration = { steps: { stepId: string; title: string; instructions: string }[] };

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const M3 = "33333333-3333-4333-8333-333333333333";
const M4 = "44444444-4444-4444-8444-444444444444";
const D = (n: number) => `d${n}111111-1111-4111-8111-111111111111`;
const I = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ing = (n: number, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null) => ({
  ingredientId: I(n), ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
const step = (stepIndex: number, phaseType: string, text: string, ids: number[]) => ({
  stepIndex, phaseType, text, componentKey: null, ingredientIds: ids.map(I),
});
const dish = (n: number, dishName: string, ingredients: ReturnType<typeof ing>[], componentSteps: ReturnType<typeof step>[] = []) => ({
  dishId: D(n), dishName, dishRole: "main" as const, baseServings: 4, authoredBaseServings: 4, ingredients,
  stepTexts: componentSteps.map((s) => s.text), componentSteps,
});

/** The loader result (typed loosely so it compiles against either engine). */
export function regressionWeek(): unknown {
  return {
    input: {
      planId: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
      planName: "PREP-1 regression week",
      meals: [
        {
          mealId: M1, mealName: "Chicken Stir Fry", cuisine: null, servingsOverride: null,
          dishes: [dish(1, "Chicken Stir Fry", [
            ing(3, "boneless skinless chicken thighs", "Protein", 1.5, "lb", "trimmed and cut into 1-inch pieces"),
            ing(1, "garlic cloves", "Produce", 3, "cloves", "minced"),
            ing(2, "yellow onion", "Produce", 1, "each", "diced"),
            ing(7, "ground cumin", "Pantry", 1, "tsp", null),
            ing(8, "smoked paprika", "Pantry", 1, "tsp", null),
            ing(9, "ground coriander", "Pantry", 1, "tsp", null),
            ing(10, "avocado", "Produce", 1, "each", "diced"),
          ], [
            step(0, "prep", "Dice the onion and mince the garlic.", [2, 1]),
            step(1, "prep", "Trim the chicken thighs and cut them into 1-inch pieces.", [3]),
            step(2, "cook", "Sear the chicken, then add the onion, garlic, cumin, paprika and coriander and cook 5 minutes.", [7, 8, 9]),
            step(3, "assemble", "Top with the diced avocado.", [10]),
          ])],
        },
        {
          mealId: M2, mealName: "Garlic Pork Chops", cuisine: null, servingsOverride: null,
          dishes: [dish(2, "Garlic Pork Chops", [
            ing(4, "pork chops", "Protein", 1, "lb", "trimmed"),
            ing(1, "garlic cloves", "Produce", 2, "cloves", "minced"),
          ], [
            step(0, "prep", "Trim the pork chops.", [4]),
            step(1, "cook", "Sear the chops with the garlic.", [1]),
            step(2, "prep", "Rub the minced garlic over the trimmed chops.", [1, 4]),
          ])],
        },
        {
          mealId: M3, mealName: "Garlic Rice", cuisine: null, servingsOverride: null,
          dishes: [dish(3, "Garlic Rice", [
            ing(1, "garlic cloves", "Produce", 1, "cloves", "minced"),
            ing(5, "green onions", "Produce", 4, "each", "thinly sliced"),
            ing(11, "cherry tomatoes", "Produce", 1, "cup", null),
          ], [
            step(0, "cook", "Cook the rice with the garlic.", [1]),
            step(1, "assemble", "Scatter the green onions and the cherry tomatoes over the rice.", [5, 11]),
          ])],
        },
        {
          mealId: M4, mealName: "Steak Night", cuisine: null, servingsOverride: null,
          dishes: [dish(4, "Steak Night", [ing(6, "flank steak", "Protein", 1.5, "lb", "trimmed")])],
        },
      ],
    },
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-10-04",
      lagByMealId: new Map([[M1, 1], [M2, 5], [M3, 6], [M4, 4]]),
      dayNameByMealId: new Map([[M1, "Monday"], [M2, "Friday"], [M3, "Saturday"], [M4, "Thursday"]]),
    },
    identity: { foldedIdByIngredientId: new Map() },
  };
}

/** Deterministic stand-in prose, keyed on the step id the narrator is handed. */
export function stubNarration(steps: readonly { stepId: string }[]): Narration {
  return { steps: steps.map((s) => ({ stepId: s.stepId, title: `Title ${s.stepId}`, instructions: `Do ${s.stepId}.` })) };
}
