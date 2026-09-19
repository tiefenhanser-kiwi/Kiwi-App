// D-WS9-191 Block 1 (Part A.4) — composeCandidateMeals / toWireCandidate.
//
// The chooser card needs a title AND a description per meal row at choose
// time. A store slot's description is the DB row's (pre-loaded on the
// shortlist, keyed by real id); a live slot's is the model's non-empty entry;
// blank → null; a mismatched-length model array is ignored for the whole
// candidate, never a dropped candidate. Pure: no Prisma, no AI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  composeCandidateMeals,
  toWireCandidate,
} from "../wizardCandidateMeals";
import {
  WizardPlanCandidateSchema,
  type WizardPlanCandidate,
} from "../ai/schemas/wizard";
import { logger } from "../logger";

function candidate(over: Partial<WizardPlanCandidate> = {}): WizardPlanCandidate {
  return {
    id: "c1",
    title: "Cozy Week",
    tags: ["Comfort"],
    whyBullets: ["one-pot"],
    mealTitles: ["Shelf ragu", "Fresh tacos", "Shelf soup"],
    dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
    storeSlots: [
      { slotIndex: 0, storeMealId: "real-ragu" },
      { slotIndex: 2, storeMealId: "real-soup" },
    ],
    ...over,
  };
}

const DESC = new Map<string, string | null>([
  ["real-ragu", "A slow-simmered beef ragu over pappardelle."],
  ["real-soup", "   "], // blank in the DB (Phase 0: ~3.7% of public dinners)
]);
const TIME = new Map<string, number>([
  ["real-ragu", 45],
  ["real-soup", 30],
]);

describe("composeCandidateMeals", () => {
  it("store-first: a store slot reads the DB description + time + real id; a live slot reads the model", () => {
    const meals = composeCandidateMeals(
      candidate({ mealDescriptions: ["", "Crispy carnitas tacos with lime crema.", ""] }),
      { descriptionById: DESC, timeById: TIME },
    );
    assert.deepEqual(meals, [
      {
        title: "Shelf ragu",
        description: "A slow-simmered beef ragu over pappardelle.",
        storeMealId: "real-ragu",
        estimatedTimeMinutes: 45,
      },
      { title: "Fresh tacos", description: "Crispy carnitas tacos with lime crema." },
      {
        title: "Shelf soup",
        description: null,
        storeMealId: "real-soup",
        estimatedTimeMinutes: 30,
      },
    ]);
  });

  it("model fallback: a store slot whose DB description is blank takes the model's non-empty entry", () => {
    const meals = composeCandidateMeals(
      candidate({ mealDescriptions: ["", "", "A brothy chicken soup."] }),
      { descriptionById: DESC, timeById: TIME },
    );
    assert.equal(meals[2].description, "A brothy chicken soup.");
    assert.equal(meals[2].storeMealId, "real-soup");
  });

  it("the DB description WINS over a model entry on a store slot", () => {
    const meals = composeCandidateMeals(
      candidate({ mealDescriptions: ["The model's own ragu line.", "", ""] }),
      { descriptionById: DESC },
    );
    assert.equal(meals[0].description, "A slow-simmered beef ragu over pappardelle.");
  });

  it("blank → null: a live slot with an empty or whitespace entry, or no array at all, is null", () => {
    const a = composeCandidateMeals(candidate({ mealDescriptions: ["", "  ", ""] }), {
      descriptionById: DESC,
    });
    assert.equal(a[1].description, null);
    const b = composeCandidateMeals(candidate(), { descriptionById: DESC });
    assert.equal(b[1].description, null);
    assert.equal(b[0].description, "A slow-simmered beef ragu over pappardelle.");
    // No time map → no estimatedTimeMinutes key at all (not undefined).
    assert.equal("estimatedTimeMinutes" in b[0], false);
  });

  it("length mismatch: the model's array is ignored for the candidate (one warn), the candidate survives", () => {
    const warns: Array<Record<string, unknown>> = [];
    const realWarn = logger.warn.bind(logger);
    (logger as unknown as { warn: unknown }).warn = ((obj: unknown, ...rest: unknown[]) => {
      if (obj && typeof obj === "object") warns.push(obj as Record<string, unknown>);
      return realWarn(obj as never, ...(rest as [never]));
    }) as never;
    try {
      const meals = composeCandidateMeals(
        candidate({ mealDescriptions: ["only", "two"] }),
        { descriptionById: DESC },
      );
      assert.equal(meals.length, 3);
      assert.equal(meals[1].description, null, "the live slot did not read the misaligned array");
      assert.equal(meals[0].description, "A slow-simmered beef ragu over pappardelle.");
      assert.equal(
        warns.filter((w) => w.event === "wizard_candidate_descriptions_length_mismatch").length,
        1,
      );
    } finally {
      (logger as unknown as { warn: unknown }).warn = realWarn;
    }
  });

  // Row 5 Block 4 — the plan-option card's thumb rides the wire row.
  it("imageUrl: a store slot carries its row's image; a store slot whose row has none, and a live slot, carry NO key", () => {
    const IMG = new Map<string, string | null>([
      ["real-ragu", "https://img.example/ragu.png"],
      ["real-soup", null], // the queue has not written one yet
    ]);
    const meals = composeCandidateMeals(
      candidate({ mealDescriptions: ["", "Tacos.", ""] }),
      { descriptionById: DESC, timeById: TIME, imageUrlById: IMG },
    );
    assert.equal(meals[0].imageUrl, "https://img.example/ragu.png");
    // Store-bound, no image yet → the key is ABSENT (not null/undefined) so
    // the mobile row renders the ramp exactly as a legacy row does.
    assert.equal("imageUrl" in meals[2], false);
    // A live slot has no Meal row → never an image, never a sibling's.
    assert.equal("imageUrl" in meals[1], false);
    assert.deepEqual(meals[1], { title: "Fresh tacos", description: "Tacos." });
  });

  it("imageUrl: no map at all (an older caller) → no key on any row", () => {
    const meals = composeCandidateMeals(candidate(), { descriptionById: DESC, timeById: TIME });
    for (const m of meals) assert.equal("imageUrl" in m, false);
  });

  it("imageUrl: a blank stored value is treated as no image", () => {
    const meals = composeCandidateMeals(candidate(), {
      descriptionById: DESC,
      imageUrlById: new Map([["real-ragu", "   "]]),
    });
    assert.equal("imageUrl" in meals[0], false);
  });

  it("a fully-live candidate (no storeSlots) reads only the model", () => {
    const meals = composeCandidateMeals(
      candidate({ storeSlots: undefined, mealDescriptions: ["a", "b", "c"] }),
      { descriptionById: DESC, timeById: TIME },
    );
    assert.deepEqual(meals, [
      { title: "Shelf ragu", description: "a" },
      { title: "Fresh tacos", description: "b" },
      { title: "Shelf soup", description: "c" },
    ]);
  });
});

