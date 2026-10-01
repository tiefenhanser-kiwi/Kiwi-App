// WS7-8a Block 2 — code-owned assembly unit tests.
// Pure (no DB, no AI). Proves the by-construction guarantee: numeric +
// attribution fields trace to the engine/step plan, never to AI prose.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import {
  buildStepPlan,
  assemblePrepWeekResult,
  formatMeasure,
  PrepNarrationIncompleteError,
  type StepPlan,
} from "../prepWeekAssembly";
import {
  PrepNarrationResultSchema,
  type PrepNarrationResult,
} from "../ai/schemas/prepNarration";
import { PrepWeekResultSchema } from "../ai/schemas/prepWeek";

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Two meals share onion (produce) + a 3-spice blend on meal A's dish.
function plan(): PrepCombineInput {
  const onionA = {
    ingredientId: "ing-onion",
    ingredientName: "yellow onion",
    category: "Produce",
    quantity: 1,
    unit: "each",
    preparationNote: "diced",
  };
  return {
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Tacos",
        dishes: [
          {
            dishId: "d-a",
            dishName: "Seasoned Beef",
            dishRole: "main",
            ingredients: [
              onionA,
              { ingredientId: "ing-cumin", ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-paprika", ingredientName: "paprika", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-chili", ingredientName: "chili powder", category: "Pantry", quantity: 2, unit: "tsp" },
              { ingredientId: "ing-beef", ingredientName: "beef chuck roast", category: "Protein", quantity: 1, unit: "lb", preparationNote: "cut into cubes" },
            ],
          },
        ],
      },
      {
        mealId: MEAL_B,
        mealName: "Fajitas",
        dishes: [
          {
            dishId: "d-b",
            dishName: "Fajitas",
            dishRole: "main",
            ingredients: [{ ...onionA, quantity: 2 }],
          },
        ],
      },
    ],
  };
}

// Echo every planned step back with canned prose + a fixed time.
function echo(stepPlan: StepPlan, minutes = 5): PrepNarrationResult {
  return {
    steps: stepPlan.steps.map((s, i) => ({
      stepId: s.stepId,
      title: `Title ${i}`,
      instructions: `Instructions ${i}`,
      estimatedMinutes: minutes,
    })),
  };
}

// ── buildStepPlan ────────────────────────────────────────────────────────────

describe("buildStepPlan", () => {
  it("emits one produce step (onion grouped across both meals)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const produceSteps = sp.steps.filter((s) => s.phase === "produce");
    assert.equal(produceSteps.length, 1);
    assert.equal(produceSteps[0].number, 1);
    assert.equal(produceSteps[0].stepId, "produce#1");
    // attribution = union of both meals
    assert.deepEqual(
      [...produceSteps[0].contributesToMealIds].sort(),
      [MEAL_A, MEAL_B].sort(),
    );
  });

  it("collapses the 3-spice blend into ONE seasonings_dry step (B1)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const blendSteps = sp.steps.filter((s) => s.phase === "seasonings_dry");
    assert.equal(blendSteps.length, 1);
    assert.equal(blendSteps[0].isBlend, true);
    // all three spice components present in the single blend step
    const names = blendSteps[0].components.map((c) => c.ingredientName).sort();
    assert.deepEqual(names, ["chili powder", "cumin", "paprika"]);
  });

  it("narrationInput mirrors the planned steps 1:1 by stepId", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    assert.equal(sp.narrationInput.planName, "Test Plan");
    assert.deepEqual(
      sp.narrationInput.steps.map((s) => s.stepId),
      sp.steps.map((s) => s.stepId),
    );
  });

  it("routes a WHOLE protein to a proteins step (D-WS9-301 rule 4 keeps knife work)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const proteinSteps = sp.steps.filter((s) => s.phase === "proteins");
    assert.equal(proteinSteps.length, 1);
    assert.equal(proteinSteps[0].components[0].ingredientName, "beef chuck roast");
  });
});

// ── B3: stable stepKey derivation (D-WS7-153) ────────────────────────────────

