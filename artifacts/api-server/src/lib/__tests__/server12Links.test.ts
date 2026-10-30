// SERVER-12 A (BUG-626) — a cook step links to the prep steps that did its work through
// the foods its words name, not only through its amountRefs; the link reaches a warm
// cache at read time; and the server's "You prepped this" chip follows the food, not the
// rewording. INV-626's cases: the Meat Sauce's "Finely dice the yellow onion and set
// aside" (no amountRef) and the Meatballs' "Finely dice the yellow onion and mince the
// remaining 2 garlic cloves" (the garlic's only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek } from "../prepWeekBuild";
import { assemblePrepWeekResult } from "../prepWeekAssembly";
import { rewordFeastSteps, type FeastDishFacts, type WordingStep } from "../feastCookWording";
import { ingredientGroupKey } from "../ingredientRelations";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const D1 = "d1111111-1111-4111-8111-111111111111";
const D2 = "d2222222-2222-4222-8222-222222222222";
const ONION = "a0000000-0000-4000-8000-000000000001";
const GARLIC = "a0000000-0000-4000-8000-000000000002";
const BEEF = "a0000000-0000-4000-8000-000000000003";
const BUTTERMILK = "a0000000-0000-4000-8000-000000000004";

const ing = (ingredientId: string, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null) => ({
  ingredientId, ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
const step = (stepIndex: number, phaseType: string, text: string, ingredientIds: string[]) => ({ stepIndex, phaseType, text, componentKey: null, ingredientIds });
const dish = (dishId: string, dishName: string, ingredients: ReturnType<typeof ing>[], componentSteps: ReturnType<typeof step>[]) => ({
  dishId, dishName, dishRole: "main" as const, baseServings: 4, authoredBaseServings: 4, ingredients, stepTexts: componentSteps.map((s) => s.text), componentSteps,
});

/** INV-626's two meals, one shared onion and one shared garlic. */
function fixture(meatballsStep3 = "Finely dice the yellow onion and mince the remaining 2 garlic cloves."): LoadPrepWeekInputResult {
  return {
    input: {
      planId: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
      planName: "SERVER-12 A",
      meals: [
        {
          mealId: M1, mealName: "Weeknight Beef and Mushroom Meat Sauce", cuisine: null, servingsOverride: null,
          dishes: [dish(D1, "Beef and Mushroom Meat Sauce", [
            ing(BEEF, "ground beef (80/20)", "Protein", 1.25, "lb", null),
            ing(ONION, "yellow onion", "Produce", 1, "each", "finely diced"),
            ing(GARLIC, "garlic cloves", "Produce", 4, "cloves", "minced"),
          ], [
            step(0, "prep", "Finely dice the yellow onion and set aside.", []),
            step(1, "prep", "Mince the 4 garlic cloves and set aside.", [GARLIC]),
            step(6, "cook", "Add the diced onion and cook, stirring frequently, for 4–5 minutes until softened.", []),
          ])],
        },
        {
          mealId: M2, mealName: "Classic Tomato Spaghetti and Meatballs", cuisine: null, servingsOverride: null,
          dishes: [dish(D2, "Beef and Pork Meatballs", [
            ing(ONION, "yellow onion", "Produce", 1, "each", "finely diced"),
            ing(GARLIC, "garlic", "Produce", 4, "cloves", "minced"),
            ing(BUTTERMILK, "buttermilk", "Dairy", 0.5, "cup", null),
          ], [
            step(3, "prep", meatballsStep3, [GARLIC]),
            step(5, "cook", "Add the diced onion to the same pot and sauté until softened, about 4 minutes.", []),
          ])],
        },
      ],
    },
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-10-25",
      lagByMealId: new Map([[M1, 1], [M2, 2]]),
      dayNameByMealId: new Map([[M1, "Monday"], [M2, "Tuesday"]]),
    },
    identity: { foldedIdByIngredientId: new Map() },
  } as unknown as LoadPrepWeekInputResult;
}

const coveredBy = (build: ReturnType<typeof buildPrepWeekPlan>, dishId: string, stepIndex: number) =>
  build.stepPlan.steps.filter((s) => (s.coversCookSteps ?? []).some((c) => c.dishId === dishId && c.stepIndex === stepIndex)).map((s) => s.stepKey).sort();

describe("SERVER-12 A — a cook step links through the foods its words name", () => {
  it("the Meat Sauce's onion step, with no amountRef, is linked to the onion's prep step alone", () => {
    const build = buildPrepWeekPlan(fixture());
    assert.deepEqual(coveredBy(build, D1, 0), [`produce#${ONION}`]);
    // the garlic step keeps its amountRef link, unchanged
    assert.deepEqual(coveredBy(build, D1, 1), [`produce#${GARLIC}`]);
  });

  it("the Meatballs' onion-and-garlic step is linked to both: the onion tick chips it, the garlic tick completes it", () => {
    const build = buildPrepWeekPlan(fixture());
    assert.deepEqual(coveredBy(build, D2, 3), [`produce#${GARLIC}`, `produce#${ONION}`].sort());
  });

  it("all or nothing: a named food nobody prepped links nothing by the words (the refs keep their own link)", () => {
    const build = buildPrepWeekPlan(fixture("Finely dice the yellow onion, mince the remaining 2 garlic cloves and soak them in the buttermilk."));
    assert.deepEqual(coveredBy(build, D2, 3), [`produce#${GARLIC}`], "the buttermilk is not prepped: only the garlic's amountRef link stands");
  });

  it("never a cook-phase step", () => {
    const build = buildPrepWeekPlan(fixture());
    assert.deepEqual(coveredBy(build, D1, 6), []);
    assert.deepEqual(coveredBy(build, D2, 5), []);
  });

  it("not in the feast session: Thanksgiving's links are the amountRefs' only", () => {
    const build = buildPrepWeekPlan(fixture(), { feast: true });
    assert.deepEqual(coveredBy(build, D1, 0), []);
    assert.deepEqual(coveredBy(build, D2, 3), [`produce#${GARLIC}`]);
  });

  it("a warm cache gets today's links at read time, and loses a stale one", () => {
    const build = buildPrepWeekPlan(fixture());
    const narration = { steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do the thing", instructions: "Do the thing." })) };
    const fresh = assemblePrepWeekResult(build.stepPlan, narration);
    // A blob cached before the rule: no step carries the words' links; one carries a link that no longer holds.
    const cached = {
      ...fresh,
      phases: fresh.phases.map((p) => ({ ...p, steps: p.steps.map((s) => {
        const { coversCookSteps: _c, ...rest } = s;
        return s.stepKey === `produce#${GARLIC}` ? { ...rest, coversCookSteps: [{ mealId: M1, dishId: D1, stepIndex: 99 }] } : rest;
      }) })),
    };
    const served = finishPrepWeek(cached, build).phases.flatMap((p) => p.steps);
    const onion = served.find((s) => s.stepKey === `produce#${ONION}`)!;
    const garlic = served.find((s) => s.stepKey === `produce#${GARLIC}`)!;
    assert.ok(onion.coversCookSteps?.some((c) => c.dishId === D1 && c.stepIndex === 0));
    assert.ok(onion.coversCookSteps?.some((c) => c.dishId === D2 && c.stepIndex === 3));
    assert.ok(!garlic.coversCookSteps?.some((c) => c.stepIndex === 99), "the stale link is gone");
  });

  it("the feast session's cached links are served as cached", () => {
    const build = buildPrepWeekPlan(fixture(), { feast: true });
    const narration = { steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do the thing", instructions: "Do the thing." })) };
    const fresh = assemblePrepWeekResult(build.stepPlan, narration);
    const cached = { ...fresh, phases: fresh.phases.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, coversCookSteps: [{ mealId: M1, dishId: D1, stepIndex: 42 }] })) })) };
    const served = finishPrepWeek(cached, build).phases.flatMap((p) => p.steps);
    assert.ok(served.every((s) => s.coversCookSteps?.[0]?.stepIndex === 42));
  });
});

