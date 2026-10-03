// Prep the Week footer copy — Hans's device-pass wording (Oct 3), verbatim:
// "Next: {next step title} · This step: ~{n} min", and on the last step
// "Last step · This step: ~{n} min".

import assert from "node:assert/strict";
import { test } from "node:test";

import { prepWeekFooterLine } from "../prepWeekFooter";

test("a step with a next one: names it, then this step's minutes", () => {
  assert.equal(
    prepWeekFooterLine("Sauces and marinades", 12),
    "Next: Sauces and marinades · This step: ~12 min",
  );
});

test("the last step: 'Last step', then this step's minutes", () => {
  assert.equal(prepWeekFooterLine(null, 20), "Last step · This step: ~20 min");
});

test("a step with nothing to prep drops the minutes rather than saying ~0", () => {
  assert.equal(prepWeekFooterLine("Produce", 0), "Next: Produce");
  assert.equal(prepWeekFooterLine(null, 0), "Last step");
});
