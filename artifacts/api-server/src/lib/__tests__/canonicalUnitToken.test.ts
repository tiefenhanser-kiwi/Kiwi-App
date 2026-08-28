// WS9 BUG-174 — canonical unit token.
//
// ⚠️ EVERY expectation below is an EXPLICIT LITERAL. Nothing here loops over
// VOLUME_UNIT_TO_CUPS / WEIGHT_UNIT_TO_GRAMS, because an assertion that reads
// the same map the code reads pins nothing: mutate the map and both sides move
// together and the test stays green. The alias→canonical pairs are written out
// by hand from the unit spellings the live data actually carries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalUnitToken,
  convertToGrams,
  gramsToUnit,
  isCountUnit,
} from "../ingredientConversions";
import { bucketKeyOf } from "../groceryList";

// Hand-written. alias → the token it must fold to.
const ALIAS_TO_CANONICAL: [string, string][] = [
  // volume — teaspoon family
  ["tsp", "tsp"], ["tsps", "tsp"], ["teaspoon", "tsp"], ["teaspoons", "tsp"],
  // volume — tablespoon family
  ["tbsp", "tbsp"], ["tbsps", "tbsp"], ["tablespoon", "tbsp"], ["tablespoons", "tbsp"],
  // volume — cup family
  ["cup", "cup"], ["cups", "cup"],
  // volume — fluid ounce family
  ["fl oz", "fl oz"], ["fluid ounce", "fl oz"], ["fluid ounces", "fl oz"],
  // volume — larger measures
  ["pint", "pint"], ["pints", "pint"],
  ["quart", "quart"], ["quarts", "quart"],
  ["gallon", "gallon"], ["gallons", "gallon"],
  // volume — metric
  ["ml", "ml"], ["milliliter", "ml"], ["milliliters", "ml"],
  ["l", "l"], ["liter", "l"], ["liters", "l"],
  // weight
  ["oz", "oz"], ["ounce", "oz"], ["ounces", "oz"],
  ["lb", "lb"], ["lbs", "lb"], ["pound", "lb"], ["pounds", "lb"],
  ["g", "g"], ["gram", "g"], ["grams", "g"],
  ["kg", "kg"], ["kilogram", "kg"], ["kilograms", "kg"],
];

// Pairs that must NEVER collapse. Same dimension, different magnitude, plus the
// cross-dimension trap (`oz` is weight, `fl oz` is volume).
const MUST_STAY_DISTINCT: [string, string][] = [
  ["tsp", "tbsp"],
  ["tbsp", "cup"],
  ["tsp", "cup"],
  ["oz", "lb"],
  ["g", "kg"],
  ["ml", "l"],
  ["pint", "quart"],
  ["oz", "fl oz"],
  ["cup", "pint"],
];

describe("canonicalUnitToken — spelling families fold, magnitudes do not", () => {
  it("folds every listed alias to its written-out canonical", () => {
    for (const [alias, canonical] of ALIAS_TO_CANONICAL) {
      assert.equal(
        canonicalUnitToken(alias),
        canonical,
        `${alias} should fold to ${canonical}`,
      );
    }
  });

  it("keeps genuinely different units apart", () => {
    for (const [a, b] of MUST_STAY_DISTINCT) {
      assert.notEqual(
        canonicalUnitToken(a),
        canonicalUnitToken(b),
        `${a} and ${b} are different units and must not share a token`,
      );
    }
  });

  it("is idempotent — the canonical of a canonical is itself", () => {
    for (const [, canonical] of ALIAS_TO_CANONICAL) {
      assert.equal(canonicalUnitToken(canonical), canonical);
    }
  });

  it("trims and lowercases before folding", () => {
    assert.equal(canonicalUnitToken("  TEASPOON "), "tsp");
    assert.equal(canonicalUnitToken("Tbsp"), "tbsp");
    assert.equal(canonicalUnitToken("POUNDS"), "lb");
  });

  it("leaves a unit it carries no factor for exactly as it found it", () => {
    // Identity fallback. An unknown unit buckets alone rather than being
    // force-merged with something it may not be.
    for (const u of ["bunch", "pinch", "sprig", "head", "dozen", "pod", "jar"]) {
      assert.equal(canonicalUnitToken(u), u);
    }
  });

  it("does NOT fold the count set — each is untouched (documented scope)", () => {
    // COUNT_UNITS is a set with no factor, so it proves no equivalence. This is
    // a deliberate boundary, pinned so a later change to it is a decision and
    // not a slip.
    assert.equal(isCountUnit("each"), true);
    assert.equal(isCountUnit("piece"), true);
    assert.equal(canonicalUnitToken("each"), "each");
    assert.equal(canonicalUnitToken("piece"), "piece");
    assert.notEqual(canonicalUnitToken("piece"), canonicalUnitToken("each"));
  });

  it("does NOT fold sub-unit child spellings — clove/cloves stay apart", () => {
    // KNOWN GAP, deliberate: neither spelling is in a factor table, so this
    // fold is out of reach without adding alias data. BUG-137's garlic case is
    // NOT closed by BUG-174.
    assert.equal(canonicalUnitToken("clove"), "clove");
    assert.equal(canonicalUnitToken("cloves"), "cloves");
    assert.notEqual(canonicalUnitToken("clove"), canonicalUnitToken("cloves"));
  });
});

