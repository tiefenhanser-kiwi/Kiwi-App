// WS7-8a Block 1 — deterministic prep-combine engine unit tests.
// Pure (no DB, no AI). Mirrors the node:test + assert/strict harness style
// used across src/lib/__tests__.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeUnit,
  assignPhase,
  combinePrep,
  PREP_PHASE_ORDER,
  type PrepCombineInput,
  type PrepCombineResult,
  type PrepIngredientGroup,
} from "../prepCombineEngine";

// ── helpers ────────────────────────────────────────────────────────────────

function findGroup(
  result: PrepCombineResult,
  ingredientId: string,
): PrepIngredientGroup | undefined {
  for (const phase of result.phases) {
    const hit = phase.entries.find((e) => e.ingredientId === ingredientId);
    if (hit) return hit;
  }
  return result.excluded.find((e) => e.ingredientId === ingredientId);
}

function phaseEntries(
  result: PrepCombineResult,
  phase: (typeof PREP_PHASE_ORDER)[number],
): PrepIngredientGroup[] {
  return result.phases.find((p) => p.phase === phase)!.entries;
}

// ── unit canonicalizer ───────────────────────────────────────────────────────

describe("canonicalizeUnit — spelling variants", () => {
  it("collapses volume spellings", () => {
    assert.deepEqual(canonicalizeUnit("teaspoon"), { token: "tsp", family: "volume" });
    assert.deepEqual(canonicalizeUnit("tsp"), { token: "tsp", family: "volume" });
    assert.deepEqual(canonicalizeUnit("tablespoon"), { token: "tbsp", family: "volume" });
    assert.deepEqual(canonicalizeUnit("tbsp"), { token: "tbsp", family: "volume" });
    assert.deepEqual(canonicalizeUnit("cups"), { token: "cup", family: "volume" });
  });

  it("collapses weight spellings", () => {
    assert.deepEqual(canonicalizeUnit("ounce"), { token: "oz", family: "weight" });
    assert.deepEqual(canonicalizeUnit("oz"), { token: "oz", family: "weight" });
    assert.deepEqual(canonicalizeUnit("pound"), { token: "lb", family: "weight" });
    assert.deepEqual(canonicalizeUnit("pounds"), { token: "lb", family: "weight" });
  });

  it("collapses count spellings and treats empty/null/unit/large as each", () => {
    assert.deepEqual(canonicalizeUnit("cloves"), { token: "clove", family: "count" });
    assert.deepEqual(canonicalizeUnit("clove"), { token: "clove", family: "count" });
    assert.deepEqual(canonicalizeUnit("stalks"), { token: "stalk", family: "count" });
    assert.deepEqual(canonicalizeUnit(""), { token: "each", family: "count" });
    assert.deepEqual(canonicalizeUnit(null), { token: "each", family: "count" });
    assert.deepEqual(canonicalizeUnit(undefined), { token: "each", family: "count" });
    assert.deepEqual(canonicalizeUnit("unit"), { token: "each", family: "count" });
    assert.deepEqual(canonicalizeUnit("large"), { token: "each", family: "count" });
  });

  it("normalizes case and whitespace before lookup", () => {
    assert.deepEqual(canonicalizeUnit("  TABLESPOON  "), { token: "tbsp", family: "volume" });
    assert.deepEqual(canonicalizeUnit("Cloves"), { token: "clove", family: "count" });
  });

  it("returns unrecognized units as-is with family unknown (never force-merged)", () => {
    assert.deepEqual(canonicalizeUnit("6 oz"), { token: "6 oz", family: "unknown" });
    assert.deepEqual(canonicalizeUnit("splash"), { token: "splash", family: "unknown" });
  });
});

// Build a single-ingredient plan to probe line-merge behavior.
function singleIngredientPlan(
  units: { quantity: number; unit: string }[],
  category = "Produce",
): PrepCombineInput {
  return {
    meals: [
      {
        mealId: "m1",
        mealName: "Meal 1",
        dishes: [
          {
            dishId: "d1",
            dishName: "Dish 1",
            ingredients: units.map((u) => ({
              ingredientId: "ing-x",
              ingredientName: "test veg",
              category,
              quantity: u.quantity,
              unit: u.unit,
              preparationNote: "diced",
            })),
          },
        ],
      },
    ],
  };
}

