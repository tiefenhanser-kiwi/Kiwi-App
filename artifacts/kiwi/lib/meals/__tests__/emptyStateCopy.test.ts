// WS7-3 Block C3 Commit 1 — unit tests for the Meals sub-tab per-chip empty
// state copy (Phase 2 Ruling D1). Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { MEAL_FILTER_KEYS } from "@/lib/api/meals";
import { mealsEmptyCopy } from "../emptyStateCopy";

test("mealsEmptyCopy: my_meals copy points to + Add Meal + Featured", () => {
  const copy = mealsEmptyCopy("my_meals");
  assert.match(copy, /\+ Add Meal/);
  assert.match(copy, /Featured/);
});

test("mealsEmptyCopy: featured copy acknowledges seeding state", () => {
  const copy = mealsEmptyCopy("featured");
  assert.match(copy, /featured/i);
  assert.match(copy, /still growing/);
});

test("mealsEmptyCopy: top_rated copy acknowledges transient empty", () => {
  const copy = mealsEmptyCopy("top_rated");
  assert.match(copy, /top-rated/i);
  assert.match(copy, /community/);
});

test("mealsEmptyCopy: hosting copy acknowledges seeding state", () => {
  const copy = mealsEmptyCopy("hosting");
  assert.match(copy, /hosting/i);
  assert.match(copy, /still growing/);
});

test("mealsEmptyCopy: every MEAL_FILTER_KEYS chip resolves a non-empty string", () => {
  for (const chip of MEAL_FILTER_KEYS) {
    const copy = mealsEmptyCopy(chip);
    assert.ok(typeof copy === "string" && copy.length > 0, `empty copy for ${chip}`);
  }
});
