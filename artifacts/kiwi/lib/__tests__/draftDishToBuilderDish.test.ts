// WS7-6 G3-fix — the DraftDish → BuilderDish adapter that lets the Meal Builder
// APPEND a Kiwi-drafted dish (dish-side Ask Kiwi) to the meal under
// construction in place, instead of saving a standalone dish.

import assert from "node:assert/strict";
import { test } from "node:test";

import { draftDishToBuilderDish } from "../meal-builder-state";
import type { DraftDish } from "../builder/parsedDishToDraft";

function makeAlloc() {
  let n = 0;
  return () => ++n;
}

const fullDraft: DraftDish = {
  name: "Roasted Broccoli",
  type: "side",
  estimatedTimeMinutes: 25,
  servingsDefault: 4,
  ingredients: [
    { name: "broccoli", quantity: 2, unit: "heads" },
    { name: "olive oil", quantity: 1, unit: "tbsp" },
  ],
  steps: [
    { text: "Heat oven to 220C", estimatedMinutes: 5 },
    { text: "Roast 20 min", estimatedMinutes: 20, isTimingSensitive: true },
  ],
};

test("draftDishToBuilderDish: maps name, ingredients and steps across", () => {
  const dish = draftDishToBuilderDish(fullDraft, makeAlloc());
  assert.equal(dish.name, "Roasted Broccoli");
  assert.equal(dish.ingredients.length, 2);
  assert.deepEqual(
    dish.ingredients.map((i) => [i.quantity, i.unit, i.name]),
    [
      ["2", "heads", "broccoli"],
      ["1", "tbsp", "olive oil"],
    ],
  );
  assert.equal(dish.steps.length, 2);
  assert.equal(dish.steps[0].text, "Heat oven to 220C");
  assert.equal(dish.steps[0].estimatedMinutes, "5");
  assert.equal(dish.steps[1].isTimingSensitive, true);
});

test("draftDishToBuilderDish: zero/absent estimatedMinutes becomes empty string", () => {
  const draft: DraftDish = {
    ...fullDraft,
    steps: [{ text: "mix" }, { text: "rest", estimatedMinutes: 0 }],
  };
  const dish = draftDishToBuilderDish(draft, makeAlloc());
  assert.equal(dish.steps[0].estimatedMinutes, "");
  assert.equal(dish.steps[1].estimatedMinutes, "");
});

test("draftDishToBuilderDish: empty ingredients seed one blank row (editable)", () => {
  const draft: DraftDish = { ...fullDraft, ingredients: [], steps: [] };
  const dish = draftDishToBuilderDish(draft, makeAlloc());
  assert.equal(dish.ingredients.length, 1);
  assert.equal(dish.ingredients[0].name, "");
  assert.equal(dish.steps.length, 0);
});

test("draftDishToBuilderDish: every row gets a unique uid from the allocator", () => {
  const dish = draftDishToBuilderDish(fullDraft, makeAlloc());
  const uids = [
    dish.uid,
    ...dish.ingredients.map((i) => i.uid),
    ...dish.steps.map((s) => s.uid),
  ];
  assert.equal(new Set(uids).size, uids.length, "uids must be unique");
});