const MEAL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Same plan as plan(), but meals are REORDERED (Fajitas first) and a third
// meal with a brand-new produce ingredient is appended. This simulates a
// structureJson regenerate after a plan edit: positional step numbers shift,
// but a given ingredient's stable key must NOT.
function reorderedPlanWithAddedMeal(): PrepCombineInput {
  const onion = {
    ingredientId: "ing-onion",
    ingredientName: "yellow onion",
    category: "Produce",
    quantity: 1,
    unit: "each",
    preparationNote: "diced",
  };
  return {
    meals: [
      {
        mealId: MEAL_C,
        mealName: "Stir Fry",
        dishes: [
          {
            dishId: "d-c",
            dishName: "Veg Stir Fry",
            dishRole: "main",
            ingredients: [
              // A NEW produce ingredient, in a meal placed FIRST — it takes
              // produce#1 positionally, pushing onion to produce#2. Proves the
              // stepKey is not positional.
              { ingredientId: "ing-carrot", ingredientName: "carrot", category: "Produce", quantity: 3, unit: "each", preparationNote: "julienned" },
            ],
          },
        ],
      },
      {
        mealId: MEAL_B,
        mealName: "Fajitas",
        dishes: [
          { dishId: "d-b", dishName: "Fajitas", dishRole: "main", ingredients: [{ ...onion, quantity: 2 }] },
        ],
      },
      {
        mealId: MEAL_A,
        mealName: "Tacos",
        dishes: [
          {
            dishId: "d-a",
            dishName: "Seasoned Beef",
            dishRole: "main",
            ingredients: [
              onion,
              { ingredientId: "ing-cumin", ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-paprika", ingredientName: "paprika", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-chili", ingredientName: "chili powder", category: "Pantry", quantity: 2, unit: "tsp" },
              { ingredientId: "ing-beef", ingredientName: "beef chuck roast", category: "Protein", quantity: 1, unit: "lb", preparationNote: "cut into cubes" },
            ],
          },
        ],
      },
    ],
  };
}

describe("buildStepPlan — stable stepKey (B3 / D-WS7-153)", () => {
  it("(i) every normal step gets a `${phase}#${ingredientId}` key", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const produce = sp.steps.find((s) => s.phase === "produce")!;
    const protein = sp.steps.find((s) => s.phase === "proteins")!;
    assert.equal(produce.stepKey, "produce#ing-onion");
    assert.equal(produce.ingredientId, "ing-onion");
    assert.equal(protein.stepKey, "proteins#ing-beef");
    assert.equal(protein.ingredientId, "ing-beef");
  });

  it("(ii) a dish's dry-blend step gets a `seasonings_dry#dish#${dishId}` key (D-WS7-187)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const blend = sp.steps.find((s) => s.phase === "seasonings_dry")!;
    assert.equal(blend.isBlend, true);
    // BUG-016 (D-WS7-187): per-dish blend key, symmetric with sauces#dish#.
    // (Was the collapsed `seasonings_dry#blend` sentinel.) plan()'s dry spices
    // all sit in dish d-a, so this plan has one blend step keyed on d-a.
    assert.equal(blend.stepKey, "seasonings_dry#dish#d-a");
    // The blend folds many ingredientIds, so it carries no single one.
    assert.equal(blend.ingredientId, null);
  });

  it("(iii) keys are STABLE across a regenerate with reordered/added meals", () => {
    const before = buildStepPlan(combinePrep(plan()), "Test Plan");
    const after = buildStepPlan(combinePrep(reorderedPlanWithAddedMeal()), "Test Plan");

    const keyByIngredient = (sp: StepPlan, phase: string, ingredientName: string) =>
      sp.steps.find(
        (s) => s.phase === phase && s.components.some((c) => c.ingredientName === ingredientName),
      )?.stepKey;

    // Onion's produce key is identical despite Fajitas now being first AND a
    // new carrot step taking produce#1 positionally.
    assert.equal(keyByIngredient(before, "produce", "yellow onion"), "produce#ing-onion");
    assert.equal(keyByIngredient(after, "produce", "yellow onion"), "produce#ing-onion");
    // The positional number DID move (proves the key is not positional).
    const onionBefore = before.steps.find((s) => s.phase === "produce")!;
    const onionAfter = after.steps.find(
      (s) => s.phase === "produce" && s.components.some((c) => c.ingredientName === "yellow onion"),
    )!;
    assert.equal(onionBefore.number, 1);
    assert.equal(onionAfter.number, 2); // carrot took #1
    assert.notEqual(onionBefore.number, onionAfter.number);
    assert.equal(onionBefore.stepKey, onionAfter.stepKey); // …but the key held.

    // Beef + blend keys also hold.
    assert.equal(keyByIngredient(before, "proteins", "beef chuck roast"), "proteins#ing-beef");
    assert.equal(keyByIngredient(after, "proteins", "beef chuck roast"), "proteins#ing-beef");
    assert.equal(
      before.steps.find((s) => s.phase === "seasonings_dry")!.stepKey,
      after.steps.find((s) => s.phase === "seasonings_dry")!.stepKey,
    );

    // The new carrot ingredient gets its own stable key.
    assert.equal(keyByIngredient(after, "produce", "carrot"), "produce#ing-carrot");
  });

  it("stepKey survives onto the assembled wire step + validates", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp));
    assert.ok(PrepWeekResultSchema.safeParse(result).success);
    const produce = result.phases.find((p) => p.phase === "produce")!;
    assert.equal(produce.steps[0].stepKey, "produce#ing-onion");
    const blend = result.phases.find((p) => p.phase === "seasonings_dry")!;
    assert.equal(blend.steps[0].stepKey, "seasonings_dry#dish#d-a");
    // Keys are unique across the whole result (no collisions within a plan).
    const allKeys = result.phases.flatMap((p) => p.steps.map((s) => s.stepKey));
    assert.equal(allKeys.length, new Set(allKeys).size);
  });
});

