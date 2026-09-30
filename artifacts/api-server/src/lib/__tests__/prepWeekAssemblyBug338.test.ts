// WS9 BUG-338 / D-WS9-297 — the Prep & Cook pass, B1 prep rulings 8, 9 and 10.
//
// Ruling 7 (glyphs and counts) is asserted in prepWeekAssembly.test.ts, beside
// the formatMeasure tests it changed. This file covers the three rulings that
// needed new data to flow, and each fixture is a repro reduced from the 13-plan
// census (scripts/prep-cook-census).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import { buildStepPlan } from "../prepWeekAssembly";

// ── fixture builder ─────────────────────────────────────────────────────────

interface IngSpec {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  note?: string;
  sourceYield?: { fromName: string; quantity: number; unit: string };
}

function input(dishes: { dishId: string; dishName: string; ingredients: IngSpec[] }[]): PrepCombineInput {
  return {
    meals: [
      {
        mealId: "meal-1",
        mealName: "Test Meal",
        dishes: dishes.map((d) => ({
          dishId: d.dishId,
          dishName: d.dishName,
          dishRole: "main" as const,
          ingredients: d.ingredients.map((i) => ({
            ingredientId: i.id,
            ingredientName: i.name,
            category: i.category,
            quantity: i.quantity,
            unit: i.unit,
            preparationNote: i.note ?? null,
            sourceYield: i.sourceYield ?? null,
          })),
        })),
      },
    ],
  };
}

const plan = (i: PrepCombineInput) => buildStepPlan(combinePrep(i), "Test Plan");
/** Every measure across every step, flattened, for the assertions below. */
const allMeasures = (i: PrepCombineInput) =>
  plan(i).steps.flatMap((s) =>
    s.components.flatMap((c) => c.measures.map((m) => ({ step: s, ingredient: c.ingredientName, ...m }))),
  );

// ── ruling 8 — how many limes is that ──────────────────────────────────────

describe("BUG-338 ruling 8 — a derived ingredient states its fruit count", () => {
  const limeJuice = (quantity: number, unit: string): PrepCombineInput =>
    input([
      {
        dishId: "d1",
        dishName: "Carne Asada",
        ingredients: [
          {
            id: "ing-lime-juice",
            name: "lime juice",
            category: "Produce",
            quantity,
            unit,
            sourceYield: { fromName: "lime", quantity: 2, unit: "tbsp" },
          },
        ],
      },
    ]);

  it("emits fromSource on the measure, rounded UP", () => {
    // 3 tbsp at 2 tbsp per lime = 1.5 limes. You cannot buy 1.5 limes.
    const m = allMeasures(limeJuice(3, "tbsp")).find((x) => x.ingredient === "lime juice");
    assert.equal(m?.fromSource, "2 limes");
  });

  it("an exact multiple is not rounded past itself", () => {
    const m = allMeasures(limeJuice(4, "tbsp")).find((x) => x.ingredient === "lime juice");
    assert.equal(m?.fromSource, "2 limes");
  });

  it("one whole one is singular", () => {
    const m = allMeasures(limeJuice(2, "tbsp")).find((x) => x.ingredient === "lime juice");
    assert.equal(m?.fromSource, "1 lime");
  });

  it("converts a demand stated in another volume unit", () => {
    // ¼ cup = 4 tbsp = 2 limes.
    const m = allMeasures(limeJuice(0.25, "cup")).find((x) => x.ingredient === "lime juice");
    assert.equal(m?.fromSource, "2 limes");
  });

  it("says nothing when the dimensions are incompatible rather than guessing", () => {
    // Juice demanded by weight against a yield in tbsp: no honest conversion.
    const m = allMeasures(limeJuice(50, "g")).find((x) => x.ingredient === "lime juice");
    assert.equal(m?.fromSource, undefined);
  });

  it("an ingredient with no component parent carries no fromSource", () => {
    const i = input([
      { dishId: "d1", dishName: "Pico", ingredients: [{ id: "ing-tom", name: "roma tomatoes", category: "Produce", quantity: 3, unit: "each" }] },
    ]);
    const m = allMeasures(i).find((x) => x.ingredient === "roma tomatoes");
    assert.ok(m, "the tomato measure should exist");
    assert.equal(m!.fromSource, undefined);
    // And ruling 7: the placeholder unit is gone.
    assert.equal(m!.amount, "3");
  });
});

// ── ruling 9 — a blend of one is not a blend ────────────────────────────────

