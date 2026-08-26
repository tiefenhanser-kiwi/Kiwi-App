// WS7-3 C4 c2 — adapter tests for mealListItemToSummary. Pure function, no
// React.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MealListItem } from "@/lib/api/meals";

import { mealListItemToSummary } from "../mealListItemToSummary";

function makeItem(over: Partial<MealListItem> = {}): MealListItem {
  return {
    id: "m-1",
    title: "Test Meal",
    cuisine: "Italian",
    minutes: 30,
    servings: 4,
    calories: 500,
    protein: 30,
    carbs: 40,
    fat: 20,
    tags: [],
    image: null,
    ...over,
  };
}

test("mealListItemToSummary: my_meals filter maps to saved source", () => {
  const result = mealListItemToSummary(makeItem(), "my_meals");
  assert.equal(result.source, "saved");
});

test("mealListItemToSummary: featured filter maps to featured source", () => {
  const result = mealListItemToSummary(makeItem(), "featured");
  assert.equal(result.source, "featured");
});

test("mealListItemToSummary: top_rated filter maps to top_rated source", () => {
  const result = mealListItemToSummary(makeItem(), "top_rated");
  assert.equal(result.source, "top_rated");
});

test("mealListItemToSummary: hosting filter maps to hosting source", () => {
  const result = mealListItemToSummary(makeItem(), "hosting");
  assert.equal(result.source, "hosting");
});

test("mealListItemToSummary: empty cuisine string becomes undefined", () => {
  const result = mealListItemToSummary(makeItem({ cuisine: "" }), "my_meals");
  assert.equal(result.cuisineType, undefined);
});

test("mealListItemToSummary: non-empty cuisine carries through", () => {
  const result = mealListItemToSummary(
    makeItem({ cuisine: "Mexican" }),
    "featured",
  );
  assert.equal(result.cuisineType, "Mexican");
});

test("mealListItemToSummary: null image becomes undefined imageUrl", () => {
  const result = mealListItemToSummary(makeItem({ image: null }), "my_meals");
  assert.equal(result.imageUrl, undefined);
});

test("mealListItemToSummary: non-null image carries through to imageUrl", () => {
  const url = "https://example.com/meal.jpg";
  const result = mealListItemToSummary(makeItem({ image: url }), "my_meals");
  assert.equal(result.imageUrl, url);
});

test("mealListItemToSummary: difficulty defaults to easy (Ruling 8)", () => {
  // MealListItem lacks `difficulty`; the adapter ships "easy" as a cosmetic
  // default. PRD-alignment finding for WS7-CLOSE redline batch.
  const result = mealListItemToSummary(makeItem(), "my_meals");
  assert.equal(result.difficulty, "easy");
});

test("mealListItemToSummary: macros + minutes + servings carry through 1:1", () => {
  const result = mealListItemToSummary(
    makeItem({
      minutes: 45,
      servings: 6,
      calories: 620,
      protein: 38,
      carbs: 52,
      fat: 32,
    }),
    "top_rated",
  );
  assert.equal(result.estimatedTimeMinutes, 45);
  assert.equal(result.servingsDefault, 6);
  assert.equal(result.caloriesPerServing, 620);
  assert.equal(result.proteinGPerServing, 38);
  assert.equal(result.carbsGPerServing, 52);
  assert.equal(result.fatGPerServing, 32);
});

test("mealListItemToSummary: cook-stat fields stay undefined (D-WS7-048)", () => {
  const result = mealListItemToSummary(makeItem(), "my_meals");
  assert.equal(result.timesCooked, undefined);
  assert.equal(result.lastCookedAt, undefined);
  assert.equal(result.createdAt, undefined);
});

// ── WS9 BUG-153 — the sub-text this adapter used to drop ────────────────────
//
// MealListItemSchema has carried `description` since D-WS9-124; this adapter
// was the single place it fell on the floor, which is why the picker sheets
// rendered a bare title while the wire was sending the line all along.
//
// ⚠️ The empty case is asserted as hard as the present one. 61% of live meals
// carry no description because the wizard writer does not populate it
// (BUG-156), and the render must show NOTHING for those — no placeholder, no
// fallback — so that gap stays visible on device instead of being papered over.

test("mealListItemToSummary: carries `description` through (BUG-153)", () => {
  const result = mealListItemToSummary(
    makeItem({ description: "Marinated grilled steak folded in flour tortillas." }),
    "my_meals",
  );
  assert.equal(
    result.description,
    "Marinated grilled steak folded in flour tortillas.",
  );
});

test("mealListItemToSummary: a null description becomes undefined, never a fallback string", () => {
  const nulled = mealListItemToSummary(makeItem({ description: null }), "my_meals");
  assert.equal(nulled.description, undefined);
  // Absent on the wire (pre-redeploy server) behaves identically.
  const absent = mealListItemToSummary(makeItem({ description: undefined }), "my_meals");
  assert.equal(absent.description, undefined);
  // Explicitly NOT a placeholder — the row must render nothing at all.
  assert.notEqual(nulled.description, "");
  assert.notEqual(nulled.description, "No description available");
});