describe("canonicalizeUnit — same-family summing via combinePrep lines", () => {
  it("sums tsp + tbsp + cup into the coarsest unit (cup)", () => {
    // 1 cup + 2 tbsp + 3 tsp = 48 + 6 + 3 = 57 tsp = 57/48 cup = 1.1875 cup
    const result = combinePrep(
      singleIngredientPlan([
        { quantity: 1, unit: "cup" },
        { quantity: 2, unit: "tbsp" },
        { quantity: 3, unit: "tsp" },
      ]),
    );
    const group = findGroup(result, "ing-x")!;
    assert.equal(group.lines.length, 1);
    assert.equal(group.lines[0].unit, "cup");
    assert.equal(group.lines[0].unitFamily, "volume");
    assert.equal(group.lines[0].totalQuantity, 57 / 48);
  });

  it("sums oz + lb into the coarsest unit (lb)", () => {
    // 1 lb + 8 oz = 16 + 8 = 24 oz = 1.5 lb
    const result = combinePrep(
      singleIngredientPlan(
        [
          { quantity: 1, unit: "lb" },
          { quantity: 8, unit: "oz" },
        ],
        "Protein",
      ),
    );
    const group = findGroup(result, "ing-x")!;
    assert.equal(group.lines.length, 1);
    assert.equal(group.lines[0].unit, "lb");
    assert.equal(group.lines[0].totalQuantity, 1.5);
  });

  it("keeps incompatible families as separate lines (no force-merge)", () => {
    // count (each) + volume (cup) cannot merge — two lines under one group.
    const result = combinePrep(
      singleIngredientPlan([
        { quantity: 2, unit: "each" },
        { quantity: 1, unit: "cup" },
      ]),
    );
    const group = findGroup(result, "ing-x")!;
    assert.equal(group.lines.length, 2);
    const byUnit = Object.fromEntries(group.lines.map((l) => [l.unit, l.totalQuantity]));
    assert.equal(byUnit["each"], 2);
    assert.equal(byUnit["cup"], 1);
  });

  it("does not merge ratio-less same-family units (ml stays its own line)", () => {
    const result = combinePrep(
      singleIngredientPlan([
        { quantity: 100, unit: "ml" },
        { quantity: 1, unit: "cup" },
      ]),
    );
    const group = findGroup(result, "ing-x")!;
    assert.equal(group.lines.length, 2);
    const units = group.lines.map((l) => l.unit).sort();
    assert.deepEqual(units, ["cup", "ml"]);
  });
});

// ── phase assignment ──────────────────────────────────────────────────────

describe("assignPhase", () => {
  it("maps Produce → produce and Protein → proteins (case-insensitive)", () => {
    assert.equal(assignPhase("Produce", "yellow onion"), "produce");
    assert.equal(assignPhase("produce", "garlic"), "produce");
    assert.equal(assignPhase("Protein", "ground beef"), "proteins");
  });

  it("splits Pantry by name heuristic (dry → seasonings, liquid/paste → sauces)", () => {
    assert.equal(assignPhase("Pantry", "cumin"), "seasonings_dry");
    assert.equal(assignPhase("Pantry", "taco seasoning"), "seasonings_dry");
    assert.equal(assignPhase("Pantry", "soy sauce"), "sauces_marinades");
    assert.equal(assignPhase("Pantry", "tikka masala paste"), "sauces_marinades");
    assert.equal(assignPhase("Pantry", "olive oil"), "sauces_marinades");
  });

  it("returns null for buy-and-use categories", () => {
    assert.equal(assignPhase("Dairy", "cheddar"), null);
    assert.equal(assignPhase("Bakery", "tortillas"), null);
    assert.equal(assignPhase("Frozen", "peas"), null);
    assert.equal(assignPhase("Canned", "diced tomatoes"), null);
  });
});

// ── combine + attribute: 3-meal mirepoix ────────────────────────────────────

const ING = {
  onion: "ing-yellow-onion",
  celery: "ing-celery",
  carrot: "ing-carrot",
} as const;

// onion + celery + carrot across soup, pot pie, shepherd's pie. Quantities
// supplied are already effective (engine does not scale).
function mirepoixPlan(): PrepCombineInput {
  const mk = (
    ingredientId: string,
    ingredientName: string,
    quantity: number,
    unit: string,
  ) => ({ ingredientId, ingredientName, category: "Produce", quantity, unit, preparationNote: "diced" });

  return {
    meals: [
      {
        mealId: "soup",
        mealName: "Lentil Soup",
        dishes: [
          {
            dishId: "soup-d1",
            dishName: "Lentil Soup",
            ingredients: [
              mk(ING.onion, "yellow onion", 1, "each"),
              mk(ING.celery, "celery", 2, "stalks"),
              mk(ING.carrot, "carrot", 2, "each"),
            ],
          },
        ],
      },
      {
        mealId: "potpie",
        mealName: "Chicken Pot Pie",
        dishes: [
          {
            dishId: "potpie-d1",
            dishName: "Chicken Pot Pie",
            ingredients: [
              mk(ING.onion, "yellow onion", 1, "each"),
              mk(ING.celery, "celery", 1, "stalk"), // singular spelling
              mk(ING.carrot, "carrot", 3, "each"),
            ],
          },
        ],
      },
      {
        mealName: "Shepherd's Pie",
        mealId: "shepherds",
        dishes: [
          {
            dishId: "shep-d1",
            dishName: "Shepherd's Pie",
            ingredients: [
              mk(ING.onion, "yellow onion", 0.5, "each"),
              mk(ING.carrot, "carrot", 1, "each"),
              // no celery in this one
            ],
          },
        ],
      },
    ],
  };
}

