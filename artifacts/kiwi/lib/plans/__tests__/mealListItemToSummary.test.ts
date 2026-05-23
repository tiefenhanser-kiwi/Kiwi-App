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
