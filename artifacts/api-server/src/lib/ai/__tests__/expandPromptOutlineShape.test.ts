// WS9 BUG-245 — wizard.candidate.expand v8: the outline is written at
// finalize_steps' SHAPE, so the draft's time is derived from the same amount
// of work the saved steps will describe.
//
// Measured (September 11): the v7 draft ran 11–22 minutes UNDER the saved time
// (38→49 · 35→57 · 55→76) because the outline was thinner than the steps
// finalize writes — 2.3–3.0 outline entries per dish against 6.3 (wizard-
// finalized) / 7.0 (catalog) steps; one prep block where finalize writes 3–7
// prep steps; no plating on half the dishes; a preheat on 1 of 8; no rest
// after a cook. Minutes per step were similar; finalize is not padding. So v8
// asks for one entry per step at finalize's own "4–10 per dish, begin with
// prep, end with plating" grain. finalize_steps is NOT edited.
//
// Asserted against the SEED SOURCE (the exported body), never the DB — see
// expandPromptTiming.test.ts for why. Every expected string is a hand-written
// literal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WIZARD_CANDIDATE_EXPAND_BODY } from "../../../../prisma/seeds/aiPrompts";

describe("wizard.candidate.expand v8 — the outline at finalize's shape (BUG-245)", () => {
  const body = WIZARD_CANDIDATE_EXPAND_BODY;

  it("states the grain: one entry per step, usually 4–10 per dish", () => {
    assert.ok(
      body.includes(
        "Write the outline at the grain the written recipe will have — the same steps a home cook follows, in order, one entry per step: usually 4–10 per dish (1–3 for a genuinely simple side; do not pad).",
      ),
      "the grain sentence is what moves the outline from 2–3 entries to finalize's 4–10",
    );
  });

  it("asks for prep as separate entries and a preheat wherever something comes to heat", () => {
    assert.ok(
      body.includes(
        "Begin with the prep steps as separate entries (chop, measure, mix a marinade — each its own step at 3–6 minutes)",
      ),
      "one prep block per dish was the largest single source of the under-count",
    );
    assert.ok(
      body.includes("include a `preheat` wherever an oven, grill or pan must come to heat"),
      "v7 outlines carried a preheat on 1 of 8 dishes",
    );
  });

  it("ends each dish with an `assemble` step for plating", () => {
    assert.ok(
      body.includes("end each dish with an `assemble` step for plating"),
      "half the v7 dishes had no plating entry; finalize always writes one",
    );
  });

  it("a soak or marinade that sits is a `rest` step of its own", () => {
    assert.ok(
      body.includes(
        "A soak or marinade that sits is a `rest` step of its own, never folded into the prep before it.",
      ),
      "a marinade folded into prep is counted as hands-on work and its wait vanishes",
    );
  });

  it("keeps v7's 'do not shorten' rule and v6's cap-constrains-selection sentence", () => {
    assert.ok(
      body.includes("Do not shorten steps to fit a time limit"),
      "a fuller outline must not become the new place the cap bends a number",
    );
    assert.ok(
      body.includes(
        "THE CAP CONSTRAINS WHICH RECIPES YOU PICK. IT DOES NOT CONSTRAIN THE NUMBER YOU WRITE DOWN.",
      ),
      "the cap text stays — the outline rule points back at it",
    );
  });

  it("the worked example is itself at that grain: ≥5 entries, prep · prep · preheat · cook · rest · assemble", () => {
    const start = body.indexOf("Example — a roast chicken thigh main");
    assert.ok(start >= 0, "the worked example must be present");
    const line = body.slice(start, body.indexOf("\n", start));
    const json = line.slice(line.indexOf("`[") + 1, line.lastIndexOf("]`") + 1);
    const entries = JSON.parse(json) as { phaseType: string }[];
    assert.ok(
      entries.length >= 5,
      `the example must show the grain it asks for (got ${entries.length} entries)`,
    );
    assert.deepEqual(
      entries.map((e) => e.phaseType),
      ["prep", "prep", "preheat", "cook", "rest", "assemble"],
      "two prep entries, a preheat, the roast, a rest, and plating — finalize's shape",
    );
  });
});
