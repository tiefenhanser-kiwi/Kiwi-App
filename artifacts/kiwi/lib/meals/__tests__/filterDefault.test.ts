// WS7-3 Block C3 Commit 1 — unit tests for the Meals sub-tab default-filter
// resolution. Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mealsFilterDefault } from "../filterDefault";

test("mealsFilterDefault: no saved filters → My Meals", () => {
  assert.deepEqual(mealsFilterDefault([]), ["my_meals"]);
});

test("mealsFilterDefault: a saved filter overrides the default", () => {
  assert.deepEqual(mealsFilterDefault(["featured"]), ["featured"]);
  assert.deepEqual(mealsFilterDefault(["top_rated"]), ["top_rated"]);
  assert.deepEqual(mealsFilterDefault(["hosting"]), ["hosting"]);
});

test("mealsFilterDefault: takes the first key of a multi-value persisted array", () => {
  // Single-select (D-WS7-049 carryover): a persisted multi-select array
  // narrows to its first element.
  assert.deepEqual(mealsFilterDefault(["featured", "my_meals"]), ["featured"]);
});
