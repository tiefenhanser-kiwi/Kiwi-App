// WS7-8b Block B2 — ingredientConversions pure-helper tests.
// node:test; no DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  convertToGrams,
  gramsToUnit,
  lookupConversion,
  lookupPurchaseDefault,
  parseConversionRef,
  resolveConversion,
  scalePurchaseForSubUnit,
  isVolumeUnit,
  isWeightUnit,
  type IngredientConversion,
} from "../ingredientConversions";
import {
  applyDeriveDenylist,
  deriveConversionFromPortions,
  isDeriveDenied,
  usdaConversionUsable,
} from "../usda/portionConversions";
import type { FdcFood } from "../usda/fdcClient";

describe("ingredientConversions — lookups", () => {
  it("lookupConversion is case/whitespace-insensitive", () => {
    const a = lookupConversion("Parmesan");
    const b = lookupConversion("  parmesan ");
    assert.ok(a && b);
    assert.equal(a.gramsPerCup, 100);
    assert.equal(b.gramsPerCup, 100);
    assert.equal(a.source, "curated");
  });

  it("lookupPurchaseDefault returns purchase subset (back-compat)", () => {
    const p = lookupPurchaseDefault("chicken thighs");
    assert.deepEqual(p, {
      purchaseUnit: "lb",
      purchaseQuantity: 2,
      purchaseDisplay: "2 lb",
    });
  });

  it("lookupPurchaseDefault returns null for a density-only row (no pack)", () => {
    // flour is density-only — it must NOT masquerade as a purchasable pack.
    assert.equal(lookupPurchaseDefault("all-purpose flour"), null);
    // but its conversion still resolves.
    assert.equal(lookupConversion("all-purpose flour")?.gramsPerCup, 125);
  });

  it("garlic carries the head↔clove sub-unit equivalence (BUG-025-1)", () => {
    const g = lookupConversion("garlic");
    assert.ok(g?.subUnit);
    assert.equal(g.subUnit.parent, "head");
    assert.equal(g.subUnit.perParent, 10);
    assert.equal(g.purchaseDisplay, "1 head");
  });
});

describe("ingredientConversions — convertToGrams", () => {
  const parmesan = lookupConversion("parmesan")!; // gramsPerCup 100
  const onion = lookupConversion("yellow onion")!; // gramsPerEach 110

  it("weight units convert with no per-ingredient data", () => {
    assert.equal(convertToGrams(1, "oz", null), 28.349523125);
    assert.equal(convertToGrams(1, "lb", null), 453.59237);
    assert.equal(convertToGrams(100, "g", null), 100);
  });

  it("volume units need gramsPerCup", () => {
    // 0.5 cup parmesan × 100 g/cup = 50 g
    assert.equal(convertToGrams(0.5, "cup", parmesan), 50);
    // 3 tbsp = 3/16 cup × 100 = 18.75 g
    assert.ok(Math.abs(convertToGrams(3, "tbsp", parmesan)! - 18.75) < 1e-9);
    // no density → null (never fabricate)
    assert.equal(convertToGrams(1, "cup", null), null);
    assert.equal(convertToGrams(1, "cup", { source: "curated" }), null);
  });

  it("count units need gramsPerEach", () => {
    assert.equal(convertToGrams(2, "each", onion), 220);
    assert.equal(convertToGrams(1, "whole", onion), 110);
    assert.equal(convertToGrams(1, "each", parmesan), null); // no gramsPerEach
  });

  it("isVolumeUnit / isWeightUnit classify correctly", () => {
    assert.ok(isVolumeUnit("Cup"));
    assert.ok(isVolumeUnit("TBSP"));
    assert.ok(!isVolumeUnit("oz"));
    assert.ok(isWeightUnit("oz"));
    assert.ok(isWeightUnit("Pounds"));
    assert.ok(!isWeightUnit("cup"));
  });
});

describe("gramsToUnit (inverse of convertToGrams)", () => {
  const parmesan = lookupConversion("parmesan")!;
  it("round-trips weight and volume", () => {
    assert.ok(Math.abs(gramsToUnit(135.05, "oz", null)! - 4.7638) < 1e-3);
    assert.equal(gramsToUnit(100, "cup", parmesan), 1); // 100 g ÷ 100 g/cup
    assert.equal(gramsToUnit(50, "cup", parmesan), 0.5);
    assert.equal(gramsToUnit(100, "cup", null), null); // no density
  });
});

