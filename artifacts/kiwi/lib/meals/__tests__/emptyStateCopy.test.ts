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

// Store-prep lane — the copy no longer invokes "the Kiwi community": on a
// store build there is not one yet. The chip is still named and the user is
// still told what to do, which is what this test is for.
test("mealsEmptyCopy: top_rated copy names the chip and offers the next step", () => {
  const copy = mealsEmptyCopy("top_rated");
  assert.match(copy, /top-rated/i);
  assert.match(copy, /\+ Add Meal/);
  assert.doesNotMatch(copy, /community/i);
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
