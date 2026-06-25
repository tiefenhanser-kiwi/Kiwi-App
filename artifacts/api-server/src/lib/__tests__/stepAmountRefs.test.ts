// WS7-8b BUG-003 Block 1 — unit tests for the deterministic amount matcher.
// Pure function; no DB, no AI. Covers the three measured refinements, the
// by-design exclusions, and the genuine-miss case.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveAmountRefs, hasUnmatchedAmount, type MatcherIngredient } from "../stepAmountRefs";

// helper: build ingredient rows tersely
function ing(ingredientId: string, name: string, quantity: number, unit: string): MatcherIngredient {
  return { ingredientId, name, quantity, unit };
}

describe("deriveAmountRefs — clean single match", () => {
  it("links a span to the one ingredient whose name is to the right", () => {
    const ings = [ing("oil", "vegetable oil", 2, "tbsp"), ing("tort", "corn tortilla", 8, "each")];
    const text = "Brush 8 corn tortillas lightly with 2 tablespoons vegetable oil.";
    const { amountRefs, unmatchedAmount } = deriveAmountRefs(text, ings);
    assert.equal(unmatchedAmount, false);
    // both amounts resolve: "8" → corn tortilla, "2 tablespoons" → vegetable oil
    assert.equal(amountRefs.length, 2);
    const oilRef = amountRefs.find((r) => r.ingredientId === "oil");
    assert.ok(oilRef);
    assert.equal(oilRef.quantity, 2);
    assert.equal(oilRef.unit, "tablespoons");
    // charStart/charEnd cover the literal span
    assert.equal(text.slice(oilRef.charStart, oilRef.charEnd), "2 tablespoons");
  });
});

describe("refinement (a) — name-primary, quantity NOT required (partial/split)", () => {
  it("matches 'remaining ¾ cup salsa' to mild salsa even though total is 1.5 cup", () => {
    const ings = [ing("salsa", "mild salsa", 1.5, "cup")];
    const text = "Pour the remaining ¾ cup salsa over the stuffed shells.";
    const { amountRefs, unmatchedAmount } = deriveAmountRefs(text, ings);
    assert.equal(unmatchedAmount, false);
    assert.equal(amountRefs.length, 1);
    // CRITICAL: ref.quantity is the authored literal (0.75), NOT the 1.5 total
    assert.equal(amountRefs[0].quantity, 0.75);
    assert.equal(amountRefs[0].ingredientId, "salsa");
    assert.equal(amountRefs[0].unit, "cup");
  });
});

describe("refinement (b) — nearest-name-to-the-right for enumerated lists", () => {
  it("binds to the CLOSEST name, not the one with the most tokens", () => {
    // "1 pound" is adjacent to "ground beef" (1 token: beef) but "yellow onion"
    // (2 tokens) sits farther right — proximity must win over overlap count.
    const ings = [ing("beef", "ground beef", 1, "lb"), ing("onion", "yellow onion", 0.5, "each")];
    const text = "Add 1 pound ground beef and ½ diced yellow onion, and cook 6 minutes.";
    const { amountRefs } = deriveAmountRefs(text, ings);
    const byPos = [...amountRefs].sort((a, b) => a.charStart - b.charStart);
    assert.deepEqual(byPos.map((r) => r.ingredientId), ["beef", "onion"]);
    assert.equal(byPos[0].quantity, 1); // "1 pound" → ground beef
    assert.equal(byPos[1].quantity, 0.5); // "½" → yellow onion
  });

  it("splits '1 tsp cumin, 1 tsp chili powder' to the correct ingredient each", () => {
    const ings = [
      ing("cumin", "ground cumin", 1, "tsp"),
      ing("chili", "chili powder", 1, "tsp"),
      ing("salt", "kosher salt", 1, "tsp"),
    ];
    const text = "Season with 1 teaspoon ground cumin, 1 teaspoon chili powder, and 1 teaspoon kosher salt.";
    const { amountRefs, unmatchedAmount } = deriveAmountRefs(text, ings);
    assert.equal(unmatchedAmount, false);
    assert.equal(amountRefs.length, 3);
    // each amount binds to its OWN right-hand ingredient, not a tie
    const byPos = [...amountRefs].sort((a, b) => a.charStart - b.charStart);
    assert.deepEqual(byPos.map((r) => r.ingredientId), ["cumin", "chili", "salt"]);
  });
});

describe("refinement (c) — coalesce adjacent number tokens", () => {
  it("treats '1½ cups' as one span (value 1.5), not '1' + '½ cups'", () => {
    const ings = [ing("ched", "shredded cheddar cheese", 1.5, "cup")];
    const text = "Sprinkle 1½ cups shredded cheddar cheese on top.";
    const { amountRefs, unmatchedAmount } = deriveAmountRefs(text, ings);
    assert.equal(unmatchedAmount, false);
    assert.equal(amountRefs.length, 1);
    assert.equal(amountRefs[0].quantity, 1.5);
    assert.equal(text.slice(amountRefs[0].charStart, amountRefs[0].charEnd), "1½ cups");
  });
});

