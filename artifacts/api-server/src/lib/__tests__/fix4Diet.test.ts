// FIX-4 — the diet as a code check on generated plans (Part A), and what the
// Pick shelf reads from Tell Kiwi's text (Part B). Pure pieces only; the route
// wiring is pinned in routes/__tests__/wizardShelf.test.ts and wizard.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { WizardPlanCandidate } from "../ai/schemas/wizard";
import { generatedMealFitsDiets } from "../similar/diet";
import { dietGuardPool, enforceDietOnCandidate, type DietGuardContext } from "../wizardDietGuard";
import { foodDescriptors, ingredientPhrasesFor } from "../store/textMatch";
import { resolveEatingStyles } from "../wizardPreferences";

describe("generatedMealFitsDiets — a title before it has ingredients", () => {
  it("a meat or fish title fails vegetarian; a fish title passes pescatarian", () => {
    assert.equal(generatedMealFitsDiets("Chicken Tikka Masala", null, ["vegetarian"]), false);
    assert.equal(generatedMealFitsDiets("Miso-Glazed Salmon with Rice", null, ["vegetarian"]), false);
    assert.equal(generatedMealFitsDiets("Miso-Glazed Salmon with Rice", null, ["pescatarian"]), true);
    assert.equal(generatedMealFitsDiets("Beef and Vegetable Ramen", null, ["pescatarian"]), false);
  });

  it("a plant word beside an animal word does not excuse it (the line reader's NOT_ANIMAL)", () => {
    assert.equal(generatedMealFitsDiets("Tofu and Shrimp Pad Thai", null, ["vegetarian"]), false);
    assert.equal(generatedMealFitsDiets("Eggplant Parmesan with Italian Sausage", null, ["vegetarian"]), false);
  });

  it("reads the description too, and leaves real vegetarian dinners alone", () => {
    assert.equal(generatedMealFitsDiets("Weeknight Ramen", "Rich pork broth and soft eggs.", ["vegetarian"]), false);
    for (const t of ["Black Bean Tacos with Cotija", "Mushroom Stroganoff over Egg Noodles", "Cauliflower Steaks with Chimichurri", "Chickpea Tikka Masala"]) {
      assert.equal(generatedMealFitsDiets(t, "A hearty meatless dinner.", ["vegetarian"]), true, t);
    }
  });

  it("no restriction → always fits", () => {
    assert.equal(generatedMealFitsDiets("Ribeye with Butter", null, []), true);
  });
});

const cand = (over: Partial<WizardPlanCandidate> = {}): WizardPlanCandidate => ({
  id: "c1",
  title: "Plan",
  tags: [],
  mealTitles: ["Lentil Soup", "Chicken Parmesan", "Veggie Lasagna"],
  mealDescriptions: ["", "Crispy chicken under marinara.", ""],
  whyBullets: ["One"],
  dailyMacros: { calories: 500, proteinG: 25, carbsG: 50, fatG: 20 },
  storeSlots: [
    { slotIndex: 0, storeMealId: "veg-1" },
    { slotIndex: 2, storeMealId: "veg-2" },
  ],
  ...over,
});
const ctx = (over: Partial<DietGuardContext> = {}): DietGuardContext => ({
  diets: ["vegetarian"],
  fittingIds: new Set(["veg-1", "veg-2", "veg-3", "veg-4"]),
  pool: [
    { id: "veg-1", title: "Lentil Soup" },
    { id: "veg-2", title: "Veggie Lasagna" },
    { id: "veg-3", title: "Black Bean Enchiladas" },
    { id: "veg-4", title: "Paneer Tikka" },
  ],
  used: new Set(),
  ...over,
});