// ── assemblePrepWeekResult ───────────────────────────────────────────────────

describe("assemblePrepWeekResult", () => {
  it("emits 4 phases in fixed order with proteins last", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp));
    assert.deepEqual(
      result.phases.map((p) => p.phase),
      ["seasonings_dry", "sauces_marinades", "produce", "proteins"],
    );
    assert.equal(result.phases[3].phase, "proteins");
  });

  it("takes numbers + attribution from the plan, prose from the AI", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    // Narration tries to look authoritative but has no number/mealId field.
    const result = assemblePrepWeekResult(sp, {
      steps: sp.steps.map((s) => ({
        stepId: s.stepId,
        title: "AI TITLE",
        instructions: "AI INSTRUCTIONS",
        estimatedMinutes: 7,
      })),
    });
    const produce = result.phases.find((p) => p.phase === "produce")!;
    const planned = sp.steps.find((s) => s.phase === "produce")!;
    assert.equal(produce.steps[0].title, "AI TITLE"); // prose = AI
    assert.equal(produce.steps[0].number, planned.number); // number = code
    assert.deepEqual(
      produce.steps[0].contributesToMealIds, // attribution = code
      planned.contributesToMealIds,
    );
  });

  it("🔴 BUG-204 — totalEstimatedMinutes is the ENGINE's sum, not the AI's", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp, 6));
    assert.equal(sp.steps.length, 3);
    // The echo claims 6 min a step (18 total). The engine's own numbers stand.
    const engine = sp.steps.reduce((n, s) => n + s.estimatedMinutes, 0);
    assert.equal(result.totalEstimatedMinutes, engine);
    assert.notEqual(result.totalEstimatedMinutes, 18);
  });

  it("🔴 BUG-204 — an inflated AI estimate cannot move the total at all", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    // 60 min a step was the schema's old ceiling and the sort of number that put
    // "about 120 min" on a 40-minute plan. It is ignored.
    const fat = assemblePrepWeekResult(sp, echo(sp, 60));
    const lean = assemblePrepWeekResult(sp, echo(sp, 1));
    assert.equal(fat.totalEstimatedMinutes, lean.totalEstimatedMinutes);
    assert.ok(fat.totalEstimatedMinutes <= 240, "still inside the schema ceiling");
  });

  it("carries an optional storageNote through when present", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const narration: PrepNarrationResult = {
      steps: sp.steps.map((s, i) => ({
        stepId: s.stepId,
        title: `T${i}`,
        instructions: `I${i}`,
        estimatedMinutes: 5,
        ...(s.phase === "produce" ? { storageNote: "Fridge, 3 days" } : {}),
      })),
    };
    const result = assemblePrepWeekResult(sp, narration);
    const produce = result.phases.find((p) => p.phase === "produce")!;
    assert.equal(produce.steps[0].storageNote, "Fridge, 3 days");
    // a step without storageNote omits it entirely
    const blend = result.phases.find((p) => p.phase === "seasonings_dry")!;
    assert.equal("storageNote" in blend.steps[0], false);
  });

  it("throws PrepNarrationIncompleteError when a planned step is unnarrated", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    // Drop the last step from the narration.
    const partial: PrepNarrationResult = {
      steps: sp.steps.slice(0, -1).map((s, i) => ({
        stepId: s.stepId,
        title: `T${i}`,
        instructions: `I${i}`,
        estimatedMinutes: 5,
      })),
    };
    assert.throws(
      () => assemblePrepWeekResult(sp, partial),
      (err) => err instanceof PrepNarrationIncompleteError,
    );
  });
});

// ── B2b: step text + skipSuggested ───────────────────────────────────────────

