// BUG-408 / THX-2S Part D — the meal-builder parse admits 8 sub-dishes, the
// same cap as POST /me/meals and the recipe import.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ParsedMealSchema } from "../schemas/mealBuilder";

function meal(n: number) {
  return {
    title: "Feast",
    cuisine: null,
    estimatedPrepMinutes: 30,
    estimatedCookMinutes: 60,
    servingsDefault: 10,
    difficulty: "medium",
    tags: [],
    subDishes: Array.from({ length: n }, (_, i) => ({
      title: `Dish ${i + 1}`,
      role: i === 0 ? "main" : "side",
      positionIndex: i,
      ingredients: [{ name: "salt", quantity: 1, unit: "tsp" }],
      steps: [{ content: "Cook.", estimatedMinutes: 10, phaseType: "cook" }],
    })),
  };
}

describe("ParsedMealSchema — sub-dish cap (BUG-408)", () => {
  it("8 sub-dishes parse", () => {
    const r = ParsedMealSchema.safeParse(meal(8));
    assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
  });
  it("9 sub-dishes are refused", () => {
    const r = ParsedMealSchema.safeParse(meal(9));
    assert.equal(r.success, false);
    // The ONLY issue is the cap itself — a fixture error would also fail.
    assert.deepEqual(
      r.success ? [] : r.error.issues.map((i) => [i.code, i.path.join(".")]),
      [["too_big", "subDishes"]],
    );
  });
});
