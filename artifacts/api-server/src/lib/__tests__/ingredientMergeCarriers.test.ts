// WS9 BUG-096 (D-WS9-174) — ORPHAN-DETECTION GUARDS, one per carrier.
//
// THE RISK THESE COVER: three of the five id-carriers have no foreign key.
// Deleting a loser row that `amountRefs`, `PrepStepCompletion.stepKey` or
// `PrepWeekStructure.structureJson` still references orphans it silently —
// Postgres will not complain, and `GroceryListItem`'s FK is ON DELETE SET NULL,
// so it will not complain either (it nulls the column, and 80 rows are already
// null, so the damage hides in existing noise).
//
// Each carrier is asserted SEPARATELY and on purpose. A verification gate that
// catches amountRefs and misses structureJson emits output identical to one
// that catches both; the only way to tell them apart is to break one detector
// at a time and watch exactly one test go red.
//
// FIXTURE STRENGTH (§27.4): every fixture below is a real persisted shape —
// amountRefs carry the full { ingredientId, quantity, unit, charStart, charEnd }
// record from stepAmountRefs.ts, stepKeys use both the normal and the `#dish#`
// grouped form, and structureJson is a nested PrepWeekResult-shaped blob with
// the id buried inside a stepKey string rather than sitting at the top level.
// A flat fixture would be satisfied by a detector that only looked one level
// deep, i.e. by the wrong implementation as well as the right one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  countAmountRefHits,
  countOverrideNameHits,
  countStructureJsonHits,
  countSubstitutionHits,
  ingredientIdFromStepKey,
  rewriteAmountRefs,
  rewriteOverrideNames,
  rewriteRecurringItems,
  rewriteStepKey,
  rewriteStructureJson,
  rewriteSubstitutions,
  stepKeyTouches,
} from "../ingredientMergeCarriers";

const LOSER = "11111111-1111-4111-8111-111111111111";
const SURVIVOR = "22222222-2222-4222-8222-222222222222";
const UNRELATED = "33333333-3333-4333-8333-333333333333";

const LOSER_IDS = new Set([LOSER]);
const FOLD_IDS = new Map([[LOSER, SURVIVOR]]);

// ── carrier 3: amountRefs ───────────────────────────────────────────────────

describe("carrier: RecipeInstructionStep.amountRefs (NO FK — orphans silently)", () => {
  const step = [
    { ingredientId: LOSER, quantity: 0.75, unit: "cup", charStart: 4, charEnd: 11 },
    { ingredientId: UNRELATED, quantity: 2, unit: "tbsp", charStart: 20, charEnd: 26 },
    { ingredientId: LOSER, quantity: 1, unit: "", charStart: 40, charEnd: 41 },
  ];

  it("DETECTS a live reference to a loser", () => {
    assert.equal(countAmountRefHits(step, LOSER_IDS), 2);
  });

  it("reports zero on a step that references nothing in the fold", () => {
    assert.equal(countAmountRefHits([{ ingredientId: UNRELATED, quantity: 1, unit: "" }], LOSER_IDS), 0);
  });

  it("tolerates the legacy shapes without crashing the gate", () => {
    assert.equal(countAmountRefHits(null, LOSER_IDS), 0);
    assert.equal(countAmountRefHits(undefined, LOSER_IDS), 0);
    assert.equal(countAmountRefHits({ not: "an array" }, LOSER_IDS), 0);
    assert.equal(countAmountRefHits([{ ingredientId: 42 }, {}], LOSER_IDS), 0);
  });

  it("rewrites the id and preserves every other field byte-for-byte", () => {
    const out = rewriteAmountRefs(step, FOLD_IDS);
    assert.ok(out);
    assert.equal(out.changed, 2);
    assert.deepEqual(out.refs[0], {
      ingredientId: SURVIVOR, quantity: 0.75, unit: "cup", charStart: 4, charEnd: 11,
    });
    assert.deepEqual(out.refs[1], step[1], "an unrelated ref must be untouched");
    // After the rewrite the gate must see the step as clean.
    assert.equal(countAmountRefHits(out.refs, LOSER_IDS), 0);
  });

  it("returns null when nothing changed, so clean steps are never rewritten", () => {
    assert.equal(rewriteAmountRefs([{ ingredientId: UNRELATED }], FOLD_IDS), null);
  });
});

// ── carrier 4: PrepStepCompletion.stepKey ───────────────────────────────────