describe("buildStepPlan — relevantDishes + dishSteps (B2b / D-WS9-049 A1.2)", () => {
  it("references the dishes a group's ingredients come from; step prose is sent once in dishSteps", () => {
    const map = new Map<string, string[]>([
      ["d-a", ["Season the beef.", "Brown it."]],
      ["d-b", ["Char the peppers."]],
    ]);
    const sp = buildStepPlan(combinePrep(plan()), "P", map);
    // onion appears in d-a (Seasoned Beef) AND d-b (Fajitas) → both dishes named.
    const produce = sp.steps.find((s) => s.phase === "produce")!;
    assert.deepEqual(
      [...produce.relevantDishes].sort(),
      ["Fajitas", "Seasoned Beef"],
    );
    // narrationInput mirrors the reference for the AI.
    const ni = sp.narrationInput.steps.find((s) => s.stepId === produce.stepId)!;
    assert.deepEqual(ni.relevantDishes, produce.relevantDishes);
    // Each dish's prose lives ONCE in the shared dishSteps map, keyed by name.
    assert.deepEqual(sp.narrationInput.dishSteps["Seasoned Beef"], [
      "Season the beef.",
      "Brown it.",
    ]);
    assert.deepEqual(sp.narrationInput.dishSteps["Fajitas"], ["Char the peppers."]);
    // The union of a step's referenced dishSteps reconstructs the old inlined set.
    const reconstructed = produce.relevantDishes
      .flatMap((n) => sp.narrationInput.dishSteps[n] ?? [])
      .sort();
    assert.deepEqual(reconstructed, [
      "Brown it.",
      "Char the peppers.",
      "Season the beef.",
    ]);
  });

  it("defaults relevantDishes to empty and dishSteps to {} when no step-text map is supplied", () => {
    const sp = buildStepPlan(combinePrep(plan()), "P");
    for (const s of sp.steps) assert.deepEqual(s.relevantDishes, []);
    assert.deepEqual(sp.narrationInput.dishSteps, {});
  });
});

describe("assemblePrepWeekResult — skipSuggested (B2b)", () => {
  it("flags the step the AI demoted and omits the field otherwise", () => {
    const sp = buildStepPlan(combinePrep(plan()), "P");
    const protein = sp.steps.find((s) => s.phase === "proteins")!;
    const narration: PrepNarrationResult = {
      steps: sp.steps.map((s) => ({
        stepId: s.stepId,
        title: "T",
        instructions: "I",
        estimatedMinutes: 5,
        ...(s.stepId === protein.stepId ? { skipSuggested: true } : {}),
      })),
    };
    const result = assemblePrepWeekResult(sp, narration);
    // Wire schema round-trips skipSuggested.
    assert.ok(PrepWeekResultSchema.safeParse(result).success);
    const proteins = result.phases.find((p) => p.phase === "proteins")!;
    assert.equal(proteins.steps[0].skipSuggested, true);
    const produce = result.phases.find((p) => p.phase === "produce")!;
    assert.equal("skipSuggested" in produce.steps[0], false);
  });

  it("INVARIANT: demotion never changes code-owned number / attribution", () => {
    const sp = buildStepPlan(combinePrep(plan()), "P");
    const plain: PrepNarrationResult = {
      steps: sp.steps.map((s) => ({
        stepId: s.stepId,
        title: "T",
        instructions: "I",
        estimatedMinutes: 5,
      })),
    };
    const allDemoted: PrepNarrationResult = {
      steps: plain.steps.map((s) => ({ ...s, skipSuggested: true })),
    };
    const a = assemblePrepWeekResult(sp, plain);
    const b = assemblePrepWeekResult(sp, allDemoted);
    const codeOwned = (r: ReturnType<typeof assemblePrepWeekResult>) =>
      r.phases.map((p) =>
        p.steps.map((s) => ({
          number: s.number,
          contributesToMealIds: s.contributesToMealIds,
        })),
      );
    // Numbers + attribution identical whether or not every step was demoted.
    assert.deepEqual(codeOwned(a), codeOwned(b));
  });
});

// ── WS7-8b FIX 2: fraction formatter (code owns the math) ────────────────────

