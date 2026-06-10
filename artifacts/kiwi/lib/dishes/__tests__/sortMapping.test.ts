// WS7-6 C-fix Block 4 — shared dish sort-mapping. `last_cooked` is greyed in
// dish contexts (no Dish.lastUsedAt write path, D-WS7-111) and maps defensively
// to alpha; `times_cooked` relabels to "Most used".

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISH_DISABLED_SORT_KEYS,
  DISH_SORT_LABEL_OVERRIDES,
  toDishSortKey,
} from "../sortMapping";

test("toDishSortKey: passes server-backed keys through unchanged", () => {
  assert.equal(toDishSortKey("alpha"), "alpha");
  assert.equal(toDishSortKey("date_created"), "date_created");
  assert.equal(toDishSortKey("cook_time"), "cook_time");
  assert.equal(toDishSortKey("times_cooked"), "times_cooked");
});

test("toDishSortKey: maps the greyed last_cooked key defensively to alpha", () => {
  assert.equal(toDishSortKey("last_cooked"), "alpha");
});

test("DISH_DISABLED_SORT_KEYS: greys last_cooked", () => {
  assert.deepEqual(DISH_DISABLED_SORT_KEYS, ["last_cooked"]);
});

test("DISH_SORT_LABEL_OVERRIDES: relabels times_cooked to 'Most used'", () => {
  assert.equal(DISH_SORT_LABEL_OVERRIDES.times_cooked, "Most used");
});