describe("scalePurchaseForSubUnit (head↔clove, BUG-025-1)", () => {
  const garlic = lookupConversion("garlic")!; // head=10 cloves, pack "1 head"
  it("30 cloves → 3 heads (the original symptom)", () => {
    assert.deepEqual(scalePurchaseForSubUnit(garlic, 30, "clove"), {
      purchaseQuantity: 3,
      purchaseDisplay: "3 heads",
    });
  });
  it("2 cloves → 1 head (don't buy 2 heads for 2 cloves)", () => {
    assert.deepEqual(scalePurchaseForSubUnit(garlic, 2, "clove"), {
      purchaseQuantity: 1,
      purchaseDisplay: "1 head",
    });
  });
  it("15 cloves → 2 heads (ceil across the ratio)", () => {
    assert.equal(scalePurchaseForSubUnit(garlic, 15, "clove")?.purchaseDisplay, "2 heads");
  });
  it("need already in heads → ceil heads", () => {
    assert.equal(scalePurchaseForSubUnit(garlic, 2.2, "head")?.purchaseDisplay, "3 heads");
  });
  it("null for ingredients without a subUnit", () => {
    assert.equal(scalePurchaseForSubUnit(lookupConversion("parmesan"), 5, "oz"), null);
  });
});

describe("ingredientConversions — parseConversionRef / resolveConversion", () => {
  it("rejects null / malformed / missing-source", () => {
    assert.equal(parseConversionRef(null), null);
    assert.equal(parseConversionRef(42), null);
    assert.equal(parseConversionRef({ gramsPerCup: 100 }), null); // no source
    assert.equal(parseConversionRef({ source: "bogus" }), null);
  });

  it("narrows a well-formed persisted ref", () => {
    const ref = parseConversionRef({
      gramsPerCup: 113,
      gramsPerEach: 0, // non-positive → dropped
      subUnit: { parent: "head", perParent: 12 },
      purchaseUnit: "block",
      purchaseQuantity: 1,
      purchaseDisplay: "1 block",
      source: "usda_derived",
      confidence: "medium",
    });
    assert.ok(ref);
    assert.equal(ref.gramsPerCup, 113);
    assert.equal(ref.gramsPerEach, undefined);
    assert.deepEqual(ref.subUnit, { parent: "head", perParent: 12 });
    assert.equal(ref.source, "usda_derived");
    assert.equal(ref.confidence, "medium");
  });

  it("resolveConversion prefers persisted ref over the code table", () => {
    const persisted = { gramsPerCup: 999, source: "ai_estimated" as const };
    const r = resolveConversion("parmesan", persisted);
    assert.equal(r?.gramsPerCup, 999); // persisted wins
    assert.equal(r?.source, "ai_estimated");
    // null persisted → code-table fallback
    const r2 = resolveConversion("parmesan", null);
    assert.equal(r2?.gramsPerCup, 100);
    assert.equal(r2?.source, "curated");
  });
});

// ── USDA foodPortions → conversion derivation ─────────────────────────────

function foodWithPortions(portions: FdcFood["foodPortions"]): FdcFood {
  return { fdcId: 1, description: "test", foodPortions: portions };
}

