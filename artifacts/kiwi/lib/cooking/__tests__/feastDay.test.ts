// PREP-2 — which of a Thanksgiving dish's steps belong to which day (feastDay.ts),
// a dish's Cook Mode in plan context (cookSession.flattenPlanDishSteps), and the
// dish screen's servings (lib/dishes/planDish.ts). The step texts are the dev
// catalog's, verbatim up to the first clause (THX-2G-F's phrase contract).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MealDetail, MealStep } from "@/lib/api/meals";
import { flattenMealSteps, flattenPlanDishSteps, sequenceMealSteps } from "@/lib/cooking/cookSession";
import { decodeRun, encodeRun, makeAheadRunSteps, onTheDayMeal, onTheDaySteps, runCookLine } from "@/lib/cooking/feastDay";
import { planDishView } from "@/lib/dishes/planDish";
import { formatIngredientLine } from "@/lib/format/ingredientLine";

export const CLASSIC_TURKEY = [
  "Thaw (start Friday): If the turkey is frozen, transfer it to the fridge on Friday.",
  "Make ahead (Wednesday night): Dissolve ½ cup kosher salt and ¼ cup light brown sugar in 1 gallon cold water.",
  "Make ahead (Wednesday night): Add 1 tablespoon black peppercorns, 3 thyme sprigs, 2 rosemary sprigs.",
  "Make ahead (Wednesday night): Pat the turkey dry with paper towels and submerge the bird in the brine.",
  "Make ahead (Wednesday night): Mash 6 tablespoons softened butter with 3 minced garlic cloves.",
  "On Thursday: Remove the turkey from the brine, discard the brine, and pat the bird very dry.",
  "Preheat the oven to 325°F.",
  "Loosen the skin over the breast and thighs and rub all of the herb butter directly onto the meat.",
  "Stuff the cavity with the quartered onion; tie the legs together with kitchen twine.",
  "Place the turkey breast side up on a rack and roast at 325°F for 3 to 3½ hours.",
  "Transfer the turkey to a cutting board and let it rest.",
  "Carve the turkey and arrange on a large platter.",
];
// Make-Ahead's stuffing (tagged ahead-wed): the bread dries out on Tuesday.
export const OVERNIGHT_STUFFING = [
  "Make ahead (Tuesday): Cut 1½ lb rustic white bread into ¾-inch cubes and leave uncovered.",
  "Make ahead (Wednesday): Melt 8 tablespoons butter in a 12-inch skillet over medium heat.",
  "Make ahead (Wednesday): Stir in the minced garlic, ¼ cup chopped sage.",
  "Make ahead (Wednesday): Toss the dried bread cubes with the cooked vegetable mixture.",
  "Make ahead (Wednesday): Whisk 3 beaten eggs into 3 cups low-sodium stock.",
  "Make ahead (Wednesday): Butter a 9×13-inch baking dish, cover tightly with foil, and refrigerate overnight.",
  "On Thursday: Preheat the oven to 375°F.",
  "Bake the stuffing, still covered in foil, for 30 minutes; uncover and bake 20–25 minutes more.",
  "Serve the stuffing directly from the baking dish.",
];
// A run whose simmer is unprefixed (the model prefixes only a run's first step).
export const UNPREFIXED_RUN = [
  "Make ahead (Monday): Combine the cranberries, sugar and orange juice in a saucepan.",
  "Bring to a boil, then simmer 12–15 minutes until the cranberries burst.",
  "Cool, then refrigerate up to 7 days.",
  "On Thursday: Spoon into a serving bowl.",
];

const t = (texts: string[]) => texts.map((text) => ({ text }));
const idx = (texts: string[], out: { text: string }[] | null) => out?.map((s) => texts.indexOf(s.text)) ?? null;