describe("enforceDietOnCandidate — replace from the shelf, or drop", () => {
  it("a live meat slot is replaced by an unused fitting shelf meal, as a store slot with an empty description", () => {
    const c = ctx();
    const r = enforceDietOnCandidate(cand(), c);
    assert.deepEqual(r.violations, ["Chicken Parmesan"]);
    assert.equal(r.replaced, 1);
    assert.ok(r.candidate);
    assert.deepEqual(r.candidate!.mealTitles, ["Lentil Soup", "Black Bean Enchiladas", "Veggie Lasagna"]);
    assert.equal(r.candidate!.mealDescriptions![1], "");
    assert.deepEqual(r.candidate!.storeSlots, [
      { slotIndex: 0, storeMealId: "veg-1" },
      { slotIndex: 1, storeMealId: "veg-3" },
      { slotIndex: 2, storeMealId: "veg-2" },
    ]);
    assert.deepEqual([...c.used].sort(), ["veg-1", "veg-2", "veg-3"]);
  });

  it("a shelf slot whose meal is not in the fitting set is a violation too (independent of the shelf filter)", () => {
    const r = enforceDietOnCandidate(
      cand({ mealTitles: ["Lentil Soup", "Sunday Gravy", "Veggie Lasagna"], mealDescriptions: undefined, storeSlots: [{ slotIndex: 0, storeMealId: "veg-1" }, { slotIndex: 1, storeMealId: "meat-9" }, { slotIndex: 2, storeMealId: "veg-2" }] }),
      ctx(),
    );
    assert.deepEqual(r.violations, ["Sunday Gravy"]);
    assert.equal(r.candidate!.storeSlots!.find((s) => s.slotIndex === 1)!.storeMealId, "veg-3");
  });

  it("a replacement never repeats a meal another card of the response holds", () => {
    const c = ctx({ used: new Set(["veg-3"]) });
    const r = enforceDietOnCandidate(cand(), c);
    assert.equal(r.candidate!.mealTitles[1], "Paneer Tikka");
  });

  it("no unused fitting meal left → the candidate is DROPPED, never shipped with the violation", () => {
    const c = ctx({ pool: [{ id: "veg-1", title: "Lentil Soup" }, { id: "veg-2", title: "Veggie Lasagna" }] });
    const r = enforceDietOnCandidate(cand(), c);
    assert.equal(r.candidate, null);
    assert.equal(c.used.size, 0, "a dropped candidate claims nothing");
  });

  it("a fitting candidate passes untouched; no diet → untouched", () => {
    const ok = cand({ mealTitles: ["Lentil Soup", "Chickpea Curry", "Veggie Lasagna"], mealDescriptions: ["", "Warm and spiced.", ""] });
    assert.equal(enforceDietOnCandidate(ok, ctx()).candidate, ok);
    const meat = cand();
    assert.equal(enforceDietOnCandidate(meat, ctx({ diets: [] })).candidate, meat);
  });

  it("dietGuardPool maps the shelf's aliases to real ids in shelf order", () => {
    const pool = dietGuardPool({
      forPrompt: [{ id: "m1", title: "A" }, { id: "p1", title: "B" }, { id: "zz", title: "orphan" }],
      aliasToId: new Map([["m1", "real-a"], ["p1", "real-b"]]),
    });
    assert.deepEqual(pool, [{ id: "real-a", title: "A" }, { id: "real-b", title: "B" }]);
  });
});

describe("resolveEatingStyles — the BUG-201 contract for the diet", () => {
  const prisma = (stored: string[] | null) => ({
    userPreferences: { findUnique: async () => (stored ? { eatingStyles: stored } : null) },
  });
  it("omitted → stored; present (even empty) → the body; no row → []", async () => {
    assert.deepEqual(await resolveEatingStyles(prisma(["Vegetarian"]) as never, "u", undefined), ["Vegetarian"]);
    assert.deepEqual(await resolveEatingStyles(prisma(["Vegetarian"]) as never, "u", []), []);
    assert.deepEqual(await resolveEatingStyles(prisma(["Vegetarian"]) as never, "u", ["Pescatarian"]), ["Pescatarian"]);
    assert.deepEqual(await resolveEatingStyles(prisma(null) as never, "u", undefined), []);
  });
});

describe("textMatch — what the Pick shelf reads from the text", () => {
  it("food descriptors are kept; mood and constraint words are not", () => {
    assert.deepEqual(foodDescriptors(["easy", "Whipped Cream", "healthy", "salmon", "whipped cream", "medium-rare"]), ["whipped cream", "salmon"]);
  });
  it("a named meal is tried longest-first, never below two words", () => {
    assert.deepEqual(ingredientPhrasesFor("NY Strip Steak"), ["ny strip steak", "strip steak"]);
    assert.deepEqual(ingredientPhrasesFor("Chicken Tikka"), ["chicken tikka"]);
    assert.deepEqual(ingredientPhrasesFor("Steak"), []);
  });
});

describe("enforceDietOnCandidate — FIX-4 (B) 'another' never repeats a shown meal", () => {
  it("a slot carrying a shown title is replaced by an unshown shelf meal, with no diet at all", () => {
    const c = ctx({ diets: [], avoidTitles: new Set(["lentil soup", "black bean enchiladas"]) });
    const r = enforceDietOnCandidate(cand({ mealTitles: ["Lentil Soup", "Chicken Parmesan", "Veggie Lasagna"] }), c);
    assert.deepEqual(r.violations, ["Lentil Soup"]);
    assert.equal(r.candidate!.mealTitles[0], "Paneer Tikka", "Black Bean Enchiladas was shown too");
    assert.equal(r.candidate!.mealTitles[1], "Chicken Parmesan", "no diet → meat stays");
  });
  it("nothing unshown left → dropped (the client says it is out of new plans)", () => {
    const c = ctx({ diets: [], avoidTitles: new Set(["lentil soup", "black bean enchiladas", "paneer tikka", "veggie lasagna"]) });
    assert.equal(enforceDietOnCandidate(cand({ mealTitles: ["Lentil Soup", "Chickpea Curry", "Rice"] }), c).candidate, null);
  });
});