describe("deriveConversionFromPortions", () => {
  it("derives gramsPerCup from a cup portion", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([
        { amount: 1, gramWeight: 100, modifier: "cup, grated" },
      ]),
    );
    assert.equal(d.gramsPerCup, 100);
  });

  it("normalizes by amount (0.25 cup → per-cup)", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([{ amount: 0.25, gramWeight: 30, modifier: "cup" }]),
    );
    assert.equal(d.gramsPerCup, 120);
  });

  it("prefers 'medium' for gramsPerEach", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([
        { amount: 1, gramWeight: 150, portionDescription: "1 large" },
        { amount: 1, gramWeight: 110, portionDescription: "1 medium" },
        { amount: 1, gramWeight: 70, portionDescription: "1 small" },
      ]),
    );
    assert.equal(d.gramsPerEach, 110); // medium beats large/small
  });

  it("a cup portion never becomes gramsPerEach; a whole-item never a cup", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([
        { amount: 1, gramWeight: 240, modifier: "cup, chopped" },
        { amount: 1, gramWeight: 110, modifier: "medium" },
      ]),
    );
    assert.equal(d.gramsPerCup, 240);
    assert.equal(d.gramsPerEach, 110);
  });

  it("skips ambiguous portions (no cup, no whole-item descriptor)", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([
        { amount: 1, gramWeight: 15, modifier: "tbsp" },
        { amount: 1, gramWeight: 28, portionDescription: "1 oz" },
      ]),
    );
    assert.deepEqual(d, {});
  });

  it("ignores portions with no gramWeight", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([{ amount: 1, modifier: "cup" }]),
    );
    assert.deepEqual(d, {});
  });

  it("does not false-positive on compound words (cupcake / largely)", () => {
    const d = deriveConversionFromPortions(
      foodWithPortions([
        { amount: 1, gramWeight: 50, modifier: "cupcake" },
        { amount: 1, gramWeight: 60, portionDescription: "largely trimmed" },
      ]),
    );
    assert.deepEqual(d, {});
  });
});

describe("usdaConversionUsable (form-match guardrail)", () => {
  it("rejects form-mismatched foods observed in the live dry-run", () => {
    assert.equal(usdaConversionUsable("avocado", "Oil, avocado"), false);
    assert.equal(usdaConversionUsable("apples", "Croissants, apple"), false);
    assert.equal(usdaConversionUsable("black beans", "Soup, black bean, canned, condensed"), false);
    assert.equal(usdaConversionUsable("buttermilk", "Milk, buttermilk, dried"), false);
    assert.equal(usdaConversionUsable("carrot", "Carrot, dehydrated"), false);
  });

  it("accepts same-form foods", () => {
    assert.equal(usdaConversionUsable("asparagus", "Asparagus, raw"), true);
    assert.equal(usdaConversionUsable("blueberries", "Blueberries, raw"), true);
    assert.equal(usdaConversionUsable("apple cider vinegar", "Vinegar, cider"), true);
    assert.equal(usdaConversionUsable("broccoli floret", "Broccoli, flower clusters, raw"), true);
  });

  it("rejects empty/missing descriptions and empty names", () => {
    assert.equal(usdaConversionUsable("x", ""), false);
    assert.equal(usdaConversionUsable("x", null), false);
    assert.equal(usdaConversionUsable("", "Anything"), false);
  });
});

describe("applyDeriveDenylist (rulings A–D)", () => {
  it("A — wrong-food rows drop the whole derivation", () => {
    for (const name of ["chicken broth", "lime zest", "sweet potato", "frozen peas"]) {
      assert.deepEqual(
        applyDeriveDenylist(name, { gramsPerCup: 205, gramsPerEach: 67 }),
        {},
        `${name} should MISS`,
      );
      assert.equal(isDeriveDenied(name), true);
    }
  });

  it("B — cooked grains MISS (curated owns grains)", () => {
    for (const name of ["long grain white rice", "long-grain white rice", "quinoa", "wild rice"]) {
      assert.deepEqual(applyDeriveDenylist(name, { gramsPerCup: 158 }), {});
    }
  });

  it("C — flaky sea salt MISS", () => {
    assert.deepEqual(applyDeriveDenylist("flaky sea salt", { gramsPerCup: 292 }), {});
  });

  it("D — pearl onion drops each, KEEPS cup (field-level)", () => {
    assert.deepEqual(
      applyDeriveDenylist("pearl onion", { gramsPerCup: 160, gramsPerEach: 14 }),
      { gramsPerCup: 160 },
    );
    assert.equal(isDeriveDenied("pearl onion"), false); // not a whole-row miss
  });

  it("non-denylisted rows pass through untouched", () => {
    const d = { gramsPerCup: 101, gramsPerEach: 40 };
    assert.deepEqual(applyDeriveDenylist("celery", d), d);
    assert.equal(isDeriveDenied("celery"), false);
  });
});

// Type-only export touch so the import isn't flagged unused if tests trim.
const _typecheck: IngredientConversion | null = null;
void _typecheck;