describe("carrier: PrepStepCompletion.stepKey (NO FK — orphans silently)", () => {
  it("DETECTS a live reference in a normal `${phase}#${ingredientId}` key", () => {
    assert.ok(stepKeyTouches(`produce#${LOSER}`, LOSER_IDS));
    assert.ok(stepKeyTouches(`sauces_marinades#${LOSER}`, LOSER_IDS));
  });

  it("does NOT mistake a `#dish#${dishId}` grouped key for an ingredient key", () => {
    // seasonings_dry blends (BUG-016 / D-WS7-187) and grouped sauce steps fold
    // MANY ingredient ids into one dish-keyed step. Treating the dishId as an
    // ingredientId would rewrite a key that has nothing to do with the merge.
    assert.equal(ingredientIdFromStepKey(`seasonings_dry#dish#${LOSER}`), null);
    assert.ok(!stepKeyTouches(`seasonings_dry#dish#${LOSER}`, LOSER_IDS));
    assert.equal(rewriteStepKey(`seasonings_dry#dish#${LOSER}`, FOLD_IDS), null);
  });

  it("reports zero for an unrelated ingredient", () => {
    assert.ok(!stepKeyTouches(`produce#${UNRELATED}`, LOSER_IDS));
  });

  it("rewrites only the id segment, preserving the phase prefix", () => {
    assert.equal(rewriteStepKey(`produce#${LOSER}`, FOLD_IDS), `produce#${SURVIVOR}`);
    assert.ok(!stepKeyTouches(`produce#${SURVIVOR}`, LOSER_IDS));
  });

  it("returns null on a malformed key rather than corrupting it", () => {
    assert.equal(ingredientIdFromStepKey("no-hash-here"), null);
    assert.equal(ingredientIdFromStepKey("trailing#"), null);
    assert.equal(rewriteStepKey("no-hash-here", FOLD_IDS), null);
  });
});

// ── carrier 5: PrepWeekStructure.structureJson ──────────────────────────────

describe("carrier: PrepWeekStructure.structureJson (NO FK — orphans silently)", () => {
  // The id is buried inside a stepKey string, several levels down, exactly as
  // assemblePrepWeekResult persists it.
  const structure = {
    phases: [
      {
        key: "produce",
        steps: [
          { number: 1, stepKey: `produce#${LOSER}`, title: "Dice", skipSuggested: true, contributesToMealIds: ["m1"] },
          { number: 2, stepKey: `produce#${UNRELATED}`, title: "Slice", contributesToMealIds: ["m2"] },
        ],
      },
      { key: "proteins", steps: [{ number: 3, stepKey: `proteins#${LOSER}`, title: "Trim", contributesToMealIds: ["m1"] }] },
    ],
  };

  it("DETECTS ids buried inside nested stepKey strings", () => {
    assert.equal(countStructureJsonHits(structure, LOSER_IDS), 2);
  });

  it("reports zero on a structure with no fold member", () => {
    assert.equal(countStructureJsonHits({ phases: [{ steps: [{ stepKey: `produce#${UNRELATED}` }] }] }, LOSER_IDS), 0);
    assert.equal(countStructureJsonHits(null, LOSER_IDS), 0);
  });

  it("rewrites every occurrence and preserves the rest of the blob exactly", () => {
    const out = rewriteStructureJson(structure, FOLD_IDS);
    assert.ok(out);
    assert.equal(out.hits, 2);
    const j = out.json as typeof structure;
    assert.equal(j.phases[0].steps[0].stepKey, `produce#${SURVIVOR}`);
    assert.equal(j.phases[0].steps[0].skipSuggested, true, "the narrator's demotion flag must survive");
    assert.deepEqual(j.phases[0].steps[1], structure.phases[0].steps[1]);
    assert.equal(j.phases[1].steps[0].stepKey, `proteins#${SURVIVOR}`);
    assert.equal(countStructureJsonHits(out.json, LOSER_IDS), 0);
  });

  it("returns null when the blob is clean", () => {
    assert.equal(rewriteStructureJson({ phases: [] }, FOLD_IDS), null);
  });
});

// ── name carrier: Dish.substitutions ────────────────────────────────────────

