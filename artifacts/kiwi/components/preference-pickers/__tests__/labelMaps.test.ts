// Label-map coverage for the 4 enum-backed preference pickers.
//
// WS7-2 Block B Commit 1 moved the picker catalogs from display strings to
// canonical lowercase values (server contract), with a sibling label map
// rendering the human-readable text. These tests guard the invariant that
// every canonical value has exactly one non-empty display label — a missing
// entry would render `undefined` in a Chip at runtime.
//
// Pure-constant tests: domain.ts has no JSX / React / expo deps, so this
// file is .test.ts and runs under node --experimental-strip-types directly.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUDGET_LEVELS,
  BUDGET_LEVEL_LABELS,
  COOKING_SKILL_LABELS,
  COOKING_SKILL_LEVELS,
  SPICE_TOLERANCE_LABELS,
  SPICE_TOLERANCE_OPTIONS,
  STOVETOP_TYPES,
  STOVETOP_TYPE_LABELS,
} from "@/lib/domain";

function assertLabelCoverage(
  options: readonly string[],
  labels: Record<string, string>,
): void {
  for (const value of options) {
    const label = labels[value];
    assert.equal(typeof label, "string", `missing label for "${value}"`);
    assert.ok(label.length > 0, `empty label for "${value}"`);
  }
  // No orphan label keys without a matching canonical option.
  assert.equal(
    Object.keys(labels).length,
    options.length,
    "label map key count must match the canonical option count",
  );
}

test("SPICE_TOLERANCE_LABELS covers every canonical spice value", () => {
  assertLabelCoverage(SPICE_TOLERANCE_OPTIONS, SPICE_TOLERANCE_LABELS);
});

test("BUDGET_LEVEL_LABELS covers every canonical budget value", () => {
  assertLabelCoverage(BUDGET_LEVELS, BUDGET_LEVEL_LABELS);
});

test("COOKING_SKILL_LABELS covers every canonical skill value", () => {
  assertLabelCoverage(COOKING_SKILL_LEVELS, COOKING_SKILL_LABELS);
});

test("STOVETOP_TYPE_LABELS covers every canonical stovetop value", () => {
  assertLabelCoverage(STOVETOP_TYPES, STOVETOP_TYPE_LABELS);
});