describe("combinePrep — 3-meal mirepoix", () => {
  it("produces one group per ingredient, all in the produce phase", () => {
    const result = combinePrep(mirepoixPlan());
    const produce = phaseEntries(result, "produce");
    const ids = produce.map((e) => e.ingredientId).sort();
    assert.deepEqual(ids, [ING.carrot, ING.celery, ING.onion].sort());
  });

  it("sums onion across all 3 meals with correct total and attribution", () => {
    const result = combinePrep(mirepoixPlan());
    const onion = findGroup(result, ING.onion)!;
    assert.equal(onion.lines.length, 1);
    const line = onion.lines[0];
    assert.equal(line.unit, "each");
    assert.equal(line.totalQuantity, 2.5); // 1 + 1 + 0.5
    assert.equal(line.contributions.length, 3);
    const byMeal = Object.fromEntries(line.contributions.map((c) => [c.mealId, c.quantity]));
    assert.deepEqual(byMeal, { soup: 1, potpie: 1, shepherds: 0.5 });
  });

  it("sums celery across stalk/stalks spellings into one line", () => {
    const result = combinePrep(mirepoixPlan());
    const celery = findGroup(result, ING.celery)!;
    assert.equal(celery.lines.length, 1);
    assert.equal(celery.lines[0].unit, "stalk");
    assert.equal(celery.lines[0].totalQuantity, 3); // 2 + 1
    assert.equal(celery.lines[0].contributions.length, 2);
  });

  it("attribution quantities sum to the line total for every group", () => {
    const result = combinePrep(mirepoixPlan());
    for (const phase of result.phases) {
      for (const group of phase.entries) {
        for (const line of group.lines) {
          // Every contribution in a single-family line shares the canonical
          // token here (each/stalk), so a raw sum equals the total.
          const sum = line.contributions.reduce((s, c) => s + c.quantity, 0);
          assert.ok(
            Math.abs(sum - line.totalQuantity) < 1e-9,
            `attribution sum ${sum} != total ${line.totalQuantity} for ${group.ingredientId}`,
          );
        }
      }
    }
  });
});

// ── variant separation ──────────────────────────────────────────────────────

describe("combinePrep — variant ingredients stay separate", () => {
  it("keeps red onion and yellow onion as distinct groups", () => {
    const result = combinePrep({
      meals: [
        {
          mealId: "m1",
          mealName: "Salad",
          dishes: [
            {
              dishId: "d1",
              dishName: "Greek Salad",
              ingredients: [
                {
                  ingredientId: "ing-red-onion",
                  ingredientName: "red onion",
                  category: "Produce",
                  quantity: 1,
                  unit: "each",
                  preparationNote: "thinly sliced",
                },
                {
                  ingredientId: "ing-yellow-onion",
                  ingredientName: "yellow onion",
                  category: "Produce",
                  quantity: 1,
                  unit: "each",
                  preparationNote: "diced",
                },
              ],
            },
          ],
        },
      ],
    });
    const produce = phaseEntries(result, "produce");
    assert.equal(produce.length, 2);
    assert.notEqual(
      findGroup(result, "ing-red-onion"),
      findGroup(result, "ing-yellow-onion"),
    );
  });
});

// ── prep-worthy filter ──────────────────────────────────────────────────────

