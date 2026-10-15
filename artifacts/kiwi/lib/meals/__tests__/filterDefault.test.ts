// WS7-3 Block C3 Commit 1 — unit tests for the Meals sub-tab default-filter
// resolution. Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mealsFilterDefault } from "../filterDefault";

test("mealsFilterDefault: no saved filters → My Meals", () => {
  assert.deepEqual(mealsFilterDefault([]), ["my_meals"]);
});

test("mealsFilterDefault: a saved filter that is still a chip overrides the default", () => {
  assert.deepEqual(mealsFilterDefault(["saved"]), ["saved"]);
  assert.deepEqual(mealsFilterDefault(["my_meals"]), ["my_meals"]);
});

test("BOOK-1C1: a persisted chip the tab no longer shows falls back to My Meals", () => {
  assert.deepEqual(mealsFilterDefault(["featured"]), ["my_meals"]);
  assert.deepEqual(mealsFilterDefault(["top_rated"]), ["my_meals"]);
  assert.deepEqual(mealsFilterDefault(["hosting"]), ["my_meals"]);
});

test("mealsFilterDefault: takes the first key of a multi-value persisted array", () => {
  // Single-select (D-WS7-049 carryover): a persisted multi-select array
  // narrows to its first element.
  assert.deepEqual(mealsFilterDefault(["saved", "my_meals"]), ["saved"]);
});