describe("formatMeasure — kitchen-fraction formatting", () => {
  it("rounds tsp/tbsp/cup UP to the nearest 1/8 with vulgar glyphs", () => {
    const rows: Array<[number, string, string]> = [
      // exact eighths
      [0.125, "tsp", "⅛ tsp"],
      [0.25, "tsp", "¼ tsp"],
      [0.5, "tsp", "½ tsp"],
      [0.75, "cup", "¾ cup"],
      [0.875, "cup", "⅞ cup"],
      // whole + mixed
      [1, "tsp", "1 tsp"],
      // 🔴 D-WS9-297 ruling 7 — UNSPACED. This line asserted "1 ½ tbsp" and was
      // pinning a divergence, not a rule: artifacts/kiwi/lib/format/quantity.ts
      // writes "1½" everywhere else in the app, and the census counted 55 spaced
      // mixed numbers in the prep text alone. One app, one mixed number.
      [1.5, "tbsp", "1½ tbsp"],
      [2, "cup", "2 cup"],
      // rounds UP: 0.6425 cup → next eighth above ⅝(0.625) is ¾(0.75)
      [0.6425, "cup", "¾ cup"],
      // just over an eighth still bumps up
      [0.13, "tsp", "¼ tsp"],
      // 5/8 lands exactly (0.625) — not rounded further
      [0.625, "cup", "⅝ cup"],
    ];
    for (const [q, unit, want] of rows) {
      assert.equal(formatMeasure(q, unit), want, `${q} ${unit}`);
    }
  });

  it("applies the same 1/8 policy to weight units oz/lb", () => {
    assert.equal(formatMeasure(0.5, "oz"), "½ oz");
    assert.equal(formatMeasure(1.3, "lb"), "1⅜ lb"); // 1.3 → 1.375 up, unspaced (ruling 7)
    assert.equal(formatMeasure(2, "oz"), "2 oz");
  });

  it("rounds g/ml to whole numbers (no fractions, floor of 1)", () => {
    assert.equal(formatMeasure(12.4, "g"), "12 g");
    assert.equal(formatMeasure(0.2, "ml"), "1 ml"); // clamps up to 1, never 0
    assert.equal(formatMeasure(250.6, "ml"), "251 ml");
  });

  // ── 🔴 D-WS9-297 ruling 7 — "each" IS NOT A WORD A COOK SAYS ───────────────
  //
  // This test asserted "3 each" and "1.5 each". Both were pinning defects: the
  // census counted 135 printed "each" ("Dice 3 each roma tomatoes", the largest
  // single P-R5 class) and 24 bare decimals ("0.25 bunch", "0.5 each"). The
  // placeholder unit is dropped so the narrator writes "3 roma tomatoes" from the
  // ingredient name it already has, and a fractional count gets a glyph.
  it("🔴 ruling 7 — a placeholder count unit is dropped and a fraction gets a glyph", () => {
    assert.equal(formatMeasure(3, "each"), "3");
    assert.equal(formatMeasure(1.5, "each"), "1½"); // half an onion, as a glyph
    assert.equal(formatMeasure(0.5, "each"), "½");
    assert.equal(formatMeasure(0.25, "bunch"), "¼ bunch"); // a SPECIFIC count keeps its token
    assert.equal(formatMeasure(1, "sprig"), "1 sprig");
  });

  it("🔴 ruling 7 — a count glyph is NEAREST, not rounded up like a measure", () => {
    // toEighths rounds up because under-measuring a teaspoon spoils a dish. Half
    // an onion is exact, and rounding it to ⅝ would be a lie about the data.
    assert.equal(formatMeasure(1 / 3, "each"), "⅓");
    assert.equal(formatMeasure(2 / 3, "each"), "⅔");
    // Off-glyph falls back to the decimal rather than inventing a fraction —
    // same contract as lib/format/quantity.ts.
    assert.equal(formatMeasure(0.4, "each"), "0.4");
  });

  // ── 🔴 [grocery] F (F5.2) — A COUNT UNIT INFLECTS ─────────────────────────
  //
  // This test previously asserted `formatMeasure(2, "clove") === "2 clove"`. It
  // was PINNING THE DEFECT, not the rule: Hans's device pass (item 18) read
  // "Finely dice 3 stalk celery and transfer to a container" on the Prep the
  // Week text, and that line comes straight from here — the narrator echoes
  // formatMeasure's string verbatim so that "prose can't move the math".
  //
  // Updated rather than deleted, because the three invariants around it are
  // what make the change safe and they deserve to stay asserted.
  it("🔴 F5.2 — a COUNT unit above one is plural", () => {
    assert.equal(formatMeasure(2, "clove"), "2 cloves");
    assert.equal(formatMeasure(3, "stalk"), "3 stalks"); // Hans's line
    assert.equal(formatMeasure(3, "stalks"), "3 stalks"); // already plural, canonicalised then re-inflected
    assert.equal(formatMeasure(2, "sprig"), "2 sprigs");
    assert.equal(formatMeasure(4, "slice"), "4 slices");
    assert.equal(formatMeasure(3, "can"), "3 cans");
  });

  it("F5.2 — exactly one, and below one, stay singular", () => {
    assert.equal(formatMeasure(1, "clove"), "1 clove");
    assert.equal(formatMeasure(1, "stalk"), "1 stalk");
  });

  it("F5.2 — a MEASURE unit never inflects, at any quantity", () => {
    // The whole reason the plural lives in the count branch alone: "2 cups" and
    // "2 lbs" are not how a recipe is written, and pluralising them would be a
    // regression wearing a fix's clothes.
    assert.equal(formatMeasure(2, "cup"), "2 cup");
    assert.equal(formatMeasure(3, "tbsp"), "3 tbsp");
    assert.equal(formatMeasure(2, "lb"), "2 lb");
    assert.equal(formatMeasure(2, "oz"), "2 oz");
    assert.equal(formatMeasure(200, "g"), "200 g");
    // `each` is absent from the table on purpose (BUG-317: a count unit is
    // suppressed on a recipe line, never pluralised) — and since D-WS9-297
    // ruling 7 the token itself is dropped, so there is nothing to inflect.
    assert.equal(formatMeasure(3, "each"), "3");
  });

  it("normalizes unit spelling variants via the engine canonicalizer", () => {
    assert.equal(formatMeasure(1, "teaspoons"), "1 tsp");
    assert.equal(formatMeasure(2, "Tablespoons"), "2 tbsp");
    assert.equal(formatMeasure(1.5, "cups"), "1½ cup"); // unspaced, ruling 7
  });
});

