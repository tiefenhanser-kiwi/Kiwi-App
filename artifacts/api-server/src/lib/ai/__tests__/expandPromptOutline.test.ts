// WS9 BUG-245 (O1) — wizard.candidate.expand v7 asks for a timed OUTLINE per
// dish, and the draft's time is derived from it (wizardExpansion.ts).
//
// Why an outline and not the number: on a 30-minute plan the unsaved draft read
// 28 · 29 · 30 · 30 and the same plan, saved and stamped from real steps, read
// 28 · 29 · 44 · 56. Three of three live meals under a cap had an authored
// scalar EQUAL to the cap — v6's "STATE ITS TRUE TIME" did not hold on a live
// model — while the same model's STEP minutes were honest (the meatloaf). So
// the number the card shows is now computed from step-shaped minutes, by the
// same scheduler the save-time stamp uses.
//
// Asserted against the SEED SOURCE (the exported body), never the DB — see
// expandPromptTiming.test.ts for why. Every expected string is a hand-written
// literal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WIZARD_CANDIDATE_EXPAND_BODY } from "../../../../prisma/seeds/aiPrompts";

describe("wizard.candidate.expand v7 — the timed outline (BUG-245 O1)", () => {
  const body = WIZARD_CANDIDATE_EXPAND_BODY;

  it("asks for a per-dish outline of { phaseType, estimatedMinutes, isTimingSensitive } with no step text", () => {
    assert.ok(
      body.includes(
        "For each dish, also write `outline`: the recipe's steps in order as `{ phaseType, estimatedMinutes, isTimingSensitive }` — no step text.",
      ),
      "the outline rule must be present, in the output shape the schema validates",
    );
    assert.ok(
      body.includes("Do not shorten steps to fit a time limit"),
      "the outline must not be the new place the cap bends a number",
    );
  });

  it("no longer says 'you do NOT produce steps' — the old section is replaced, not layered", () => {
    assert.equal(
      body.includes("you do NOT produce steps"),
      false,
      "v6's opening sentence forbade step-shaped output; layering an outline rule under it would be the line-824 pattern",
    );
    assert.equal(
      body.includes("# Do NOT produce cooking steps"),
      false,
      "v6's section heading must be gone (replaced by the outline section)",
    );
    // The one thing that section correctly said is kept: no `steps` field.
    assert.ok(
      body.includes("do not include a `steps` field"),
      "written steps are still finalize_steps' job",
    );
  });

  it("keeps the cap-constrains-selection sentence in substance", () => {
    assert.ok(
      body.includes(
        "THE CAP CONSTRAINS WHICH RECIPES YOU PICK. IT DOES NOT CONSTRAIN THE NUMBER YOU WRITE DOWN.",
      ),
      "v6's cap text stays — the outline rule points back at it",
    );
  });

  it("tells the model unattended time counts in a step and what isTimingSensitive means", () => {
    assert.ok(body.includes("a 45-minute bake is 45"));
    assert.ok(
      body.includes("true only when the step needs the cook's attention throughout"),
      "isTimingSensitive is the scheduler's unattended predicate; the model must be told its meaning",
    );
  });
});
