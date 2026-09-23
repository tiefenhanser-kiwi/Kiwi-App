// WS7-3 Block C3 Commit 2 — unit tests for the Dishes sub-tab per-chip empty
// state copy. Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DISH_FILTER_KEYS } from "@/lib/api/dishes";
import { dishesEmptyCopy } from "../emptyStateCopy";

test("dishesEmptyCopy: my_dishes copy points to + Add Dish + Featured", () => {
  const copy = dishesEmptyCopy("my_dishes");
  assert.match(copy, /\+ Add Dish/);
  assert.match(copy, /Featured/);
});

test("dishesEmptyCopy: featured copy acknowledges seeding state", () => {
  const copy = dishesEmptyCopy("featured");
  assert.match(copy, /featured/i);
  assert.match(copy, /still growing/);
});

// BUG-309 — INVERTED, deliberately, and identical to the meals twin. The copy
// used to promise "as the Kiwi community starts cooking"; on a store build with
// no users that names a community that does not exist. The chip still names
// itself and still offers the next step.
test("dishesEmptyCopy: top_rated copy names the chip and offers the next step", () => {
  const copy = dishesEmptyCopy("top_rated");
  assert.match(copy, /top-rated/i);
  assert.match(copy, /\+ Add Dish/);
  assert.doesNotMatch(copy, /community/i);
});

test("dishesEmptyCopy: every DISH_FILTER_KEYS chip resolves a non-empty string", () => {
  for (const chip of DISH_FILTER_KEYS) {
    const copy = dishesEmptyCopy(chip);
    assert.ok(typeof copy === "string" && copy.length > 0, `empty copy for ${chip}`);
  }
});
