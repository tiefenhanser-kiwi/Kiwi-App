// Row 13 "Test Kitchen" · Block 2b (BUG-315) — which steps a recipe renders.
//
// The guest recipe screen read `meal.steps` and rendered a section only when it
// was non-empty. On a multi-dish catalog meal — every meal the Test Kitchen
// serves — that array is [] and the steps live on dishes[].steps (8 per dish in
// the browser pass), so the section never mounted and the screen looked like a
// recipe with no method. app/meal/[id].tsx already had the right rule, as two
// expressions inline inside a 700-line component in app/** (outside the test
// glob). They are shared now, and pinned here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { flatMealSteps, mealStepsAreGrouped, stepBearingDishes } from "../mealSteps";

type S = { text: string };
const steps = (n: number, prefix: string): S[] =>
  Array.from({ length: n }, (_, i) => ({ text: `${prefix}-${i}` }));

// The browser pass's payload shape: meal-owned steps empty, 8 steps on each of
// two dishes. This is the meal the guest screen rendered nothing for.
const CATALOG_MEAL = {
  steps: [] as S[],
  dishes: [{ steps: steps(8, "a") }, { steps: steps(8, "b") }],
};

test("🔴 BUG-315 — the steps count RENDERED equals the payload's, on the browser-pass meal", () => {
  const payloadCount =
    CATALOG_MEAL.steps.length + CATALOG_MEAL.dishes.reduce((n, d) => n + d.steps.length, 0);
  assert.equal(payloadCount, 16);
  // What the old screen rendered: `meal.steps` — nothing at all.
  assert.equal(CATALOG_MEAL.steps.length, 0);
  // What the shared decision renders: all 16, grouped per dish.
  assert.equal(mealStepsAreGrouped(CATALOG_MEAL), true);
  assert.equal(flatMealSteps(CATALOG_MEAL).length, payloadCount);
  const grouped = stepBearingDishes(CATALOG_MEAL.dishes);
  assert.equal(grouped.reduce((n, d) => n + d.steps.length, 0), payloadCount);
  // Both layouts render the same steps, in the same order — the invariant that
  // makes flatMealSteps().length the answer to "how many did the screen show".
  assert.deepEqual(
    grouped.flatMap((d) => d.steps),
    flatMealSteps(CATALOG_MEAL),
  );
});

test("meal-OWNED steps win and render flat — composeMealDetail copies them onto every dish", () => {
  // Grouping these would print the same steps once per dish (PRD §10.6).
  const meal = {
    steps: steps(5, "m"),
    dishes: [{ steps: steps(5, "m") }, { steps: steps(5, "m") }],
  };
  assert.equal(mealStepsAreGrouped(meal), false);
  assert.equal(flatMealSteps(meal).length, 5);
  assert.deepEqual(flatMealSteps(meal), meal.steps);
});

test("a SINGLE-dish meal is flat — one heading over one dish is noise", () => {
  const meal = { steps: [] as S[], dishes: [{ steps: steps(8, "a") }] };
  assert.equal(mealStepsAreGrouped(meal), false);
  // Still 8 steps rendered: flat reads through to the dish.
  assert.equal(flatMealSteps(meal).length, 8);
});

test("multi-dish with NO steps anywhere is not grouped, and renders nothing", () => {
  const meal = { steps: [] as S[], dishes: [{ steps: [] as S[] }, { steps: [] as S[] }] };
  assert.equal(mealStepsAreGrouped(meal), false);
  assert.equal(flatMealSteps(meal).length, 0);
  assert.equal(stepBearingDishes(meal.dishes).length, 0);
});

test("a stepless dish gets no empty section", () => {
  const meal = {
    steps: [] as S[],
    dishes: [{ steps: steps(4, "a") }, { steps: [] as S[] }, { steps: steps(2, "c") }],
  };
  assert.equal(mealStepsAreGrouped(meal), true);
  assert.equal(stepBearingDishes(meal.dishes).length, 2);
  assert.equal(flatMealSteps(meal).length, 6);
});

test("dish order is preserved in the flat list", () => {
  const meal = {
    steps: [] as S[],
    dishes: [{ steps: [{ text: "first" }] }, { steps: [{ text: "second" }] }],
  };
  assert.deepEqual(
    flatMealSteps(meal).map((s) => s.text),
    ["first", "second"],
  );
});
