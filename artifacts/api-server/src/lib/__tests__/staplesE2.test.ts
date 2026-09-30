// D-WS9-295 (E2) — sugar, salt and cornstarch as staples, and the escape class
// that made `1 bottle (51 oz) vegetable oil` appear on some lists and not others.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UNIVERSAL_STAPLES,
  isUniversalStapleName,
} from "../groceryStaples";
import { lookupPurchaseDefault } from "../ingredientConversions";

describe("D-WS9-295 — the staples added by name", () => {
  it("🔴 sugar is a staple, so it states the need and shows no pack", () => {
    // Five of the six worst rows on the F8 over-buy list were sugar:
    // "1 bag (4 lb) granulated sugar (1 teaspoon)" is 435x the need.
    for (const n of [
      "granulated sugar",
      "white sugar",
      "brown sugar",
      "dark brown sugar",
      "light brown sugar",
    ]) {
      assert.equal(isUniversalStapleName(n), true, n);
    }
  });

  it("🔴 the two salts D-WS9-295 names, and no others", () => {
    assert.equal(isUniversalStapleName("fine sea salt"), true);
    assert.equal(isUniversalStapleName("coarse kosher salt"), true);
    // ⚠️ BUG-182's exclusions survive. `flaky sea salt` is the row Hans added by
    // hand precisely because he does not own it; a finishing salt is bought for
    // a dish, a cooking salt is in the cupboard.
    for (const n of ["flaky sea salt", "flaky salt", "sea salt", "fine salt", "table salt", "coarse sea salt"]) {
      assert.equal(isUniversalStapleName(n), false, `${n} must NOT be a staple`);
    }
  });

  it("cornstarch is a staple", () => {
    assert.equal(isUniversalStapleName("cornstarch"), true);
  });

  it("the sugars that are a DISH's ingredient, not a cupboard's, stay out", () => {
    for (const n of ["powdered sugar", "palm sugar", "rock sugar"]) {
      assert.equal(isUniversalStapleName(n), false, n);
    }
  });
});

describe("🔴 D-WS9-295 — the staple test reads BOTH names the catalog carries", () => {
  it("the vegetable-oil escape: canonical `neutral oil`, display `vegetable oil`", () => {
    // Hans asked why `1 bottle (51 oz) vegetable oil` shows a pack. The flag
    // varied PER PLAN for one food: the catalog's canonical name is
    // `neutral oil`, which is not in the list, and a plan that happened to carry
    // a second `vegetable oil` row merged the two and OR-ed the flag true
    // (groceryMerge.foldMetadata). Nothing about the food decided it.
    assert.equal(isUniversalStapleName("neutral oil"), false, "canonical alone is not enough");
    assert.equal(isUniversalStapleName("neutral oil", "vegetable oil"), true);
    // All 16 catalog spellings of it, by shape.
    for (const c of [
      "neutral cooking oil",
      "neutral vegetable oil",
      "neutral oil (such as canola)",
      "neutral oil (for frying)",
      "neutral oil for frying",
    ]) {
      assert.equal(isUniversalStapleName(c, "vegetable oil"), true, c);
    }
  });

  it("🔴 it is NOT the BUG-182 fold — no inference, only the row's own names", () => {
    // The fold BUG-182 removed ran a name through a VARIANT MAP: "a flaky sea
    // salt is a salt". This reads the row's own authored displayName. So a row
    // whose display name is itself a variant still stays out.
    assert.equal(isUniversalStapleName("flaky sea salt", "flaky sea salt"), false);
    // And a name that merely CONTAINS a staple is untouched in both slots.
    assert.equal(isUniversalStapleName("lard or neutral oil", "lard or vegetable oil"), false);
    assert.equal(isUniversalStapleName("garlic salt", "garlic salt"), false);
    assert.equal(isUniversalStapleName("salted butter", "salted butter"), false);
  });

  it("a missing display name is simply the canonical test, as before", () => {
    assert.equal(isUniversalStapleName("kosher salt"), true);
    assert.equal(isUniversalStapleName("kosher salt", null), true);
    assert.equal(isUniversalStapleName("neutral oil", null), false);
  });

  it("every listed name is distinct — a duplicate would be a silent no-op", () => {
    const names = UNIVERSAL_STAPLES.map((s) => s.canonicalName);
    assert.equal(new Set(names).size, names.length);
  });
});

// ── 🔴 D-WS9-295 (E3) — THE TWO MILK PACKS, AND THAT THEY CANNOT COLLIDE ────
describe("D-WS9-295 — recipe milk is a quart, recurring milk is a gallon", () => {
  it("🔴 the RECURRING default is a gallon and stays one", () => {
    // D-WS9-284 ruling 3, Hans: "we usually get a gallon of milk". This entry is
    // read ONLY by the recurring resolution — no recipe row can reach it (there
    // is no catalog row named `milk`; `milk` is an alias on `whole milk`, which
    // lookupIngredientsByName resolves before the upsert is considered).
    // Part E break (4) changes it to a quart and this goes red.
    const rec = lookupPurchaseDefault("milk");
    assert.deepEqual(rec, {
      purchaseUnit: "gallon",
      purchaseQuantity: 1,
      purchaseDisplay: "1 gallon",
    });
  });

  it("the recipe pack is a DIFFERENT table, so the two cannot collide", () => {
    // The recipe side is `Ingredient.purchaseDisplay` on the `whole milk` row —
    // "1 bottle (1 quart / 32 oz)", already the ruled size before Part E — and
    // this code table is consulted only on the recurring branch. Two tables, two
    // branches; neither reads the other.
    assert.equal(lookupPurchaseDefault("whole milk"), null);
  });
});