// ── WS7-8b FIX 1: per-dish measures survive to the narration input ───────────

describe("componentsOf via buildStepPlan — per-dish measures (FIX 1)", () => {
  it("keeps onion's per-dish measures separate (NOT summed) and names each dish", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const produce = sp.steps.find((s) => s.phase === "produce")!;
    // one component (onion), two per-dish measures
    assert.equal(produce.components.length, 1);
    const measures = produce.components[0].measures;
    const byDish = Object.fromEntries(measures.map((m) => [m.forDish, m.amount]));
    // d-a onion qty 1, d-b onion qty 2 — kept PER DISH, not summed to 3.
    assert.deepEqual(byDish, {
      "Seasoned Beef": "1",
      Fajitas: "2",
    });
    // prep note rides along per-dish.
    assert.ok(measures.every((m) => m.preparationNote === "diced"));
  });

  it("carries the per-dish prep breakdown onto the narration input verbatim", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const produce = sp.steps.find((s) => s.phase === "produce")!;
    const ni = sp.narrationInput.steps.find((s) => s.stepId === produce.stepId)!;
    assert.deepEqual(
      ni.components[0].measures,
      produce.components[0].measures,
    );
  });

  it("blend step keeps a fraction-formatted per-dish measure for each spice", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const blend = sp.steps.find((s) => s.phase === "seasonings_dry")!;
    // cumin/paprika 1 tsp, chili powder 2 tsp — each a single-dish measure.
    const amounts = blend.components.flatMap((c) =>
      c.measures.map((m) => `${c.ingredientName}:${m.amount}`),
    );
    assert.deepEqual(
      amounts.sort(),
      ["chili powder:2 tsp", "cumin:1 tsp", "paprika:1 tsp"].sort(),
    );
  });
});

describe("narration + wire schemas accept skipSuggested (B2b)", () => {
  it("PrepNarrationResultSchema parses a step with skipSuggested", () => {
    const ok = PrepNarrationResultSchema.safeParse({
      steps: [
        { stepId: "produce#1", title: "T", instructions: "I", estimatedMinutes: 5, skipSuggested: true },
        { stepId: "proteins#1", title: "T", instructions: "I", estimatedMinutes: 5 },
      ],
    });
    assert.ok(ok.success);
  });
});

// ── WS7-8b #5 — sauces_marinades grouped by dishId + blendSpiceDish linkage ──
// Reflects REAL engine routing: only names that hit a sauce hint (vinegar/oil/
// sauce/juice/…) land in sauces_marinades; plain condiments/spices route to the
// seasonings_dry blend. The fix groups a dish's wet sauce members into ONE step
// keyed by dishId, and marks it with blendSpiceDish when that dish also has
// spices surviving in the blend (so the narrator can bridge them).