describe("PREP-2 — a make-ahead row's run", () => {
  it("the Classic turkey: the thaw is one step, Wednesday night is the brine and the butter", () => {
    assert.deepEqual(idx(CLASSIC_TURKEY, makeAheadRunSteps(t(CLASSIC_TURKEY), { kind: "thaw", dayName: "Friday" })), [0]);
    assert.deepEqual(idx(CLASSIC_TURKEY, makeAheadRunSteps(t(CLASSIC_TURKEY), { kind: "brine", dayName: "Wednesday" })), [1, 2, 3, 4]);
    // A brine is the NIGHT: Wednesday's day run is not it.
    assert.equal(makeAheadRunSteps(t(CLASSIC_TURKEY), { kind: "make", dayName: "Wednesday" }), null);
  });

  it("Make-Ahead's stuffing: Wednesday's row is Wednesday's steps (Tuesday's bread step has no row)", () => {
    assert.deepEqual(idx(OVERNIGHT_STUFFING, makeAheadRunSteps(t(OVERNIGHT_STUFFING), { kind: "make", dayName: "Wednesday" })), [1, 2, 3, 4, 5]);
    assert.deepEqual(idx(OVERNIGHT_STUFFING, makeAheadRunSteps(t(OVERNIGHT_STUFFING), { kind: "make", dayName: "Tuesday" })), [0]);
  });

  it("an unprefixed simmer stays in its run, up to 'On Thursday:'", () => {
    assert.deepEqual(idx(UNPREFIXED_RUN, makeAheadRunSteps(t(UNPREFIXED_RUN), { kind: "make", dayName: "Monday" })), [0, 1, 2]);
  });

  it("no such run → null (the caller cooks the whole dish); the day matches case-insensitively", () => {
    assert.equal(makeAheadRunSteps(t(["Season with salt.", "Roast 1 hour."]), { kind: "make", dayName: "Monday" }), null);
    assert.deepEqual(makeAheadRunSteps(t(["MAKE AHEAD (monday): Zest 2 oranges."]), { kind: "make", dayName: "Monday" })?.length, 1);
  });

  it("the run rides a route param and back; anything else is no run", () => {
    assert.equal(encodeRun({ kind: "brine", dayName: "Tuesday" }), "brine:Tuesday");
    assert.deepEqual(decodeRun("brine:Tuesday"), { kind: "brine", dayName: "Tuesday" });
    assert.equal(decodeRun(undefined), null);
    assert.equal(decodeRun("bake:Tuesday"), null);
    assert.equal(runCookLine({ kind: "brine", dayName: "Tuesday" }), "Cook Mode opens the Tuesday night steps.");
    assert.equal(runCookLine({ kind: "make", dayName: "Monday" }), "Cook Mode opens the Monday make-ahead steps.");
  });
});

function step(text: string, stepIndex: number): MealStep {
  return {
    stepIndex,
    text,
    estimatedMinutes: 5,
    phaseType: "prep",
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
  } as MealStep;
}

function feast(effectiveServings: number): MealDetail {
  return {
    id: "feast",
    title: "Classic Thanksgiving",
    servings: 10,
    authoredServingsDefault: 10,
    effectiveServings,
    tags: ["thanksgiving-feast"],
    steps: [],
    dishes: [
      {
        dishId: "turkey",
        title: "Herb-Roasted Whole Turkey",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 300,
        difficulty: "medium",
        servings: 10,
        authoredServingsDefault: 10,
        ingredients: [],
        // stepIndex is the persisted index, deliberately not the array position.
        steps: CLASSIC_TURKEY.map((text, i) => step(text, i + 10)),
      },
      {
        dishId: "cran",
        title: "Cranberry-Orange Sauce",
        roleLabel: "side",
        positionIndex: 1,
        minutes: 30,
        difficulty: "easy",
        servings: 10,
        authoredServingsDefault: 10,
        ingredients: [{ name: "fresh cranberries", quantity: 24, unit: "ounce", preparationNote: null, category: "Produce", isOptional: false }],
        steps: UNPREFIXED_RUN.map((text, i) => step(text, i)),
      },
    ],
  } as unknown as MealDetail;
}

