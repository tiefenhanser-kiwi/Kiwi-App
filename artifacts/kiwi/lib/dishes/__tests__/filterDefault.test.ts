// WS7-3 Block C3 Commit 2 — unit tests for the Dishes sub-tab default-filter
// resolution. Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { dishesFilterDefault } from "../filterDefault";

test("dishesFilterDefault: no saved filters → My Dishes", () => {
  assert.deepEqual(dishesFilterDefault([]), ["my_dishes"]);
});

test("dishesFilterDefault: a saved filter overrides the default", () => {
  // Persistence channel is dormant until D-WS7-051 lands schema, but the
  // helper still narrows a future persisted value.
  assert.deepEqual(dishesFilterDefault(["featured"]), ["featured"]);
  assert.deepEqual(dishesFilterDefault(["top_rated"]), ["top_rated"]);
});

test("dishesFilterDefault: takes the first key of a multi-value persisted array", () => {
  assert.deepEqual(
    dishesFilterDefault(["featured", "my_dishes"]),
    ["featured"],
  );
});