const MEAL_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// One meal, two sauce dishes:
//  - House Dressing (base): 3 WET members (all hit sauce hints) → grouped into
//    one sauces_marinades step; PLUS 3 dry spices → they survive into the blend
//    → the dressing's sauce step gets blendSpiceDish="House Dressing".
//  - Quick Salsa (sauce): 1 WET member (lime juice) + only denylisted salt →
//    NO surviving blend spices → its sauce step omits blendSpiceDish.
function saucePlan(): PrepCombineInput {
  return {
    meals: [
      {
        mealId: MEAL_D,
        mealName: "Dinner",
        dishes: [
          {
            dishId: "d-dressing",
            dishName: "House Dressing",
            dishRole: "base",
            ingredients: [
              { ingredientId: "ing-rwv", ingredientName: "red wine vinegar", category: "Pantry", quantity: 1, unit: "tbsp" },
              { ingredientId: "ing-sesame", ingredientName: "sesame oil", category: "Pantry", quantity: 1, unit: "tbsp" },
              { ingredientId: "ing-soy", ingredientName: "soy sauce", category: "Pantry", quantity: 2, unit: "tbsp" },
              { ingredientId: "ing-cumin", ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-coriander", ingredientName: "coriander", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-paprika", ingredientName: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
            ],
          },
          {
            dishId: "d-salsa",
            dishName: "Quick Salsa",
            dishRole: "sauce",
            ingredients: [
              { ingredientId: "ing-lime", ingredientName: "lime juice", category: "Pantry", quantity: 2, unit: "tbsp" },
              { ingredientId: "ing-salt", ingredientName: "salt", category: "Pantry", quantity: 1, unit: "tsp" },
            ],
          },
        ],
      },
    ],
  };
}

describe("buildStepPlan — #5 sauce grouping by dishId", () => {
  it("groups a dish's wet sauce members into ONE sauces_marinades step keyed by dishId", () => {
    const sp = buildStepPlan(combinePrep(saucePlan()), "Dinner");
    const dressing = sp.steps.filter(
      (s) => s.phase === "sauces_marinades" && s.stepKey === "sauces_marinades#dish#d-dressing",
    );
    // ONE step for the dressing (not three stranded per-ingredient steps).
    assert.equal(dressing.length, 1);
    const names = dressing[0].components.map((c) => c.ingredientName).sort();
    assert.deepEqual(names, ["red wine vinegar", "sesame oil", "soy sauce"]);
    // Every measure is for the dressing dish (grouped, not cross-dish).
    const forDishes = new Set(
      dressing[0].components.flatMap((c) => c.measures.map((m) => m.forDish)),
    );
    assert.deepEqual([...forDishes], ["House Dressing"]);
  });

  it("stepKey shape is `sauces_marinades#dish#${dishId}` (stable, not per-ingredient)", () => {
    const sp = buildStepPlan(combinePrep(saucePlan()), "Dinner");
    const sauceKeys = sp.steps
      .filter((s) => s.phase === "sauces_marinades")
      .map((s) => s.stepKey)
      .sort();
    assert.deepEqual(sauceKeys, [
      "sauces_marinades#dish#d-dressing",
      "sauces_marinades#dish#d-salsa",
    ]);
    // The grouped sauce step folds many ingredientIds → carries no single one.
    const dressing = sp.steps.find((s) => s.stepKey === "sauces_marinades#dish#d-dressing")!;
    assert.equal(dressing.ingredientId, null);
  });

  it("recomputes identically (deterministic — Block-2 rollup consistency)", () => {
    const a = buildStepPlan(combinePrep(saucePlan()), "Dinner");
    const b = buildStepPlan(combinePrep(saucePlan()), "Dinner");
    assert.deepEqual(
      a.steps.map((s) => s.stepKey),
      b.steps.map((s) => s.stepKey),
    );
  });

  // ── 🔴 THE TWO `blendSpiceDish` TESTS ARE GONE, WITH THE FIELD ───────────
  //
  // WS7-8b #5 stamped a sauce step with its dish's NAME so the narrator could
  // write "combine these with the <dish> spices from your seasoning blend", and
  // B1's ruling 10 widened it to single-dish produce steps. It was always a
  // pointer between two containers that should have been one, and it could
  // never reach the case that mattered: a marinade's orange juice is `produce`,
  // and the field was only ever set on `sauces_marinades`. B2 Part A measured
  // 74 of 108 multi-pile dishes with no join at all.
  //
  // D-WS9-296 replaces it with ONE VESSEL that has a NAME. The behaviour those
  // two tests pinned — a linkage when the spices survive, silence when they do
  // not — has no meaning now: there is nothing to link to. What replaced them
  // is `prepComponentsBug338.test.ts`, which asserts the bowl itself.
  it("#4 signal: dishRole rides every measure (KEEP-vs-DEMOTE input)", () => {
    const sp = buildStepPlan(combinePrep(saucePlan()), "Dinner");
    const dressing = sp.steps.find((s) => s.stepKey === "sauces_marinades#dish#d-dressing")!;
    assert.ok(
      dressing.components.every((c) => c.measures.every((m) => m.dishRole === "base")),
    );
    const salsa = sp.steps.find((s) => s.stepKey === "sauces_marinades#dish#d-salsa")!;
    assert.ok(
      salsa.components.every((c) => c.measures.every((m) => m.dishRole === "sauce")),
    );
  });
});

// ── WS7-8b 183 guard — a dish's dry blend (make-ahead spices AND an at-cook
// dredge alike) stays in that ONE undemoted isBlend step; code never force-
// demotes it (demotion is an AI-only skipSuggested annotation). BUG-016
// (D-WS7-187) split the blend PER DISH, so two dishes now yield two steps — but
// each dish's full spice set stays together (intra-dish integrity = the genuine
// 183 rule). The old `=== 1` here encoded the D-WS7-151 CROSS-dish collapse,
// which BUG-016 intentionally reverses; it was never the 183 rule.

const MEAL_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function mixedBlendPlan(): PrepCombineInput {
  const spices = (suffix: string) => [
    { ingredientId: `ing-cumin-${suffix}`, ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
    { ingredientId: `ing-paprika-${suffix}`, ingredientName: "paprika", category: "Pantry", quantity: 1, unit: "tsp" },
    { ingredientId: `ing-oregano-${suffix}`, ingredientName: "oregano", category: "Pantry", quantity: 1, unit: "tsp" },
  ];
  return {
    meals: [
      {
        mealId: MEAL_E,
        mealName: "Two-Dish Dinner",
        dishes: [
          { dishId: "d-x", dishName: "Braise", dishRole: "main", ingredients: spices("x") },
          { dishId: "d-y", dishName: "Rub Chicken", dishRole: "side", ingredients: spices("y") },
        ],
      },
    ],
  };
}

describe("buildStepPlan — 183: per-dish blend keeps each dish's full spice set undemoted", () => {
  it("splits two dishes' dry blends into one isBlend step PER DISH (D-WS7-187)", () => {
    const sp = buildStepPlan(combinePrep(mixedBlendPlan()), "Two-Dish Dinner");
    const blends = sp.steps.filter((s) => s.phase === "seasonings_dry");
    // BUG-016 (D-WS7-187): the collapsed single blend is now split per dish, so
    // two dishes → two blend steps. (Was `=== 1`; that encoded the D-WS7-151
    // cross-dish collapse being reversed, NOT the genuine 183 rule.)
    assert.equal(blends.length, 2);
    // The split never drops isBlend — each per-dish step is still a real blend.
    assert.ok(blends.every((b) => b.isBlend === true));
    // Stable per-dish keys, symmetric with sauces_marinades#dish#.
    assert.deepEqual(
      blends.map((b) => b.stepKey).sort(),
      ["seasonings_dry#dish#d-x", "seasonings_dry#dish#d-y"],
    );
    // Genuine 183 intra-dish integrity: each dish's FULL spice set (cumin +
    // paprika + oregano = 3 groups) stays together in that dish's ONE step —
    // make-ahead + at-cook spices are never split apart within a dish.
    const byKey = new Map(blends.map((b) => [b.stepKey, b]));
    const braise = byKey.get("seasonings_dry#dish#d-x")!;
    const chicken = byKey.get("seasonings_dry#dish#d-y")!;
    assert.equal(braise.components.length, 3);
    assert.equal(chicken.components.length, 3);
    // Each step names ONLY its own dish (no cross-dish leakage after the split).
    const forDishesOf = (b: (typeof blends)[number]) =>
      new Set(b.components.flatMap((c) => c.measures.map((m) => m.forDish)));
    assert.deepEqual([...forDishesOf(braise)], ["Braise"]);
    assert.deepEqual([...forDishesOf(chicken)], ["Rub Chicken"]);
  });

  it("code never force-demotes any per-dish blend (skipSuggested absent unless the AI sets it)", () => {
    const sp = buildStepPlan(combinePrep(mixedBlendPlan()), "Two-Dish Dinner");
    // Narration that does NOT demote → no wire blend step carries skipSuggested.
    const result = assemblePrepWeekResult(sp, echo(sp));
    const blend = result.phases.find((p) => p.phase === "seasonings_dry")!;
    // Two dishes → two per-dish blend steps (was `=== 1` under the collapse).
    assert.equal(blend.steps.length, 2);
    assert.ok(blend.steps.every((s) => !("skipSuggested" in s)));
  });
});