// ── the invariant: a fold must never change what a unit MEANS ───────────────
//
// This is the guard against an alias electing the wrong canonical, and against
// two canonicals colliding. It is expressed through convertToGrams/gramsToUnit
// — the arithmetic the rest of the module actually performs — rather than by
// reading the factor tables, so it stays independent of the map under test.
describe("canonicalUnitToken — invariant: folding preserves the factor", () => {
  // A density high enough that a wrong fold shows as a big number, low enough
  // to stay exact in floating point. Explicit literal, not read from anywhere.
  const CONV = { gramsPerCup: 240, gramsPerEach: 100, source: "curated" as const };

  it("an alias and its canonical convert 1 unit to the same grams", () => {
    for (const [alias, canonical] of ALIAS_TO_CANONICAL) {
      const a = convertToGrams(1, alias, CONV);
      const c = convertToGrams(1, canonical, CONV);
      assert.notEqual(a, null, `${alias} must be convertible`);
      assert.equal(a, c, `${alias} and its canonical ${canonical} must weigh the same`);
    }
  });

  it("two units that fold to DIFFERENT tokens never weigh the same", () => {
    for (const [a, b] of MUST_STAY_DISTINCT) {
      const ga = convertToGrams(1, a, CONV);
      const gb = convertToGrams(1, b, CONV);
      assert.notEqual(ga, null);
      assert.notEqual(gb, null);
      assert.notEqual(ga, gb, `${a} and ${b} must not weigh the same`);
    }
  });

  it("round-trips: grams to canonical and back is the identity", () => {
    for (const [, canonical] of ALIAS_TO_CANONICAL) {
      const qty = gramsToUnit(480, canonical, CONV);
      assert.notEqual(qty, null);
      const back = convertToGrams(qty as number, canonical, CONV);
      assert.ok(Math.abs((back as number) - 480) < 1e-9, `${canonical} round-trip`);
    }
  });
});

// ── the bucket key ─────────────────────────────────────────────────────────
describe("bucketKeyOf — BUG-174", () => {
  it("gives one key to two spellings of one unit", () => {
    assert.equal(
      bucketKeyOf("black pepper", "teaspoon"),
      bucketKeyOf("black pepper", "tsp"),
    );
    assert.equal(
      bucketKeyOf("Whole Milk", "cups"),
      bucketKeyOf("whole milk", "cup"),
    );
  });

  it("gives two keys to two genuinely different units", () => {
    assert.notEqual(
      bucketKeyOf("kosher salt", "tablespoon"),
      bucketKeyOf("kosher salt", "teaspoon"),
    );
    assert.notEqual(bucketKeyOf("salt", "pinch"), bucketKeyOf("salt", "tsp"));
  });

  it("still separates two different ingredients in one unit", () => {
    assert.notEqual(bucketKeyOf("kosher salt", "tsp"), bucketKeyOf("sea salt", "tsp"));
  });

  it("renders the canonical token, written out as a literal", () => {
    // Explicit expected strings — nothing recomputed from the row's own fields.
    assert.equal(bucketKeyOf("black pepper", "teaspoons"), "black pepper|tsp");
    assert.equal(bucketKeyOf("parmesan", "ounces"), "parmesan|oz");
    assert.equal(bucketKeyOf("bananas", "bunch"), "bananas|bunch");
    assert.equal(bucketKeyOf("paper towels", "each"), "paper towels|each");
  });
});