describe("PREP-2 item 2 — Cook Mode for one dish of the feast", () => {
  it("with the row's run: only that run, keyed by dish and persisted stepIndex", () => {
    const steps = flattenPlanDishSteps(feast(10), "turkey", { kind: "brine", dayName: "Wednesday" });
    assert.deepEqual(steps.map((s) => s.key), ["turkey#11", "turkey#12", "turkey#13", "turkey#14"]);
    assert.ok(steps.every((s) => s.dishId === "turkey" && s.dishTitle === undefined));
  });
  it("no run, or a run the dish does not have: the whole dish; an unknown dish: nothing", () => {
    assert.equal(flattenPlanDishSteps(feast(10), "turkey", null).length, 12);
    assert.equal(flattenPlanDishSteps(feast(10), "turkey", { kind: "make", dayName: "Monday" }).length, 12);
    assert.deepEqual(flattenPlanDishSteps(feast(10), "nope", null), []);
  });
});

describe("PREP-2 item 2 — the dish reads at the plan's servings, the way meal detail does", () => {
  it("at the feast's own 10: serves 10, amounts as written", () => {
    const v = planDishView(feast(10), "cran")!;
    assert.deepEqual([v.servings, v.multiplier], [10, 1]);
    assert.equal(formatIngredientLine(v.dish.ingredients[0], { multiplier: v.multiplier }), "24 ounces fresh cranberries");
  });
  it("at 8: serves 8, amounts × 0.8", () => {
    const v = planDishView(feast(8), "cran")!;
    assert.deepEqual([v.servings, v.multiplier], [8, 0.8]);
    assert.equal(formatIngredientLine(v.dish.ingredients[0], { multiplier: v.multiplier }), "19¼ ounces fresh cranberries");
  });
  it("a meal that no longer holds the dish: null (the screen falls back to the dish alone)", () => {
    assert.equal(planDishView(feast(10), "gone"), null);
  });
});

// ── PREP-2 item 3 — the feast's Cook Mode is Thursday's ────────────────────────

describe("PREP-2 item 3 — the feast day's steps", () => {
  // The same literal vectors as api-server mealTimingBug418.test.ts (the server's
  // onTheDaySteps): the two readings must agree step for step.
  it("the Classic turkey cooks from 'On Thursday:' on; the thaw and the brine are runs", () => {
    assert.deepEqual(idx(CLASSIC_TURKEY, onTheDaySteps(t(CLASSIC_TURKEY))), [5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(idx(OVERNIGHT_STUFFING, onTheDaySteps(t(OVERNIGHT_STUFFING))), [6, 7, 8]);
    assert.deepEqual(idx(UNPREFIXED_RUN, onTheDaySteps(t(UNPREFIXED_RUN))), [3]);
    // A recipe with no prefixes at all is all feast day (the Wellington).
    assert.deepEqual(onTheDaySteps(t(["Chop the mushrooms.", "Bake 30 minutes."])).length, 2);
  });

  it("a feast's Cook Mode (both paths) leaves the runs out; the §27 append does not put them back", () => {
    const meal = feast(10);
    const flat = flattenMealSteps(onTheDayMeal(meal));
    // The turkey's persisted stepIndex is its array position + 10 (see `feast`).
    assert.deepEqual(flat.map((s) => `${s.dishId}@${s.stepIndex}`), [
      "turkey@15", "turkey@16", "turkey@17", "turkey@18", "turkey@19", "turkey@20", "turkey@21", "cran@3",
    ]);
    // An older server that still sequenced every step: its make-ahead entries have
    // nothing to map to, and the append adds only what the feast day holds.
    const seq = meal.dishes.flatMap((d) =>
      d.steps.map((s, i) => ({ sequenceIndex: i, dishId: d.dishId, originalStepIndex: s.stepIndex, reason: null, startOffsetMinutes: null })),
    );
    const sequenced = sequenceMealSteps(onTheDayMeal(meal), seq as never);
    assert.equal(sequenced.length, 8);
    assert.ok(sequenced.every((s) => !/^(make ahead|thaw) \(/i.test(s.text)), sequenced.map((s) => s.text).join("\n"));
  });

  it("a meal NOT tagged thanksgiving-feast is the same object, and cooks every step as before", () => {
    const ordinary = { ...feast(10), tags: ["american", "thanksgiving"] } as MealDetail;
    assert.equal(onTheDayMeal(ordinary), ordinary);
    assert.deepEqual(flattenMealSteps(onTheDayMeal(ordinary)), flattenMealSteps(ordinary));
    assert.equal(flattenMealSteps(ordinary).length, 16);
  });
});