// A taco-night dish carrying a 3-spice dry blend plus noise + produce + protein.
function tacoBlendPlan(): PrepCombineInput {
  return {
    meals: [
      {
        mealId: "taco-tue",
        mealName: "Taco Tuesday",
        dishes: [
          {
            dishId: "beef",
            dishName: "Seasoned Ground Beef",
            ingredients: [
              { ingredientId: "ing-cumin", ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-paprika", ingredientName: "paprika", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-chili", ingredientName: "chili powder", category: "Pantry", quantity: 2, unit: "tsp" },
              { ingredientId: "ing-salt", ingredientName: "salt", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-pepper", ingredientName: "black pepper", category: "Pantry", quantity: 0.5, unit: "tsp" },
              { ingredientId: "ing-oil", ingredientName: "olive oil", category: "Pantry", quantity: 1, unit: "tbsp" },
              { ingredientId: "ing-beef", ingredientName: "ground beef", category: "Protein", quantity: 1, unit: "lb" },
              { ingredientId: "ing-onion", ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced" },
              { ingredientId: "ing-cheese", ingredientName: "cheddar", category: "Dairy", quantity: 4, unit: "oz" },
            ],
          },
        ],
      },
    ],
  };
}

describe("combinePrep — prep-worthy filter tiers", () => {
  it("Tier 1: denylisted salt / pepper / olive oil are excluded", () => {
    const result = combinePrep(tacoBlendPlan());
    for (const id of ["ing-salt", "ing-pepper", "ing-oil"]) {
      const g = findGroup(result, id)!;
      assert.equal(g.prepWorthy, "exclude", `${id} should be excluded`);
      assert.ok(result.excluded.some((e) => e.ingredientId === id));
    }
  });

  it("Tier 2: diced produce is included in the produce phase", () => {
    const result = combinePrep(tacoBlendPlan());
    const onion = findGroup(result, "ing-onion")!;
    assert.equal(onion.prepWorthy, "include");
    assert.equal(onion.phase, "produce");
    assert.ok(phaseEntries(result, "produce").some((e) => e.ingredientId === "ing-onion"));
  });

  it("Tier 2: whole produce with no prep note is uncertain (kept in phase)", () => {
    const result = combinePrep({
      meals: [
        {
          mealId: "m1",
          mealName: "Roast",
          dishes: [
            {
              dishId: "d1",
              dishName: "Roast",
              ingredients: [
                { ingredientId: "ing-pepper-veg", ingredientName: "bell peppers", category: "Produce", quantity: 2, unit: "each" },
              ],
            },
          ],
        },
      ],
    });
    const g = findGroup(result, "ing-pepper-veg")!;
    assert.equal(g.prepWorthy, "uncertain");
    assert.equal(g.phase, "produce");
  });

  it("Tier 3: a 3+ dry-seasoning blend on one dish is detected and included", () => {
    const result = combinePrep(tacoBlendPlan());
    for (const id of ["ing-cumin", "ing-paprika", "ing-chili"]) {
      const g = findGroup(result, id)!;
      assert.equal(g.isBlendComponent, true, `${id} should be a blend component`);
      assert.equal(g.prepWorthy, "include");
      assert.equal(g.phase, "seasonings_dry");
    }
    // denylisted salt/pepper do NOT count toward the blend and are not components
    assert.equal(findGroup(result, "ing-salt")!.isBlendComponent, false);
  });

  it("Tier 3: a lone dry seasoning (under 3) is excluded as noise", () => {
    const result = combinePrep({
      meals: [
        {
          mealId: "m1",
          mealName: "Simple",
          dishes: [
            {
              dishId: "d1",
              dishName: "Simple",
              ingredients: [
                { ingredientId: "ing-cumin-lone", ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
                { ingredientId: "ing-paprika-lone", ingredientName: "paprika", category: "Pantry", quantity: 1, unit: "tsp" },
              ],
            },
          ],
        },
      ],
    });
    const cumin = findGroup(result, "ing-cumin-lone")!;
    assert.equal(cumin.isBlendComponent, false);
    assert.equal(cumin.prepWorthy, "exclude");
    assert.ok(result.excluded.some((e) => e.ingredientId === "ing-cumin-lone"));
  });

  it("Protein is uncertain and lands in the proteins phase", () => {
    const result = combinePrep(tacoBlendPlan());
    const beef = findGroup(result, "ing-beef")!;
    assert.equal(beef.prepWorthy, "uncertain");
    assert.equal(beef.phase, "proteins");
  });

  it("buy-and-use Dairy is excluded with a null phase", () => {
    const result = combinePrep(tacoBlendPlan());
    const cheese = findGroup(result, "ing-cheese")!;
    assert.equal(cheese.prepWorthy, "exclude");
    assert.equal(cheese.phase, null);
    assert.ok(result.excluded.some((e) => e.ingredientId === "ing-cheese"));
  });
});

// ── structural invariants ────────────────────────────────────────────────────

describe("combinePrep — result shape", () => {
  it("always emits exactly 4 phases in fixed order with proteins last", () => {
    const result = combinePrep({ meals: [] });
    assert.equal(result.phases.length, 4);
    assert.deepEqual(
      result.phases.map((p) => p.phase),
      ["seasonings_dry", "sauces_marinades", "produce", "proteins"],
    );
    assert.equal(result.phases[3].phase, "proteins");
    assert.equal(result.totalEstimatedMinutes, 0);
  });

  it("retains empty phases on a produce-only plan", () => {
    const result = combinePrep(mirepoixPlan());
    assert.equal(phaseEntries(result, "seasonings_dry").length, 0);
    assert.equal(phaseEntries(result, "sauces_marinades").length, 0);
    assert.equal(phaseEntries(result, "proteins").length, 0);
    assert.equal(phaseEntries(result, "produce").length, 3);
  });
});

// ── real-seed fixture ────────────────────────────────────────────────────────
// Names / categories / units lifted from the live dev seed (WS7-8a Phase 0
// queries): garlic Produce clove(s), yellow onion Produce each/"", salt/black
// pepper/olive oil Pantry, ground beef/salmon Protein, taco seasoning Pantry.
function realSeedPlan(): PrepCombineInput {
  return {
    meals: [
      {
        mealId: "dev-meal-beef-tacos",
        mealName: "Beef Tacos",
        dishes: [
          {
            dishId: "dev-dish-beef-tacos",
            dishName: "Seasoned Ground Beef",
            ingredients: [
              { ingredientId: "ing-garlic", ingredientName: "garlic", category: "Produce", quantity: 3, unit: "clove", preparationNote: "minced" },
              { ingredientId: "ing-yellow-onion", ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced" },
              { ingredientId: "ing-ground-beef", ingredientName: "ground beef", category: "Protein", quantity: 1, unit: "lb" },
              { ingredientId: "ing-taco-seasoning", ingredientName: "taco seasoning", category: "Pantry", quantity: 2, unit: "tbsp" },
              { ingredientId: "ing-salt", ingredientName: "salt", category: "Pantry", quantity: 1, unit: "tsp" },
            ],
          },
        ],
      },
      {
        mealId: "dev-meal-sheet-pan-fajitas",
        mealName: "Sheet-Pan Chicken Fajitas",
        dishes: [
          {
            dishId: "dev-dish-sheet-pan-fajitas",
            dishName: "Sheet-Pan Chicken Fajitas",
            ingredients: [
              { ingredientId: "ing-garlic", ingredientName: "garlic", category: "Produce", quantity: 4, unit: "cloves", preparationNote: "minced" },
              { ingredientId: "ing-yellow-onion", ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each" },
              { ingredientId: "ing-bell-peppers", ingredientName: "bell peppers", category: "Produce", quantity: 3, unit: "each" },
              { ingredientId: "ing-olive-oil", ingredientName: "olive oil", category: "Pantry", quantity: 2, unit: "tbsp" },
            ],
          },
        ],
      },
    ],
  };
}

describe("combinePrep — real-seed multi-meal fixture", () => {
  it("merges garlic clove/cloves across both meals into one summed line", () => {
    const result = combinePrep(realSeedPlan());
    const garlic = findGroup(result, "ing-garlic")!;
    assert.equal(garlic.lines.length, 1);
    assert.equal(garlic.lines[0].unit, "clove");
    assert.equal(garlic.lines[0].totalQuantity, 7); // 3 + 4
    assert.equal(garlic.lines[0].contributions.length, 2);
    assert.equal(garlic.prepWorthy, "include"); // produce + minced note
    assert.equal(garlic.phase, "produce");
  });

  it("merges yellow onion across both meals (one with a prep note, one without)", () => {
    const result = combinePrep(realSeedPlan());
    const onion = findGroup(result, "ing-yellow-onion")!;
    assert.equal(onion.lines[0].totalQuantity, 2); // 1 + 1
    assert.equal(onion.prepWorthy, "include"); // at least one contribution diced
  });

  it("excludes salt and olive oil; routes beef to proteins", () => {
    const result = combinePrep(realSeedPlan());
    assert.equal(findGroup(result, "ing-salt")!.prepWorthy, "exclude");
    assert.equal(findGroup(result, "ing-olive-oil")!.prepWorthy, "exclude");
    assert.equal(findGroup(result, "ing-ground-beef")!.phase, "proteins");
  });

  it("treats a lone taco seasoning as noise (not a blend) → excluded", () => {
    const result = combinePrep(realSeedPlan());
    const ts = findGroup(result, "ing-taco-seasoning")!;
    assert.equal(ts.isBlendComponent, false);
    assert.equal(ts.prepWorthy, "exclude");
  });
});
