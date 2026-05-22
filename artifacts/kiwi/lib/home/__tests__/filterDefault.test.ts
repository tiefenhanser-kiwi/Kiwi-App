// WS7-3 Block C2 Commit 2 — unit tests for the Home Plan Discovery
// default-filter resolution. Pure function, no React / no JSX.

import assert from "node:assert/strict";
import { test } from "node:test";

import { homeFilterDefault } from "../filterDefault";

test("homeFilterDefault: no saved filters → Featured (R1)", () => {
  assert.deepEqual(homeFilterDefault([]), ["featured"]);
});

test("homeFilterDefault: a saved filter wins over the default", () => {
  assert.deepEqual(homeFilterDefault(["my_plans"]), ["my_plans"]);
  assert.deepEqual(homeFilterDefault(["top_rated"]), ["top_rated"]);
});

test("homeFilterDefault: takes the first key of a multi-value persisted array", () => {
  // Single-select (4H-2): a persisted multi-select array is narrowed to
  // its first element.
  assert.deepEqual(
    homeFilterDefault(["hosting_events", "featured"]),
    ["hosting_events"],
  );
});
