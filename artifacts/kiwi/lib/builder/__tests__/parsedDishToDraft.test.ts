// WS7-6 G2 — ParsedDish → DraftDish adapter (the dish twin of
// parsedMealToDraft). Asserts the single-dish mapping, the prep+cook minute
// collapse, the "main" default type, and the nullable-cuisine omission.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsedDishToDraft } from "../parsedDishToDraft";
import type { ParsedDish } from "../../api/builder";

function base(): ParsedDish {
  return {
    title: "Roasted Broccoli",
    cuisine: "Mediterranean",
    estimatedPrepMinutes: 8,
    estimatedCookMinutes: 22,
    servingsDefault: 4,
    difficulty: "easy",
    tags: ["vegetable", "roasted"],
    ingredients: [
      { name: "broccoli florets", quantity: 1.5, unit: "lb" },
      { name: "garlic", quantity: 3, unit: "clove", isOptional: false },
    ],
    steps: [
      { content: "Heat oven to 425F.", estimatedMinutes: 5, phaseType: "preheat" },
      {
        content: "Toss and roast.",
        estimatedMinutes: 22,
        phaseType: "cook",
        isTimingSensitive: true,
      },
    ],
  };
}

test("maps a single dish straight across (no sub-dish flatten)", () => {
  const draft = parsedDishToDraft(base());
  assert.equal(draft.name, "Roasted Broccoli");
  assert.equal(draft.cuisineType, "Mediterranean");
  assert.equal(draft.type, "main");
  assert.equal(draft.servingsDefault, 4);
  assert.equal(draft.ingredients.length, 2);
  assert.equal(draft.ingredients[1].name, "garlic");
  assert.equal(draft.steps.length, 2);
  assert.equal(draft.steps[1].text, "Toss and roast.");
  assert.equal(draft.steps[1].isTimingSensitive, true);
});

test("collapses prep + cook minutes into one estimatedTimeMinutes", () => {
  const draft = parsedDishToDraft(base());
  assert.equal(draft.estimatedTimeMinutes, 30);
});

test("omits cuisineType when the parsed cuisine is null", () => {
  const draft = parsedDishToDraft({ ...base(), cuisine: null });
  assert.equal("cuisineType" in draft, false);
});
