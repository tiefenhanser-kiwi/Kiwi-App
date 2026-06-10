// WS7-6 C-fix Block 4 — shared wire→SavedDish adapter field-map tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import { savedDishFromListItem } from "../savedDishFromListItem";
import type { DishListItem } from "../../api/dishes";

function makeListItem(overrides: Partial<DishListItem> = {}): DishListItem {
  return {
    id: "dish-1",
    title: "Jasmine Rice",
    minutes: 20,
    servings: 4,
    difficulty: "easy",
    calories: 220,
    protein: 4,
    carbs: 48,
    fat: 1,
    tags: ["side"],
    image: "https://example.com/rice.jpg",
    mealUseCount: 5,
    ...overrides,
  };
}

test("savedDishFromListItem: maps the renamed-flat wire fields onto SavedDish", () => {
  const out = savedDishFromListItem(makeListItem());
  assert.equal(out.id, "dish-1");
  assert.equal(out.name, "Jasmine Rice"); // name ← title
  assert.equal(out.imageUrl, "https://example.com/rice.jpg"); // imageUrl ← image
  assert.equal(out.caloriesPerServing, 220);
  assert.equal(out.proteinGPerServing, 4);
  assert.equal(out.carbsGPerServing, 48);
  assert.equal(out.fatGPerServing, 1);
  assert.equal(out.estimatedTimeMinutes, 20); // estimatedTimeMinutes ← minutes
});

test("savedDishFromListItem: null image becomes undefined (SavedDish has no null imageUrl)", () => {
  const out = savedDishFromListItem(makeListItem({ image: null }));
  assert.equal(out.imageUrl, undefined);
});

test("savedDishFromListItem: ingredients default to [] (list shape omits them)", () => {
  const out = savedDishFromListItem(makeListItem());
  assert.deepEqual(out.ingredients, []);
});

test("savedDishFromListItem: type defaults to 'main' (wire carries no dish type)", () => {
  const out = savedDishFromListItem(makeListItem());
  assert.equal(out.type, "main");
});

test("savedDishFromListItem: mealUseCount passes through (live-meal count)", () => {
  assert.equal(savedDishFromListItem(makeListItem({ mealUseCount: 0 })).mealUseCount, 0);
  assert.equal(savedDishFromListItem(makeListItem({ mealUseCount: 3 })).mealUseCount, 3);
});

test("savedDishFromListItem: zero macros pass through unchanged (real data, not a bug)", () => {
  const out = savedDishFromListItem(
    makeListItem({ calories: 0, protein: 0, carbs: 0, fat: 0 }),
  );
  assert.equal(out.caloriesPerServing, 0);
  assert.equal(out.proteinGPerServing, 0);
  assert.equal(out.carbsGPerServing, 0);
  assert.equal(out.fatGPerServing, 0);
});
