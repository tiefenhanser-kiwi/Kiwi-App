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

// ── WS9 BUG-278 (client half) — the dish-side twin of BUG-273 ──────────────

test("BUG-278: a mode_a_parse-shaped dish keeps phaseType (+ parallelGroup) through the adapter", () => {
  const parsed = base();
  parsed.steps = [
    { content: "Heat oven to 425F.", estimatedMinutes: 5, phaseType: "preheat" },
    { content: "Toss and roast.", estimatedMinutes: 22, phaseType: "cook", isTimingSensitive: true, parallelGroup: "roast" },
    { content: "Rest 5 min.", estimatedMinutes: 5, phaseType: "rest", parallelGroup: null },
  ];
  const draft = parsedDishToDraft(parsed);
  // 🔴 THE BREAK THIS CATCHES: dropping phaseType from the mapping — every
  // Ask-Kiwi dish then saves with the DB default (cook) and the Cook Mode prep
  // filter has nothing to work with.
  assert.deepEqual(draft.steps.map((s) => s.phaseType), ["preheat", "cook", "rest"]);
  assert.equal("parallelGroup" in draft.steps[0], false, "absent stays absent (server keeps)");
  assert.equal(draft.steps[1].parallelGroup, "roast");
  assert.equal(draft.steps[2].parallelGroup, null, "explicit null survives (server clears)");
});