describe("by-design exclusions — no ref, never flags unmatched", () => {
  it("excludes temperatures ('375°F', 'preheat to 375')", () => {
    const ings = [ing("x", "ground beef", 1, "lb")];
    const r1 = deriveAmountRefs("Preheat the oven to 375°F.", ings);
    assert.equal(r1.amountRefs.length, 0);
    assert.equal(r1.unmatchedAmount, false);
    const r2 = deriveAmountRefs("Preheat to 375 and grease a pan.", ings);
    assert.equal(r2.unmatchedAmount, false);
  });

  it("excludes times ('10 minutes', hyphenated '12-minute mark')", () => {
    const ings = [ing("x", "ground beef", 1, "lb")];
    const r1 = deriveAmountRefs("Simmer for 10 minutes, stirring once.", ings);
    assert.equal(r1.amountRefs.length, 0);
    assert.equal(r1.unmatchedAmount, false);
    const r2 = deriveAmountRefs("Flip the packs once at the 12-minute mark.", ings);
    assert.equal(r2.amountRefs.length, 0);
    assert.equal(r2.unmatchedAmount, false);
  });

  it("excludes structural dims/counts ('9×13-inch', '1/4-inch', '3 wedges')", () => {
    const ings = [ing("x", "ground beef", 1, "lb")];
    const r1 = deriveAmountRefs("Lightly grease a 9×13-inch baking dish.", ings);
    assert.equal(r1.amountRefs.length, 0);
    assert.equal(r1.unmatchedAmount, false);
    const r2 = deriveAmountRefs("Press to about 1/4-inch thick, then slice into 3 wedges.", ings);
    assert.equal(r2.amountRefs.length, 0);
    assert.equal(r2.unmatchedAmount, false);
  });

  it("does NOT false-fire the signal on a pure by-design step", () => {
    const ings = [ing("x", "ground beef", 1, "lb")];
    const { unmatchedAmount } = deriveAmountRefs("Preheat to 375°F and bake for 25 minutes.", ings);
    assert.equal(unmatchedAmount, false);
  });
});

describe("detector hardening (d) — bare 'g' does not match 'garlic'", () => {
  it("reads '3 garlic cloves' as a garlic amount, not 3 grams", () => {
    const ings = [ing("garlic", "garlic", 3, "clove")];
    const { amountRefs, unmatchedAmount } = deriveAmountRefs("Mince 3 garlic cloves and set aside.", ings);
    assert.equal(unmatchedAmount, false);
    assert.equal(amountRefs.length, 1);
    assert.equal(amountRefs[0].ingredientId, "garlic");
    assert.equal(amountRefs[0].quantity, 3);
    // the matched span is "3" (no spurious "g" unit pulled from "garlic")
    assert.equal(amountRefs[0].unit, "");
  });
});

describe("genuine miss — ingredient named in text but absent from the rows", () => {
  it("flags unmatched and emits NO ref for '1 tablespoon olive oil' when no oil row exists", () => {
    const ings = [
      ing("beef", "lean ground beef", 1.25, "lb"),
      ing("cumin", "ground cumin", 1, "tsp"),
    ];
    const text = "Heat 1 tablespoon olive oil in a large skillet.";
    const { amountRefs, unmatchedAmount } = deriveAmountRefs(text, ings);
    assert.equal(unmatchedAmount, true);
    // must NOT mis-bind to cumin (also 1 unit) — name evidence says "olive oil"
    assert.equal(amountRefs.length, 0);
  });
});

describe("mixed step — matched amounts still ref while an unmatched one flags", () => {
  it("emits a ref for the matched ingredient AND sets the flag for the miss", () => {
    const ings = [ing("beef", "ground beef", 1, "lb")];
    const text = "Add 1 pound ground beef, then 1 tablespoon olive oil.";
    const { amountRefs, unmatchedAmount } = deriveAmountRefs(text, ings);
    assert.equal(amountRefs.length, 1);
    assert.equal(amountRefs[0].ingredientId, "beef");
    assert.equal(unmatchedAmount, true);
  });
});

describe("legacy / empty cases", () => {
  it("returns empty refs and no flag when the step has no amounts", () => {
    const ings = [ing("beef", "ground beef", 1, "lb")];
    const { amountRefs, unmatchedAmount } = deriveAmountRefs("Stir until well combined.", ings);
    assert.deepEqual(amountRefs, []);
    assert.equal(unmatchedAmount, false);
  });

  it("flags unmatched when there are no ingredient rows at all", () => {
    const { amountRefs, unmatchedAmount } = deriveAmountRefs("Add 2 cups flour.", []);
    assert.equal(amountRefs.length, 0);
    assert.equal(unmatchedAmount, true);
  });
});

describe("hasUnmatchedAmount — read-side signal derivation (D4)", () => {
  it("returns false for legacy steps (amountRefs null), regardless of text", () => {
    assert.equal(hasUnmatchedAmount("Add 1 tablespoon olive oil.", null), false);
    assert.equal(hasUnmatchedAmount("Add 2 cups flour and 3 eggs.", undefined), false);
  });

  it("returns false when every non-by-design amount is covered by a ref", () => {
    // "Spread ¾ cup salsa" with a ref covering the "¾ cup" span [7,12]
    const refs = [{ ingredientId: "salsa", quantity: 0.75, unit: "cup", charStart: 7, charEnd: 12 }];
    assert.equal(hasUnmatchedAmount("Spread ¾ cup salsa over the base.", refs), false);
  });

  it("returns false for a wired step with only by-design numbers ([] refs)", () => {
    assert.equal(hasUnmatchedAmount("Preheat to 375°F and bake 25 minutes in a 9×13 pan.", []), false);
  });

  it("returns true when a real ingredient amount has no covering ref ([] refs)", () => {
    // "1 tablespoon" is a real ingredient amount with no ref → signal fires
    assert.equal(hasUnmatchedAmount("Heat 1 tablespoon olive oil.", []), true);
  });

  it("returns true when one amount is covered but another is not", () => {
    // ref covers "1 pound" [4,11]; "1 tablespoon" [21,33] is uncovered
    const refs = [{ ingredientId: "beef", quantity: 1, unit: "pound", charStart: 4, charEnd: 11 }];
    assert.equal(hasUnmatchedAmount("Add 1 pound beef, then 1 tablespoon oil.", refs), true);
  });
});
