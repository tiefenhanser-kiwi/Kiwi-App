// [prepcook] Part J.0 — the prepped path (A1–A4) and the code-rendered portion
// lines (B), over the real engine with a hand-built loader result.
//
// The fixture is four meals on four cook days so every exclusion `isPrepped`
// has to make is present at once: a shared garlic tub (rule 5), a dry blend, a
// protein cooked tomorrow (kept), two proteins 4–5 days out (held by the overlay)
// and a meal whose ONLY prep is a held protein (vacuously prepped).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek, isTickable, tickableStepRefs, type PrepWeekBuild } from "../prepWeekBuild";
import {
  assemblePrepWeekResult,
  renderPortionLines,
  summarizePrepWeek,
  OPENING_MAX,
  PORTION_LINES_MAX,
  type PlannedStep,
} from "../prepWeekAssembly";
import { derivePrepCompletion } from "../prepCompletion";
import { PrepWeekResultSchema } from "../ai/schemas/prepWeek";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const M3 = "33333333-3333-4333-8333-333333333333";
const M4 = "44444444-4444-4444-8444-444444444444";
const D1 = "d1111111-1111-4111-8111-111111111111";
const D2 = "d2222222-2222-4222-8222-222222222222";
const D3 = "d3333333-3333-4333-8333-333333333333";
const D4 = "d4444444-4444-4444-8444-444444444444";
const GARLIC = "a0000000-0000-4000-8000-000000000001";
const ONION = "a0000000-0000-4000-8000-000000000002";
const CHICKEN = "a0000000-0000-4000-8000-000000000003";
const PORK = "a0000000-0000-4000-8000-000000000004";
const SCALLION = "a0000000-0000-4000-8000-000000000005";
const BEEF = "a0000000-0000-4000-8000-000000000006";
const CUMIN = "a0000000-0000-4000-8000-000000000007";
const PAPRIKA = "a0000000-0000-4000-8000-000000000008";
const CORIANDER = "a0000000-0000-4000-8000-000000000009";

