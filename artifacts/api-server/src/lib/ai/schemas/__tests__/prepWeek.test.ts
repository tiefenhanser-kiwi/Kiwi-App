// WS6 6d-2 — PrepWeekResultSchema unit tests.
// Pure Zod parsing — no DB, no AI, no HTTP.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PrepWeekPhaseKey,
  PrepWeekResultSchema,
  type PrepWeekResult,
} from "../prepWeek";

const MEAL_ID_A = "11111111-1111-4111-8111-111111111111";
const MEAL_ID_B = "22222222-2222-4222-8222-222222222222";

function step(opts?: Partial<PrepWeekResult["phases"][number]["steps"][number]>) {
  return {
    number: 1,
    // WS7-8a B3 — stepKey is now a required wire field (stable persistence id).
    stepKey: "produce#11111111-1111-4111-8111-111111111111",
    title: "Dice onion",
    instructions: "Dice 3 onions total — 2 for tacos, 1 for stir-fry.",
    estimatedMinutes: 5,
    contributesToMealIds: [MEAL_ID_A, MEAL_ID_B],
    ...opts,
  };
}

function wellFormed(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 12,
    phases: [
      {
        phase: "seasonings_dry",
        title: "Seasonings & dry ingredients",
        skippable: true,
        steps: [
          step({
            number: 1,
            title: "Mix taco seasoning",
            instructions: "Combine cumin, chili powder, paprika.",
            estimatedMinutes: 2,
            contributesToMealIds: [MEAL_ID_A],
          }),
        ],
      },
      {
        phase: "sauces_marinades",
        title: "Sauces, marinades & garnishes",
        skippable: true,
        steps: [],
      },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [step()],
      },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          step({
            number: 1,
            title: "Portion ground beef",
            instructions: "Divide 1 lb beef for taco night.",
            estimatedMinutes: 2,
            contributesToMealIds: [MEAL_ID_A],
          }),
        ],
      },
    ],
  };
}

describe("PrepWeekResultSchema — happy path", () => {
  it("accepts a well-formed 4-phase result", () => {
    const parsed = PrepWeekResultSchema.safeParse(wellFormed());
    assert.equal(parsed.success, true);
  });
});

describe("PrepWeekResultSchema — phase-count enforcement", () => {
  it("rejects results with fewer than 4 phases", () => {
    const wf = wellFormed();
    wf.phases = wf.phases.slice(0, 3) as typeof wf.phases;
    const parsed = PrepWeekResultSchema.safeParse(wf);
    assert.equal(parsed.success, false);
  });

  it("rejects results with more than 4 phases", () => {
    const wf = wellFormed();
    // Append a duplicate — fails on length, but also on order.
    wf.phases = [...wf.phases, wf.phases[3]] as typeof wf.phases;
    const parsed = PrepWeekResultSchema.safeParse(wf);
    assert.equal(parsed.success, false);
  });
});

describe("PrepWeekResultSchema — phase-order enforcement", () => {
  it("rejects results where proteins is not last", () => {
    const wf = wellFormed();
    // Swap produce (idx 2) with proteins (idx 3) — proteins now appears third.
    [wf.phases[2], wf.phases[3]] = [wf.phases[3], wf.phases[2]];
    const parsed = PrepWeekResultSchema.safeParse(wf);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      const orderIssue = parsed.error.issues.find(
        (i) => i.path.join(".").startsWith("phases."),
      );
      assert.ok(orderIssue, "expected a phase-order issue");
    }
  });

  it("rejects results where seasonings_dry is not first", () => {
    const wf = wellFormed();
    [wf.phases[0], wf.phases[1]] = [wf.phases[1], wf.phases[0]];
    const parsed = PrepWeekResultSchema.safeParse(wf);
    assert.equal(parsed.success, false);
  });
});

describe("PrepWeekResultSchema — step rules", () => {
  it("rejects steps with empty contributesToMealIds", () => {
    const wf = wellFormed();
    wf.phases[2].steps[0].contributesToMealIds = [];
    const parsed = PrepWeekResultSchema.safeParse(wf);
    assert.equal(parsed.success, false);
  });

  it("rejects steps with non-UUID contributesToMealIds entries", () => {
    const wf = wellFormed();
    wf.phases[2].steps[0].contributesToMealIds = ["not-a-uuid"];
    const parsed = PrepWeekResultSchema.safeParse(wf);
    assert.equal(parsed.success, false);
  });
});

describe("PrepWeekPhaseKey — enum membership", () => {
  it("contains exactly the 4 PRD §13.4.1 slugs in fixed order", () => {
    // Order matters for the prompt's "phases in this exact order" rule;
    // pin both the value set AND the array order.
    assert.deepEqual(PrepWeekPhaseKey.options, [
      "seasonings_dry",
      "sauces_marinades",
      "produce",
      "proteins",
    ]);
  });

  it("rejects unknown phase slugs", () => {
    // Guards against the previous (now-discarded) schema's
    // "prep_proteins" / "make_components" / "store_and_label" sneaking
    // back in.
    assert.equal(PrepWeekPhaseKey.safeParse("prep_proteins").success, false);
    assert.equal(PrepWeekPhaseKey.safeParse("make_components").success, false);
    assert.equal(PrepWeekPhaseKey.safeParse("store_and_label").success, false);
  });
});
