// WS7-3 Block C2 Commit 3 — unit tests for the Plans tab default-filter
// resolution. Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { plansFilterDefault } from "../filterDefault";

test("plansFilterDefault: no saved filters + 0 saved plans → Featured", () => {
  assert.deepEqual(plansFilterDefault([], 0), ["featured"]);
});

test("plansFilterDefault: no saved filters + ≥1 saved plan → My Plans", () => {
  assert.deepEqual(plansFilterDefault([], 1), ["my_plans"]);
  assert.deepEqual(plansFilterDefault([], 12), ["my_plans"]);
});

test("plansFilterDefault: a saved filter overrides the count-based default", () => {
  // The persisted filter wins regardless of saved-plan count.
  assert.deepEqual(plansFilterDefault(["top_rated"], 0), ["top_rated"]);
  assert.deepEqual(plansFilterDefault(["featured"], 5), ["featured"]);
});

test("plansFilterDefault: takes the first key of a multi-value persisted array", () => {
  // Single-select (4H-2): a persisted multi-select array narrows to its
  // first element.
  assert.deepEqual(
    plansFilterDefault(["hosting_events", "my_plans"], 3),
    ["hosting_events"],
  );
});