const ing = (ingredientId: string, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null) => ({
  ingredientId, ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
const step = (stepIndex: number, phaseType: string, text: string, ingredientIds: string[]) => ({
  stepIndex, phaseType, text, componentKey: null, ingredientIds,
});
const dish = (dishId: string, dishName: string, ingredients: ReturnType<typeof ing>[], componentSteps: ReturnType<typeof step>[] = []) => ({
  dishId, dishName, dishRole: "main" as const, baseServings: 4, authoredBaseServings: 4, ingredients,
  stepTexts: componentSteps.map((s) => s.text), componentSteps,
});

function fixture(): LoadPrepWeekInputResult {
  return {
    input: {
      planId: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
      planName: "J.0 fixture",
      meals: [
        {
          mealId: M1, mealName: "Chicken Stir Fry", cuisine: null, servingsOverride: null,
          dishes: [dish(D1, "Chicken Stir Fry", [
            ing(CHICKEN, "boneless skinless chicken thighs", "Protein", 1.5, "lb", "trimmed and cut into 1-inch pieces"),
            ing(GARLIC, "garlic cloves", "Produce", 3, "cloves", "minced"),
            ing(ONION, "yellow onion", "Produce", 1, "each", "diced"),
            ing(CUMIN, "ground cumin", "Pantry", 1, "tsp", null),
            ing(PAPRIKA, "smoked paprika", "Pantry", 1, "tsp", null),
            ing(CORIANDER, "ground coriander", "Pantry", 1, "tsp", null),
          ], [
            step(0, "prep", "Dice the onion and mince the garlic.", [ONION, GARLIC]),
            step(1, "prep", "Trim the chicken thighs and cut them into 1-inch pieces.", [CHICKEN]),
            step(2, "cook", "Sear the chicken, then add the onion, garlic, cumin, paprika and coriander and cook 5 minutes.", [CUMIN, PAPRIKA, CORIANDER]),
          ])],
        },
        {
          mealId: M2, mealName: "Garlic Pork Chops", cuisine: null, servingsOverride: null,
          dishes: [dish(D2, "Garlic Pork Chops", [
            ing(PORK, "pork chops", "Protein", 1, "lb", "trimmed"),
            ing(GARLIC, "garlic cloves", "Produce", 2, "cloves", "minced"),
          ], [
            step(0, "prep", "Trim the pork chops.", [PORK]),
            step(1, "cook", "Sear the chops with the garlic.", [GARLIC]),
            step(2, "prep", "Rub the minced garlic over the trimmed chops.", [GARLIC, PORK]),
          ])],
        },
        {
          mealId: M3, mealName: "Garlic Rice", cuisine: null, servingsOverride: null,
          dishes: [dish(D3, "Garlic Rice", [
            ing(GARLIC, "garlic cloves", "Produce", 1, "cloves", "minced"),
            ing(SCALLION, "green onions", "Produce", 4, "each", "thinly sliced"),
          ])],
        },
        {
          mealId: M4, mealName: "Steak Night", cuisine: null, servingsOverride: null,
          dishes: [dish(D4, "Steak Night", [ing(BEEF, "flank steak", "Protein", 1.5, "lb", "trimmed")])],
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
  } as unknown as LoadPrepWeekInputResult;
}

/** The route's own path: assemble (with stand-in prose), overlay, summarize, validate. */
function wire(build: PrepWeekBuild) {
  const narration = {
    steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do the thing", instructions: "Do the thing." })),
  };
  const result = summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(build.stepPlan, narration), build));
  const parsed = PrepWeekResultSchema.safeParse(result);
  assert.ok(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.flatten()));
  return result;
}
/** What the phone renders as tickable: not demoted, and not the wash / a cook-day line. */
function renderedKeys(build: PrepWeekBuild): Set<string> {
  return new Set(
    wire(build).phases.flatMap((p) => p.steps.filter((s) => !s.skipSuggested && !s.holdsNoContainer).map((s) => s.stepKey)),
  );
}

describe("Part J.0 A1 — one step set: what isPrepped waits for IS what the screen renders", () => {
  it("the derivation's key set equals the rendered key set", () => {
    const build = buildPrepWeekPlan(fixture());
    const derived = new Set(tickableStepRefs(build).map((r) => r.stepKey));
    assert.deepEqual([...derived].sort(), [...renderedKeys(build)].sort());
    assert.ok(derived.size >= 3, `the fixture has real work to tick: ${[...derived].join(", ")}`);
  });

  it("…and the same holds for a subset", () => {
    const build = buildPrepWeekPlan(fixture(), { scopeMealIds: [M1, M3] });
    const derived = new Set(tickableStepRefs(build).map((r) => r.stepKey));
    assert.deepEqual([...derived].sort(), [...renderedKeys(build)].sort());
  });
});

describe("Part J.0 A2 — isPrepped counts only what the cook can tick", () => {
  it("a held protein (4–5 days out) is on the wire, demoted, and NOT required; tomorrow's is required", () => {
    const build = buildPrepWeekPlan(fixture());
    const res = wire(build);
    const proteins = res.phases.find((p) => p.phase === "proteins")!;
    const pork = proteins.steps.find((s) => s.stepKey === `proteins#${PORK}`)!;
    const chicken = proteins.steps.find((s) => s.stepKey === `proteins#${CHICKEN}`)!;
    assert.equal(pork.skipSuggested, true, "the overlay holds the pork");
    assert.notEqual(chicken.skipSuggested, true, "tomorrow's chicken renders");
    const req = new Set(tickableStepRefs(build).map((r) => r.stepKey));
    assert.ok(!req.has(pork.stepKey));
    assert.ok(req.has(chicken.stepKey));
    assert.ok(proteins.heldForCookDay && proteins.heldForCookDay.length >= 2, "both held proteins are listed");
  });

  it("the wash is not required, and a meal whose only prep is a held protein is vacuously prepped", () => {
    const build = buildPrepWeekPlan(fixture());
    const refs = tickableStepRefs(build);
    assert.ok(!refs.some((r) => r.stepKey === "produce#wash-all"));
    const { perMeal } = derivePrepCompletion([M1, M2, M3, M4], refs, new Set());
    assert.equal(perMeal[M4], true, "Steak Night has nothing tickable");
    assert.equal(perMeal[M1], false);
  });

  it("ticking every rendered step makes every meal prepped", () => {
    const build = buildPrepWeekPlan(fixture());
    const { perMeal, derivedPrepStatus } = derivePrepCompletion([M1, M2, M3, M4], tickableStepRefs(build), renderedKeys(build));
    assert.deepEqual(perMeal, { [M1]: true, [M2]: true, [M3]: true, [M4]: true });
    assert.equal(derivedPrepStatus, "prepped");
  });
});

describe("Part J.0 A3 — subset and full share keys", () => {
  const full = () => buildPrepWeekPlan(fixture());
  const sub = () => buildPrepWeekPlan(fixture(), { scopeMealIds: [M1, M3] });
  const forMeals = (steps: PlannedStep[], meals: string[]) => steps.filter((s) => s.contributesToMealIds.some((m) => meals.includes(m)));

  it("the subset's keys for M are a subset of the full plan's keys for M, with the same container names", () => {
    const f = new Map(forMeals(full().stepPlan.steps, [M1, M3]).map((s) => [s.stepKey, s]));
    for (const s of sub().stepPlan.steps) {
      const twin = f.get(s.stepKey);
      assert.ok(twin, `${s.stepKey} is in the full plan`);
      const names = (st: PlannedStep) => [st.bowlName ?? "", ...st.components.flatMap((c) => c.measures.map((m) => m.destination ?? ""))].filter(Boolean);
      for (const n of names(s)) assert.ok(names(twin!).includes(n), `container "${n}" is the full plan's`);
    }
  });

  it("the shared garlic tub keeps the full plan's label, naming all three dishes", () => {
    const garlic = sub().stepPlan.steps.find((s) => s.stepKey === `produce#${GARLIC}`)!;
    const dests = garlic.components.flatMap((c) => c.measures.map((m) => m.destination));
    assert.ok(dests.every((d) => d === "Minced garlic cloves — Chicken Stir Fry, Garlic Pork Chops, Garlic Rice"), JSON.stringify(dests));
    assert.equal(dests.length, 2, "only the selected meals' portions");
  });

  it("per-dish quantities are the full plan's, scoped to M", () => {
    const amounts = (b: PrepWeekBuild) =>
      new Map(b.stepPlan.steps.flatMap((s) => s.components.flatMap((c) => c.measures.filter((m) => m.mealId === M1 || m.mealId === M3).map((m) => [`${s.stepKey}|${m.dishId}|${c.ingredientName}`, m.amount] as const))));
    const f = amounts(full());
    for (const [k, v] of amounts(sub())) assert.equal(v, f.get(k), k);
  });

  it("a completion written in subset mode counts toward the full plan's isPrepped", () => {
    const { perMeal } = derivePrepCompletion([M1, M2, M3, M4], tickableStepRefs(full()), renderedKeys(sub()));
    assert.equal(perMeal[M1], true);
    assert.equal(perMeal[M3], true);
  });
});

describe("Part J.0 A4 — coversCookSteps", () => {
  it("a prep-phase cook step is listed on every prep step that handled its ingredients", () => {
    const build = buildPrepWeekPlan(fixture());
    const covers = (key: string) => build.stepPlan.steps.find((s) => s.stepKey === key)?.coversCookSteps ?? [];
    const onion = covers(`produce#${ONION}`);
    const garlic = covers(`produce#${GARLIC}`);
    assert.deepEqual(onion, [{ mealId: M1, dishId: D1, stepIndex: 0 }]);
    assert.ok(garlic.some((x) => x.dishId === D1 && x.stepIndex === 0), "the garlic step shares 'dice the onion and mince the garlic'");
    assert.deepEqual(covers(`proteins#${CHICKEN}`), [{ mealId: M1, dishId: D1, stepIndex: 1 }]);
  });

  it("never lists a cook-phase step, nor one whose ingredient is held for cook day", () => {
    const build = buildPrepWeekPlan(fixture());
    const all = build.stepPlan.steps.flatMap((s) => s.coversCookSteps ?? []);
    assert.ok(!all.some((x) => x.dishId === D1 && x.stepIndex === 2), "cook step");
    assert.ok(!all.some((x) => x.dishId === D2 && x.stepIndex === 0), "the pork is held, so 'Trim the pork chops' is cook-day work");
    // Half done is not done: the garlic was minced in prep, the pork was not.
    assert.ok(!all.some((x) => x.dishId === D2 && x.stepIndex === 2), "a step whose pork is held is not done in prep, even though its garlic was");
  });

  it("reaches the wire", () => {
    const res = wire(buildPrepWeekPlan(fixture()));
    const onion = res.phases.flatMap((p) => p.steps).find((s) => s.stepKey === `produce#${ONION}`)!;
    assert.deepEqual(onion.coversCookSteps, [{ mealId: M1, dishId: D1, stepIndex: 0 }]);
  });
});

describe("Part J.0 B — portion lines are the code's", () => {
  const LABEL = "Minced garlic — Beef Enchiladas Verdes, Mexican Street-Style Rice, Texas Chili, Tex-Mex Tacos";
  const measure = (amount: string, forDish: string, destination: string) => ({ amount, forDish, dishRole: "main" as const, destination, qty: Number.parseFloat(amount), unit: "cloves" });

  it("a step with 7 portions renders under the cap, every line with a destination, no raw label in a sentence", () => {
    const own = "Slow-Braised Collard Greens with Bacon — minced garlic and thinly sliced yellow onion";
    const dishes = ["Beef Enchiladas Verdes", "Mexican Street-Style Rice", "Texas-Style Beef Chili with Beans", "Tex-Mex Ground Beef Tacos", "Creamy Hummus", "Slow-Braised Collard Greens with Bacon", "Classic Supreme Pizza"];
    const dests = [LABEL, LABEL, LABEL, LABEL, "Creamy Hummus sauce bowl", own, "Classic Supreme Pizza vegetables"];
    const r = renderPortionLines(
      { components: [{ ingredientName: "garlic cloves", preparationNote: "minced", measures: dishes.map((d, i) => measure(`${i + 2} cloves`, d, dests[i])) }] },
      new Map([[LABEL, "shared" as const], [own, "own-tub" as const]]),
    )!;
    assert.equal(r.lines.length, 7);
    const body = r.lines.join("\n");
    assert.ok(body.length <= PORTION_LINES_MAX, `${body.length}`);
    assert.ok(OPENING_MAX + 1 + body.length <= 800);
    for (const l of r.lines) assert.match(l, / — (into the |same |the same )/, l);
    for (const l of r.lines) assert.ok(!l.includes(LABEL) && !l.includes(own), `raw label in a sentence: ${l}`);
    assert.equal(r.lines[0], "2 cloves for Beef Enchiladas Verdes — into the shared minced-garlic tub");
    assert.match(r.lines[1], /— same tub$/);
    assert.equal(r.lines[5], "7 cloves — into the minced garlic and thinly sliced yellow onion tub for the Slow-Braised Collard Greens with Bacon");
    assert.equal(r.meta.total, "35 cloves");
  });

  it("the census's 1,059-character garlic step fits: four dishes into one shared tub, each line names its dish", () => {
    const label = "Minced garlic — Beef Enchiladas Verdes, Mexican Street-Style Rice, Texas-Style Beef Chili, Tex-Mex Ground Beef Tacos";
    const r = renderPortionLines(
      { components: [{ ingredientName: "garlic cloves", measures: ["Beef Enchiladas Verdes", "Mexican Street-Style Rice", "Texas-Style Beef Chili", "Tex-Mex Ground Beef Tacos"].map((d) => measure("4 cloves", d, label)) }] },
      new Map([[label, "shared" as const]]),
    )!;
    assert.deepEqual(r.lines, [
      "4 cloves for Beef Enchiladas Verdes — into the shared minced-garlic tub",
      "4 cloves for Mexican Street-Style Rice — same tub",
      "4 cloves for Texas-Style Beef Chili — same tub",
      "4 cloves for Tex-Mex Ground Beef Tacos — same tub",
    ]);
  });

  it("J.1 §2 — a dish's own tub reads contents first, dish after: the dried-chile bag, the diced-jalapeño tub", () => {
    const bag = "Texas-Style Beef Chili — dried chiles, stemmed and seeded";
    const tub = "Jalapeño Cheddar Cornbread — diced jalapeño";
    const r = renderPortionLines(
      { components: [
        { ingredientName: "dried ancho chiles", measures: [{ ...measure("3", "Texas-Style Beef Chili", bag), unit: "each" }] },
        { ingredientName: "jalapeño", measures: [{ ...measure("1", "Jalapeño Cheddar Cornbread", tub), unit: "each" }] },
      ] },
      new Map([[bag, "own-bag" as const], [tub, "own-tub" as const]]),
    )!;
    assert.deepEqual(r.lines, [
      "3 dried ancho chiles — into the dried-chile bag for the Texas-Style Beef Chili",
      "1 jalapeño — into the diced-jalapeño tub for the Jalapeño Cheddar Cornbread",
    ]);
  });

  it("over budget, 'for <dish>' goes only where the vessel is the dish's — a shared tub keeps every full dish name", () => {
    const shared = "Minced garlic — Beef Enchiladas Verdes, Mexican Street-Style Rice";
    const jar = "Smoky Chipotle Ground Beef sauce jar";
    const step = {
      components: [{
        ingredientName: "garlic cloves",
        measures: [
          measure("3 cloves", "Beef Enchiladas Verdes", shared),
          measure("2 cloves", "Mexican Street-Style Rice", shared),
          measure("4 cloves", "Smoky Chipotle Ground Beef", jar),
        ],
      }],
    };
    const kinds = new Map([[shared, "shared" as const]]);
    const roomy = renderPortionLines(step, kinds)!;
    assert.equal(roomy.lines[2], `4 cloves for Smoky Chipotle Ground Beef — into the ${jar}`);
    const tight = renderPortionLines(step, kinds, roomy.lines.join("\n").length - 1)!;
    assert.equal(tight.lines[0], "3 cloves for Beef Enchiladas Verdes — into the shared minced-garlic tub");
    assert.equal(tight.lines[1], "2 cloves for Mexican Street-Style Rice — same tub");
    assert.equal(tight.lines[2], `4 cloves — into the ${jar}`);
  });

  it("a count names the food in its number: 3 yellow onions, 1 roma tomato, 3 celery (never 'celeries')", () => {
    const count = (name: string, amount: string) =>
      renderPortionLines({ components: [{ ingredientName: name, measures: [{ amount, forDish: "Soup", dishRole: "main" as const, destination: "Soup vegetables", qty: Number.parseFloat(amount), unit: "each" }] }] })!.lines[0];
    assert.equal(count("yellow onion", "3"), "3 yellow onions for Soup — into the Soup vegetables container");
    assert.equal(count("roma tomatoes", "1"), "1 roma tomato for Soup — into the Soup vegetables container");
    assert.equal(count("celery", "3"), "3 celery for Soup — into the Soup vegetables container");
  });

  it("the fixture's shared garlic step keeps only the portion whose window reaches its day (J.1 R1)", () => {
    const res = wire(buildPrepWeekPlan(fixture()));
    const garlic = res.phases.flatMap((p) => p.steps).find((s) => s.stepKey === `produce#${GARLIC}`)!;
    const lines = garlic.instructions.split("\n");
    assert.equal(lines[0], "Do the thing.");
    // Minced garlic keeps 4 days: Monday's portion is prepped, Friday's and Saturday's wait.
    assert.deepEqual(lines.slice(1), ["3 cloves for Chicken Stir Fry — into the shared minced-garlic-clove tub"]);
    assert.deepEqual(garlic.contributesToMealIds, [M1]);
    assert.ok(garlic.instructions.length <= 800);
  });

  it("isTickable reads today's holds: a step whose every portion waits is not tickable", () => {
    const build = buildPrepWeekPlan(fixture());
    const pork = build.stepPlan.steps.find((s) => s.stepKey === `proteins#${PORK}`)!;
    const chicken = build.stepPlan.steps.find((s) => s.stepKey === `proteins#${CHICKEN}`)!;
    assert.equal(isTickable(pork, build), false);
    assert.equal(isTickable(chicken, build), true);
  });
});