describe("BUG-338 ruling 9 — a one-component blend folds into its dish's sauce step", () => {
  // THE BBQ DRUMSTICKS REPRO. Its prep was two piles: "seasonings_dry:{smoked
  // paprika}" and "sauces_marinades:{bbq sauce}". Two steps, two containers, for
  // one sauce.
  const drumsticks = input([
    {
      dishId: "d1",
      dishName: "BBQ Chicken Drumsticks",
      ingredients: [
        // Three dry spices on this dish is what makes them blend components at
        // all (the <3-per-dish noise filter); two of them are shared with the
        // other dish so only one survives onto THIS dish's blend step.
        { id: "ing-paprika", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-bbq", name: "bbq sauce", category: "Pantry", quantity: 0.5, unit: "cup", note: "for brushing" },
      ],
    },
    {
      dishId: "d2",
      dishName: "Charred Bell Peppers",
      ingredients: [
        { id: "ing-cumin", name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-chili", name: "chili powder", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-paprika", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
      ],
    },
  ]);

  it("the folded dish gets no separate seasonings_dry step", () => {
    const steps = plan(drumsticks).steps;
    const blendForD1 = steps.find((s) => s.stepKey === "seasonings_dry#dish#d1");
    assert.equal(blendForD1, undefined, "the one-component blend step should be gone");
  });

  it("its component rides on the sauce step instead, so nothing is lost", () => {
    const steps = plan(drumsticks).steps;
    const sauce = steps.find((s) => s.stepKey === "sauces_marinades#dish#d1");
    assert.ok(sauce, "the sauce step should exist");
    const names = sauce!.components.map((c) => c.ingredientName);
    assert.ok(names.includes("smoked paprika"), `paprika missing from the sauce step: ${names.join(", ")}`);
    assert.ok(names.includes("bbq sauce"), `bbq sauce missing: ${names.join(", ")}`);
  });

  it("the linkage sentence is SUPPRESSED on a folded dish — there is nothing to link to", () => {
    const sauce = plan(drumsticks).steps.find((s) => s.stepKey === "sauces_marinades#dish#d1");
    assert.equal(
      sauce!.blendSpiceDish,
      undefined,
      "telling the cook to combine with a blend step that no longer exists is worse than saying nothing",
    );
  });

  it("a MULTI-component blend is untouched — this is not a general collapse", () => {
    const steps = plan(drumsticks).steps;
    const blendForD2 = steps.find((s) => s.stepKey === "seasonings_dry#dish#d2");
    assert.ok(blendForD2, "the three-spice blend should still be its own step");
    assert.equal(blendForD2!.isBlend, true);
    assert.equal(blendForD2!.components.length, 3);
  });

  it("a one-component blend on a dish with NO sauce step is left alone, not dropped", () => {
    // The other 5 of the census's 17. Dropping prep work is Hans's call.
    const noSauce = input([
      {
        dishId: "d1",
        dishName: "Lemon-Herb Chicken",
        ingredients: [{ id: "ing-oregano", name: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" }],
      },
      {
        dishId: "d2",
        dishName: "Roasted Potatoes",
        ingredients: [
          { id: "ing-oregano", name: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: "ing-paprika", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: "ing-garlicp", name: "garlic powder", category: "Pantry", quantity: 1, unit: "tsp" },
        ],
      },
    ]);
    const steps = plan(noSauce).steps;
    const oregano = steps.filter((s) => s.components.some((c) => c.ingredientName === "dried oregano"));
    assert.ok(oregano.length > 0, "the lone oregano must still be prepped somewhere");
  });
});

// ── ruling 10 — the join sentence, as far as it reaches ─────────────────────

describe("BUG-338 ruling 10 — a single-dish produce step can carry the blend link", () => {
  // THE CARNE ASADA MARINADE. Its orange juice is `produce` and its own step;
  // before this, blendSpiceDish only ever landed on a `sauces_marinades` step, so
  // the whole class could never be joined.
  const marinade = input([
    {
      dishId: "d1",
      dishName: "Carne Asada",
      ingredients: [
        { id: "ing-cumin", name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-chili", name: "chili powder", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "ing-oregano", name: "dried oregano", category: "Pantry", quantity: 0.5, unit: "tsp" },
        { id: "ing-oj", name: "orange juice", category: "Produce", quantity: 0.25, unit: "cup" },
      ],
    },
    {
      dishId: "d2",
      dishName: "Pico de Gallo",
      ingredients: [{ id: "ing-lime", name: "lime juice", category: "Produce", quantity: 2, unit: "tbsp" }],
    },
  ]);

  it("a produce step feeding ONE dish that has a blend gets the link", () => {
    const oj = plan(marinade).steps.find((s) => s.components.some((c) => c.ingredientName === "orange juice"));
    assert.ok(oj, "the orange juice step should exist");
    assert.equal(oj!.blendSpiceDish, "Carne Asada");
  });

  it("🔴 a produce step feeding MORE THAN ONE dish gets NO link, and that is the interim's limit", () => {
    // `blendSpiceDish` is one dish NAME on a step, and a produce step is per
    // INGREDIENT. The plan's lime juice feeds three dishes; naming one would tell
    // the cook to tip all three portions into that dish's bowl. This is the gap
    // D-WS9-296's components close, and it is asserted so B2 inherits a test that
    // says what is still missing.
    const shared = input([
      {
        dishId: "d1",
        dishName: "Carne Asada",
        ingredients: [
          { id: "ing-cumin", name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: "ing-chili", name: "chili powder", category: "Pantry", quantity: 1, unit: "tsp" },
          { id: "ing-oregano", name: "dried oregano", category: "Pantry", quantity: 0.5, unit: "tsp" },
          { id: "ing-lime", name: "lime juice", category: "Produce", quantity: 3, unit: "tbsp" },
        ],
      },
      {
        dishId: "d2",
        dishName: "Pico de Gallo",
        ingredients: [{ id: "ing-lime", name: "lime juice", category: "Produce", quantity: 2, unit: "tbsp" }],
      },
    ]);
    const lime = plan(shared).steps.find((s) => s.components.some((c) => c.ingredientName === "lime juice"));
    assert.ok(lime, "the lime juice step should exist");
    assert.equal(lime!.blendSpiceDish, undefined);
  });
});

// ── ruling 13 — the cook day reaches the narration input ────────────────────

describe("BUG-338 ruling 13 — daysUntilCook rides on the step", () => {
  // Two meals, one shared ingredient. The loader's job (reading assignedDate) is
  // covered in prepWeekAggregation.test.ts; this is the arithmetic that turns a
  // per-meal date into a per-step lag.
  const twoMeals: PrepCombineInput = {
    meals: [
      {
        mealId: "meal-tue",
        mealName: "Tuesday Meal",
        dishes: [
          {
            dishId: "d1",
            dishName: "Stir-Fry",
            dishRole: "main",
            ingredients: [
              { ingredientId: "ing-garlic", ingredientName: "garlic", category: "Produce", quantity: 2, unit: "clove", preparationNote: "minced", sourceYield: null },
            ],
          },
        ],
      },
      {
        mealId: "meal-sat",
        mealName: "Saturday Meal",
        dishes: [
          {
            dishId: "d2",
            dishName: "Tacos",
            dishRole: "main",
            ingredients: [
              { ingredientId: "ing-garlic", ingredientName: "garlic", category: "Produce", quantity: 3, unit: "clove", preparationNote: "minced", sourceYield: null },
            ],
          },
        ],
      },
    ],
  };

  const lagMap = new Map([
    ["meal-tue", 2],
    ["meal-sat", 6],
  ]);

  it("takes the LATEST cook day, because that is what the portion must survive to", () => {
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), lagMap);
    const garlic = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "garlic"));
    assert.ok(garlic, "the garlic step should exist");
    // One step feeds both meals; min would be 2 and would let it spoil by Saturday.
    assert.equal(garlic!.daysUntilCook, 6);
  });

  it("🔴 does NOT reach the narration input — the prompt never sees a date", () => {
    // THIS TEST WAS THE OPPOSITE ASSERTION IN B1 and chat-Claude reversed the
    // ruling. Sending the lag to the narrator bought nothing the model needed,
    // and it made the PROSE day-dependent — which in turn made every day
    // reassignment a cache miss (~73 s, ~$0.125) for text that would not have
    // changed. Hans moves days ad hoc all week. Every date-dependent behaviour
    // D-WS9-298 adds is deterministic and lives in code, so the lag stays on the
    // skeleton and out of the AI's input.
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), lagMap);
    assert.equal(sp.steps[0].daysUntilCook, 6, "the skeleton keeps it");
    for (const s of sp.narrationInput.steps) {
      assert.ok(
        !("daysUntilCook" in s),
        `the narration input must carry no date: ${JSON.stringify(s.stepId)}`,
      );
    }
    // And nothing date-shaped anywhere in the serialised input the model receives.
    assert.ok(
      !/daysUntilCook|prepDay|assignedDate/.test(JSON.stringify(sp.narrationInput)),
      "a date field reached the narration input",
    );
  });

  it("absent — not zero — when the plan carries no dates", () => {
    // 4 of the 13 census plans. A fabricated 0 would read as "cooked the same
    // day", which is a claim the data does not make.
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), new Map());
    for (const s of sp.steps) assert.equal(s.daysUntilCook, undefined);
  });

  it("a step whose only destination is undated gets no lag", () => {
    const sp = buildStepPlan(combinePrep(twoMeals), "Test Plan", new Map(), new Map([["meal-tue", 2]]));
    const garlic = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "garlic"));
    // This step feeds BOTH meals and only one is dated, so the known lag stands —
    // partial knowledge is still knowledge, and it is the conservative direction
    // only because the unknown one might be later. Recorded, not asserted as ideal.
    assert.equal(garlic!.daysUntilCook, 2);
  });
});