describe("SERVER-12 A — the server reads foods the way the app does (drift guard)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CLIENT = resolve(here, "../../../../kiwi/lib/cooking/prepFoods.ts");
  const SERVER = resolve(here, "../prepFoods.ts");
  const block = (src: string) => {
    const start = src.indexOf("/** Words that name a part of a food");
    const end = src.indexOf("export function namedFoods(");
    assert.ok(start >= 0 && end > start, "markers");
    const close = src.indexOf("\n}\n", end);
    return src.slice(start, close + 2);
  };
  it("the PART…namedFoods block is the client's, byte for byte", { skip: !existsSync(CLIENT) && "client file not on disk" }, () => {
    assert.equal(block(readFileSync(SERVER, "utf8")), block(readFileSync(CLIENT, "utf8")));
  });
});

describe("SERVER-12 A — the use-step chip follows the food, not the wording", () => {
  const rows = [
    { ingredientId: "on", name: "yellow onion" },
    { ingredientId: "mu", name: "cremini mushrooms" },
    { ingredientId: "sa", name: "kosher salt" },
  ];
  const facts = (extra: Partial<FeastDishFacts> = {}): FeastDishFacts => ({
    dishId: "st", mixes: [],
    cuts: [{ id: "on", key: ingredientGroupKey("yellow onion"), into: "Stroganoff plate", note: "thinly sliced", kind: "plate", containerId: "plate#st" }],
    ...extra,
  });
  const steps: WordingStep[] = [
    { stepIndex: 2, text: "Thinly slice the yellow onion and slice the cremini mushrooms; set each aside.", amountRefs: null },
    { stepIndex: 4, text: "Reduce heat to medium and sauté the sliced onion with ½ teaspoon salt until soft.", amountRefs: null },
    { stepIndex: 5, text: "Add the mushrooms and the onion back to the pan.", amountRefs: null },
  ];
  const chips = (out: WordingStep[]) => out.map((s) => (s.preppedRefs ?? []).map((r) => r.label));

  it("\"sauté the sliced onion\", said as written, carries the plate's chip when the cut step is linked", () => {
    const out = rewordFeastSteps(steps, rows, facts({ linked: new Set([2]) }), ["Creamy Beef and Mushroom Stroganoff"], { weeknight: true });
    assert.equal(out[1].text, steps[1].text, "the words stay");
    assert.deepEqual(chips(out), [[], ["Stroganoff plate"], []], "one chip, where the dish first uses it");
  });

  it("with no link on the cut step, the chip is on the first step that names the food", () => {
    const out = rewordFeastSteps(steps, rows, facts(), ["Creamy Beef and Mushroom Stroganoff"], { weeknight: true });
    assert.deepEqual(chips(out), [["Stroganoff plate"], [], []]);
  });

  it("a step asking another cut is not this cut's use", () => {
    const diced: WordingStep[] = [
      { stepIndex: 0, text: "Dice the yellow onion.", amountRefs: null },
      { stepIndex: 1, text: "Sauté the sliced onion until soft.", amountRefs: null },
    ];
    const out = rewordFeastSteps(diced, rows, facts(), ["Stroganoff"], { weeknight: true });
    assert.deepEqual(chips(out), [[], ["Stroganoff plate"]]);
  });

  it("a feast's words are untouched by it", () => {
    const out = rewordFeastSteps(steps, rows, facts({ linked: new Set([2]) }), ["Creamy Beef and Mushroom Stroganoff"]);
    assert.deepEqual(chips(out)[1], []);
  });
});
