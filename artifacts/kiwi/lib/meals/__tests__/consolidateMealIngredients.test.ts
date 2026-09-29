// WS9 D-WS9-058 (BUG-331) — the meal's consolidated ingredient list.
//
// The ruling left two questions open and this block answers both: the same
// ingredient across dishes SUMS, and the list reflects the DISPLAYED servings.
// The third rule is not from the ruling but from the data: two units that
// cannot be related do NOT sum.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  consolidateMealIngredients,
  consolidatedIngredientCount,
} from "../consolidateMealIngredients";

type Ing = { name: string; quantity: number; unit: string };

const dish = (title: string, ingredients: Ing[]) =>
  ({
    dishId: title.toLowerCase().replace(/\W+/g, "-"),
    title,
    roleLabel: "main",
    positionIndex: 0,
    minutes: 20,
    difficulty: "easy",
    servings: 4,
    authoredServingsDefault: 4,
    ingredients: ingredients.map((i) => ({
      ...i,
      preparationNote: null,
      category: "other",
      isOptional: false,
    })),
    steps: [],
  }) as never;

const meal = (...dishes: unknown[]) => ({ dishes }) as never;

describe("the same ingredient across dishes SUMS (the ruling)", () => {
  it("two dishes, one garlic line", () => {
    const out = consolidateMealIngredients(
      meal(
        dish("Meatballs", [{ name: "garlic", quantity: 4, unit: "clove" }]),
        dish("Sauce", [{ name: "garlic", quantity: 2, unit: "clove" }]),
      ),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 6);
    assert.equal(out[0].line, "6 cloves garlic");
    assert.deepEqual(out[0].dishTitles, ["Meatballs", "Sauce"]);
  });

  it("unit SPELLINGS fold — cup and cups are one line", () => {
    const out = consolidateMealIngredients(
      meal(
        dish("A", [{ name: "milk", quantity: 1, unit: "cup" }]),
        dish("B", [{ name: "milk", quantity: 0.5, unit: "cups" }]),
      ),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 1.5);
    assert.equal(out[0].line, "1½ cups milk");
  });

  it("a trailing prep clause does not split the group, and the first form survives", () => {
    const out = consolidateMealIngredients(
      meal(
        dish("A", [{ name: "lemon", quantity: 1, unit: "each" }]),
        dish("B", [{ name: "lemon, juiced", quantity: 2, unit: "each" }]),
      ),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "lemon");
    assert.equal(out[0].line, "3 lemons");
  });
});

describe("🔴 SUM ONLY WHAT IS COMPARABLE — cup and head are two lines", () => {
  it("the same name in two unrelatable units does NOT merge", () => {
    const out = consolidateMealIngredients(
      meal(
        dish("Slaw", [{ name: "green cabbage", quantity: 2, unit: "cup" }]),
        dish("Braise", [{ name: "green cabbage", quantity: 1, unit: "head" }]),
      ),
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((o) => o.line), ["2 cups green cabbage", "1 head green cabbage"]);
  });

  it("and the client does NOT invent a density to join them", () => {
    // The server holds the per-ingredient factor; the client is never sent one.
    // Two lines under one name is the ruled answer, not a fallback.
    const out = consolidateMealIngredients(
      meal(dish("A", [
        { name: "flour", quantity: 2, unit: "cup" },
        { name: "flour", quantity: 4, unit: "ounce" },
      ])),
    );
    assert.equal(out.length, 2);
  });

  it("an UNKNOWN unit keys alone rather than being folded with something else", () => {
    const out = consolidateMealIngredients(
      meal(dish("A", [
        { name: "saffron", quantity: 1, unit: "splorch" },
        { name: "saffron", quantity: 2, unit: "pinch" },
      ])),
    );
    assert.equal(out.length, 2);
  });
});

describe("the list reflects the DISPLAYED (scaled) servings (the ruling)", () => {
  it("the multiplier applies once, to the sum", () => {
    const m = meal(
      dish("A", [{ name: "milk", quantity: 1, unit: "cup" }]),
      dish("B", [{ name: "milk", quantity: 1, unit: "cup" }]),
    );
    assert.equal(consolidateMealIngredients(m, 1)[0].line, "2 cups milk");
    assert.equal(consolidateMealIngredients(m, 1.5)[0].line, "3 cups milk");
    assert.equal(consolidateMealIngredients(m, 0.5)[0].line, "1 cup milk");
  });

  it("🔴 the multiplier is NOT applied twice", () => {
    // consolidate scales, then hands formatIngredientLine multiplier 1.
    const out = consolidateMealIngredients(
      meal(dish("A", [{ name: "milk", quantity: 2, unit: "cup" }])),
      2,
    );
    assert.equal(out[0].quantity, 4);
    assert.equal(out[0].line, "4 cups milk");
  });

  it("scaling below one leaves the unit singular (BUG-329)", () => {
    const out = consolidateMealIngredients(
      meal(dish("A", [{ name: "green cabbage", quantity: 1, unit: "head" }])),
      0.5,
    );
    assert.equal(out[0].line, "½ head green cabbage");
  });
});

describe("ordering and provenance", () => {
  it("first appearance in MEAL order, not alphabetical", () => {
    const out = consolidateMealIngredients(
      meal(
        dish("A", [
          { name: "zucchini", quantity: 1, unit: "each" },
          { name: "apple", quantity: 1, unit: "each" },
        ]),
        dish("B", [{ name: "butter", quantity: 1, unit: "tablespoon" }]),
      ),
    );
    assert.deepEqual(out.map((o) => o.name), ["zucchini", "apple", "butter"]);
  });

  it("dish titles are deduplicated and in meal order", () => {
    const out = consolidateMealIngredients(
      meal(
        dish("A", [
          { name: "salt", quantity: 1, unit: "tsp" },
          { name: "salt", quantity: 1, unit: "tsp" },
        ]),
        dish("B", [{ name: "salt", quantity: 1, unit: "tsp" }]),
      ),
    );
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].dishTitles, ["A", "B"]);
    assert.equal(out[0].quantity, 3);
  });

  it("an empty meal consolidates to nothing", () => {
    assert.deepEqual(consolidateMealIngredients(meal()), []);
    assert.equal(consolidatedIngredientCount(meal()), 0);
    assert.equal(consolidatedIngredientCount(meal(dish("A", []))), 0);
  });

  it("the lines go through the SHARED formatter, so they carry BUG-317 too", () => {
    // A count unit is suppressed here exactly as on the meal screen.
    const out = consolidateMealIngredients(
      meal(dish("A", [{ name: "large shrimp", quantity: 1, unit: "each" }])),
    );
    assert.equal(out[0].line, "1 large shrimp");
  });
});
