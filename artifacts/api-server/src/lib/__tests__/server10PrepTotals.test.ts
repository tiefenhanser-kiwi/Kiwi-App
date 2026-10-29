// SERVER-10 D (BUG-614) — a prep step's opening total follows the recipes.
//
// h4 (night run 2026-10-29, 3 people, every dish authored for 4, so x0.75):
// cilantro is ¼ cup in each of two pico de gallos and 2 tbsp in a guacamole, so
// 3 tbsp + 3 tbsp + 1½ tbsp = 7½ tbsp, about ½ cup. Each 3 tbsp share SHOWS as
// "¼ cup" (0.1875 cup is a tie between ⅛ and ¼, and ties go up), and the opening
// summed the shown lines and rounded again: "Chop ⅔ cup". A measure is now summed
// as the recipes state it and rounded once; a count still sums its shown lines
// (THX-3, BUG-444: "Mince 12 cloves" over 5 + 4 + 3).
//
// BUG-608 (parsley, the same household) is NOT this: the step's lines are
// 1½ + ¾ + 1½ + 2¼ tbsp = 6 tbsp, which is the recipes' own total (garnish lines
// included, as the grocery list includes them). The night run's R4 keys the need
// by food words, so "fresh parsley" and "fresh flat-leaf parsley" are two foods
// and the one opening was charged to each. That is the reconciler's to fix.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { componentTotals, renderPortionLines } from "../prepWeekAssembly";

const share = (qty: number, unit: string, forDish: string) => ({
  amount: `${qty} ${unit}`, forDish, dishRole: "main" as const, destination: `${forDish} bowl`, qty, unit,
});

describe("SERVER-10 D (BUG-614) — a measured total is the recipes' sum, rounded once", () => {
  const cilantro = {
    ingredientName: "fresh cilantro",
    preparationNote: "chopped",
    measures: [share(0.1875, "cup", "Pico (tacos)"), share(0.1875, "cup", "Pico (nachos)"), share(1.5, "tbsp", "Guacamole")],
  };

  it("h4's cilantro opens on ½ cup, not ⅔", () => {
    assert.deepEqual(componentTotals([cilantro]).get("fresh cilantro"), ["½ cup"]);
    const r = renderPortionLines({ components: [cilantro] }, new Map())!;
    assert.equal(r.meta.total, "½ cup");
  });

  it("spoons sum raw too: 1½ + ¾ + 1½ + 2¼ tbsp parsley is 6 tbsp", () => {
    const parsley = {
      ingredientName: "fresh parsley",
      measures: [share(1.5, "tbsp", "a"), share(0.75, "tbsp", "b"), share(1.5, "tbsp", "c"), share(2.25, "tbsp", "d")],
    };
    assert.deepEqual(componentTotals([parsley]).get("fresh parsley"), ["6 tbsp"]);
  });

  it("pounds: three 0.4 lb shares (each shown ½ lb) total 1¼ lb, not 1½", () => {
    const beef = { ingredientName: "flank steak", measures: [share(0.4, "lb", "a"), share(0.4, "lb", "b"), share(0.4, "lb", "c")] };
    assert.deepEqual(componentTotals([beef]).get("flank steak"), ["1¼ lb"]);
  });

  it("a count still sums what each line shows: 4.8 + 3.2 + 2.4 cloves is 5 + 4 + 3 = 12", () => {
    const garlic = { ingredientName: "garlic cloves", measures: [share(4.8, "cloves", "a"), share(3.2, "cloves", "b"), share(2.4, "cloves", "c")] };
    assert.deepEqual(componentTotals([garlic]).get("garlic cloves"), ["12 cloves"]);
  });
});
