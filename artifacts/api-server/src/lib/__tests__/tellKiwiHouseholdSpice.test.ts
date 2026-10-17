// FIX-2 (Part D) — Tell Kiwi's "for two" and "nothing too spicy": the parse
// schema's two new fields and the heat-word filter (store/spice.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ParsedIntentSchema } from "../ai/schemas/tellKiwi";
import { HOT_WORDS, isTooSpicy, notTooSpicyWhere } from "../store/spice";

const base = { scenario: "vague", explicitMeals: [], intentDescriptors: [] };

describe("ParsedIntentSchema — householdSize and avoidSpicy", () => {
  it("carries a stated household and a spice avoidance", () => {
    const r = ParsedIntentSchema.parse({ ...base, householdSize: 2, avoidSpicy: true });
    assert.equal(r.householdSize, 2);
    assert.equal(r.avoidSpicy, true);
  });

  it("absent stays absent (the text named neither)", () => {
    const r = ParsedIntentSchema.parse(base);
    assert.equal(r.householdSize, undefined);
    assert.equal(r.avoidSpicy, undefined);
  });

  it("a bad household reads as 'not said' instead of failing the parse (BUG-099's lesson)", () => {
    for (const v of [null, 0, -1, 2.5, "2", 31]) {
      const r = ParsedIntentSchema.safeParse({ ...base, householdSize: v });
      assert.equal(r.success, true, `householdSize ${JSON.stringify(v)} must not fail the parse`);
      assert.equal(r.success && r.data.householdSize, undefined);
    }
  });

  it("only avoidSpicy: true means anything", () => {
    for (const v of [false, null, "yes", 1]) {
      const r = ParsedIntentSchema.safeParse({ ...base, avoidSpicy: v });
      assert.equal(r.success, true);
      assert.equal(r.success && r.data.avoidSpicy, undefined);
    }
  });
});

describe("isTooSpicy — the heat words", () => {
  it("catches the three TRIAGE-0 saw on a 'nothing too spicy' shelf", () => {
    for (const t of [
      "Spicy Arrabbiata Spaghetti and Meatballs",
      "Rigatoni Arrabbiata with Italian Sausage and Fresh Basil",
      "Kung Pao Chicken with Jasmine Rice",
      "Spicy Szechuan Beef and Broccoli",
    ]) {
      assert.equal(isTooSpicy(t), true, t);
    }
  });

  it("reads the description too", () => {
    assert.equal(isTooSpicy("Sausage and Kale Orecchiette", "a hearty pasta with spicy sausage"), true);
  });

  it("leaves moderate and mild dishes alone (a choice, not an accident)", () => {
    for (const t of [
      "Smoky Chipotle Chicken Burrito Bowl",
      "Cajun Baked Tilapia with Cilantro-Lime Rice",
      "Texas-Style Beef Chili",
      "Buttermilk Fried Chicken Tenders",
      "Hot Dogs with Coleslaw",
    ]) {
      assert.equal(isTooSpicy(t), false, t);
    }
  });

  it("notTooSpicyWhere excludes every word on title AND description, case-insensitively", () => {
    const w = notTooSpicyWhere() as { NOT: { OR: Array<Record<string, { contains: string; mode: string }>> } };
    assert.equal(w.NOT.OR.length, HOT_WORDS.length * 2);
    assert.ok(w.NOT.OR.every((o) => Object.values(o)[0].mode === "insensitive"));
    assert.ok(w.NOT.OR.some((o) => o.title?.contains === "kung pao"));
    assert.ok(w.NOT.OR.some((o) => o.description?.contains === "spicy"));
  });
});