describe("toWireCandidate", () => {
  it("adds meals and strips the raw mealDescriptions; mealTitles/storeSlots untouched", () => {
    const wire = toWireCandidate(
      candidate({ mealDescriptions: ["", "Tacos.", ""] }),
      { descriptionById: DESC },
    );
    assert.equal("mealDescriptions" in wire, false);
    assert.deepEqual(wire.mealTitles, ["Shelf ragu", "Fresh tacos", "Shelf soup"]);
    assert.deepEqual(wire.storeSlots, [
      { slotIndex: 0, storeMealId: "real-ragu" },
      { slotIndex: 2, storeMealId: "real-soup" },
    ]);
    assert.equal(wire.meals.length, 3);
    assert.equal(wire.meals[1].description, "Tacos.");
  });
});

describe("WizardPlanCandidateSchema — mealDescriptions is optional", () => {
  it("a candidate WITHOUT mealDescriptions validates; with it, it must be a string array", () => {
    const { mealDescriptions: _none, ...bare } = candidate();
    assert.equal(WizardPlanCandidateSchema.safeParse(bare).success, true);
    assert.equal(
      WizardPlanCandidateSchema.safeParse({ ...bare, mealDescriptions: ["", "x", ""] }).success,
      true,
    );
    assert.equal(
      WizardPlanCandidateSchema.safeParse({ ...bare, mealDescriptions: [1, 2, 3] }).success,
      false,
    );
  });

  it("the field's tool-schema guidance says one per title, same order, empty string for a shelf slot", () => {
    const desc = WizardPlanCandidateSchema.shape.mealDescriptions.description ?? "";
    assert.ok(desc.includes("One entry per mealTitles entry, in the same order"));
    assert.ok(desc.includes("For a slot you filled from the shelf write the empty string"));
  });
});