describe("carrier: Dish.substitutions (by NAME)", () => {
  const NAMES = new Set(["roma tomato"]);
  const BY_NAME = new Map([["roma tomato", "roma tomatoes"]]);
  const subs = [
    { product: "jarred marinara", quantity: 1, unit: "jar", replaces: ["Roma tomato", "garlic cloves"] },
    { product: "roma tomato", quantity: 2, unit: "each", replaces: ["something else"] },
  ];

  it("DETECTS loser names in both `replaces[]` and `product`", () => {
    assert.equal(countSubstitutionHits(subs, NAMES), 2);
  });

  it("matches case-insensitively on the trimmed value", () => {
    assert.equal(countSubstitutionHits([{ replaces: ["  ROMA TOMATO  "] }], NAMES), 1);
  });

  it("rewrites the names and leaves the validated shape otherwise intact", () => {
    const out = rewriteSubstitutions(subs, BY_NAME);
    assert.ok(out);
    assert.equal(out.hits, 2);
    const j = out.json as typeof subs;
    assert.deepEqual(j[0].replaces, ["roma tomatoes", "garlic cloves"]);
    assert.equal(j[0].product, "jarred marinara", "an unrelated product must not move");
    assert.equal(j[0].quantity, 1);
    assert.equal(j[0].unit, "jar");
    assert.equal(j[1].product, "roma tomatoes");
    assert.equal(countSubstitutionHits(out.json, NAMES), 0);
  });

  it("reports zero and rewrites nothing on a non-array blob", () => {
    assert.equal(countSubstitutionHits({ nope: true }, NAMES), 0);
    assert.equal(rewriteSubstitutions({ nope: true }, BY_NAME), null);
  });
});

// ── name carrier: MealPlanItem.recipeOverrideJson ───────────────────────────

describe("carrier: MealPlanItem.recipeOverrideJson (by NAME)", () => {
  const NAMES = new Set(["flour tortilla", "large egg"]);
  const DISPLAY = new Map([["flour tortilla", "Flour tortillas"], ["large egg", "Large eggs"]]);
  const override = {
    titleOverride: "My tacos",
    createdAt: "2026-08-01T00:00:00.000Z",
    dishes: [
      { name: "Tacos", ingredients: [{ name: "Flour tortilla", quantity: 8, unit: "each" }, { name: "cilantro", quantity: 1, unit: "bunch" }] },
      { name: "Side", ingredients: [{ name: "large egg", quantity: 2, unit: "each" }] },
    ],
  };

  it("DETECTS loser names nested under dishes[].ingredients[]", () => {
    assert.equal(countOverrideNameHits(override, NAMES), 2);
  });

  it("rewrites to the survivor's DISPLAY name and preserves quantity/unit", () => {
    const out = rewriteOverrideNames(override, DISPLAY);
    assert.ok(out);
    assert.equal(out.hits, 2);
    const j = out.json as typeof override;
    assert.equal(j.dishes[0].ingredients[0].name, "Flour tortillas");
    assert.equal(j.dishes[0].ingredients[0].quantity, 8);
    assert.equal(j.dishes[0].ingredients[0].unit, "each");
    assert.deepEqual(j.dishes[0].ingredients[1], override.dishes[0].ingredients[1]);
    assert.equal(j.titleOverride, "My tacos");
    assert.equal(countOverrideNameHits(out.json, NAMES), 0);
  });

  it("reports zero on a malformed override rather than throwing inside the gate", () => {
    assert.equal(countOverrideNameHits(null, NAMES), 0);
    assert.equal(countOverrideNameHits({ dishes: "nope" }, NAMES), 0);
  });
});

// ── name carrier: UserPreferences.recurringGroceryItems ─────────────────────

describe("carrier: UserPreferences.recurringGroceryItems (by NAME)", () => {
  const BY_NAME = new Map([["eggs", "egg"]]);

  it("rewrites the loser name and leaves the rest of the list alone", () => {
    const out = rewriteRecurringItems(["eggs", "milk", "bread"], BY_NAME);
    assert.ok(out);
    assert.equal(out.hits, 1);
    assert.deepEqual(out.items, ["egg", "milk", "bread"]);
  });

  it("preserves the user's capitalization — this list renders verbatim", () => {
    const out = rewriteRecurringItems(["Eggs", "Milk"], BY_NAME);
    assert.ok(out);
    assert.deepEqual(out.items, ["Egg", "Milk"]);
  });

  it("returns null when no item is a loser", () => {
    assert.equal(rewriteRecurringItems(["milk", "coffee"], BY_NAME), null);
  });
});
