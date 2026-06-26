// WS7-8a Block 2 — loader→engine adapter unit tests.
// Pure (no DB, no AI). Covers category passthrough, per-dish servings-scaling
// (mirroring groceryList.ts), and the "6 oz" compound-unit split.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPrepCombineInput,
  splitCompoundUnit,
} from "../prepCombineAdapter";
import type { PrepLoadedPlan } from "../prepWeekAggregation";

function loaded(overrides: {
  servingsOverride: number | null;
  baseServings: number;
  quantity: number;
  unit: string;
  category?: string;
  ingredientName?: string;
  preparationNote?: string | null;
  // WS7-8 BUG-003 — undefined → mirror a freshly-created row (anchor == base);
  // pass null to exercise the legacy/seed null-anchor fallback.
  authoredBaseServings?: number | null;
}): PrepLoadedPlan {
  return {
    planId: "plan-1",
    planName: "Test Plan",
    meals: [
      {
        mealId: "meal-1",
        mealName: "Meal 1",
        cuisine: null,
        servingsOverride: overrides.servingsOverride,
        dishes: [
          {
            dishId: "dish-1",
            dishName: "Dish 1",
            baseServings: overrides.baseServings,
            authoredBaseServings:
              overrides.authoredBaseServings === undefined
                ? overrides.baseServings
                : overrides.authoredBaseServings,
            stepTexts: [],
            ingredients: [
              {
                ingredientId: "ing-1",
                ingredientName: overrides.ingredientName ?? "yellow onion",
                category: overrides.category ?? "Produce",
                quantity: overrides.quantity,
                unit: overrides.unit,
                preparationNote: overrides.preparationNote ?? null,
              },
            ],
          },
        ],
      },
    ],
  };
}

function firstIngredient(plan: PrepLoadedPlan) {
  const input = buildPrepCombineInput(plan);
  return input.meals[0].dishes[0].ingredients[0];
}

// ── splitCompoundUnit ────────────────────────────────────────────────────────

describe("splitCompoundUnit", () => {
  it("splits a leading numeric pack size and folds it into the quantity", () => {
    // salmon fillets: quantity 2, unit "6 oz" → 12 oz total.
    assert.deepEqual(splitCompoundUnit(2, "6 oz"), { quantity: 12, unit: "oz" });
    assert.deepEqual(splitCompoundUnit(1, "6 oz"), { quantity: 6, unit: "oz" });
    assert.deepEqual(splitCompoundUnit(3, "1.5 lb"), { quantity: 4.5, unit: "lb" });
  });

  it("leaves plain units untouched", () => {
    assert.deepEqual(splitCompoundUnit(2, "each"), { quantity: 2, unit: "each" });
    assert.deepEqual(splitCompoundUnit(3, "cloves"), { quantity: 3, unit: "cloves" });
    assert.deepEqual(splitCompoundUnit(1, ""), { quantity: 1, unit: "" });
  });
});

// ── servings scaling ─────────────────────────────────────────────────────────

describe("buildPrepCombineInput — servings scaling", () => {
  it("scales by servingsOverride / baseServings (override present)", () => {
    // override 6, base 4 → ×1.5. raw 2 → 3.
    const ing = firstIngredient(
      loaded({ servingsOverride: 6, baseServings: 4, quantity: 2, unit: "each" }),
    );
    assert.equal(ing.quantity, 3);
  });

  it("does not scale when there is no override (multiplier 1)", () => {
    const ing = firstIngredient(
      loaded({ servingsOverride: null, baseServings: 4, quantity: 2, unit: "each" }),
    );
    assert.equal(ing.quantity, 2);
  });

  it("guards baseServings <= 0 by treating the base as 1", () => {
    // base 0 → treated as 1; override 3 → ×3. raw 2 → 6.
    const ing = firstIngredient(
      loaded({ servingsOverride: 3, baseServings: 0, quantity: 2, unit: "each" }),
    );
    assert.equal(ing.quantity, 6);
  });

  it("applies the split BEFORE the servings multiplier", () => {
    // "6 oz" → ×6 = 12 oz, then override 6 / base 4 → ×1.5 = 18 oz.
    const ing = firstIngredient(
      loaded({ servingsOverride: 6, baseServings: 4, quantity: 2, unit: "6 oz" }),
    );
    assert.equal(ing.unit, "oz");
    assert.equal(ing.quantity, 18);
  });

  // ── WS7-8 BUG-003 — authored-servings anchor as the denominator ──────────────

  it("divides by the authored anchor, NOT the live baseServings", () => {
    // Simulate a future canonical promote: live base moved to 8 but the anchor
    // (where the quantities were authored) stays 4. No override → numerator
    // falls back to the live base 8, denominator is the anchor 4 → ×2. raw 2 → 4.
    const ing = firstIngredient(
      loaded({
        servingsOverride: null,
        baseServings: 8,
        authoredBaseServings: 4,
        quantity: 2,
        unit: "each",
      }),
    );
    assert.equal(ing.quantity, 4);
  });

  it("override numerator over the authored-anchor denominator", () => {
    // override 6 / anchor 4 → ×1.5 (live base 8 is ignored as denominator).
    const ing = firstIngredient(
      loaded({
        servingsOverride: 6,
        baseServings: 8,
        authoredBaseServings: 4,
        quantity: 2,
        unit: "each",
      }),
    );
    assert.equal(ing.quantity, 3);
  });

  it("null anchor (legacy/seed row) falls back to baseServings — no rescale", () => {
    // Regression guard: a null anchor must behave exactly like today. No
    // override, base 4, anchor null → multiplier 1. raw 2 → 2.
    const ing = firstIngredient(
      loaded({
        servingsOverride: null,
        baseServings: 4,
        authoredBaseServings: null,
        quantity: 2,
        unit: "each",
      }),
    );
    assert.equal(ing.quantity, 2);
  });
});

// ── category passthrough + fallback ──────────────────────────────────────────

describe("buildPrepCombineInput — category", () => {
  it("passes Ingredient.category through verbatim", () => {
    const ing = firstIngredient(
      loaded({
        servingsOverride: null,
        baseServings: 4,
        quantity: 1,
        unit: "lb",
        category: "Protein",
        ingredientName: "ground beef",
      }),
    );
    assert.equal(ing.category, "Protein");
  });

  it("falls back to inferCategory only when category is blank", () => {
    const ing = firstIngredient(
      loaded({
        servingsOverride: null,
        baseServings: 4,
        quantity: 1,
        unit: "lb",
        category: "   ",
        ingredientName: "chicken breast",
      }),
    );
    // inferCategory maps chicken → Protein.
    assert.equal(ing.category, "Protein");
  });
});

describe("buildPrepCombineInput — passthrough shape", () => {
  it("preserves ids, names, units, and prep notes", () => {
    const ing = firstIngredient(
      loaded({
        servingsOverride: null,
        baseServings: 4,
        quantity: 1,
        unit: "each",
        preparationNote: "diced",
      }),
    );
    assert.equal(ing.ingredientId, "ing-1");
    assert.equal(ing.ingredientName, "yellow onion");
    assert.equal(ing.unit, "each");
    assert.equal(ing.preparationNote, "diced");
  });
});
