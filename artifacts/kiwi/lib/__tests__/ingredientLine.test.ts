// Row 13 "Test Kitchen" · Block 2b (BUG-315) — the shared ingredient line.
//
// The defect this pins was not a missing helper call. app/test-kitchen/recipe.tsx
// DID call formatQuantity(ing.quantity, ing.unit) — and formatQuantity is
// amount-only: it reads `unit` to pick the whole-unit ceiling rule and never
// emits it. Every unit on the guest recipe screen was therefore dropped, on a
// screen whose entire job is to demonstrate Kiwi's recipe quality. The member
// meal screen appended the unit itself, in JSX, so the two screens could not be
// compared by reading either one of them.
//
// Both screens now call formatIngredientLine, and the first test below is the
// browser-pass line, byte for byte.

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import { formatIngredientLine } from "../format/ingredientLine";
import { pluralizeNeedUnit, pluralizeUnitWord } from "../format/grocery";
import { displayedQuantity, formatQuantity } from "../format/quantity";

// The exact ingredient from the browser pass (GET /api/meals/c70a4986-… , a
// public batch_generated catalog meal).
const SHRIMP = {
  name: "large shrimp",
  quantity: 1.5,
  unit: "pound",
  preparationNote: "patted dry",
  category: "protein",
  isOptional: false,
};

test("🔴 BUG-315 — the unit is IN the line; the browser pass showed '1½ large shrimp'", () => {
  // What the member meal screen shows (no notes, no scaling) — and the string
  // the guest screen must agree with on its quantity+unit+name core.
  assert.equal(formatIngredientLine(SHRIMP), "1½ pounds large shrimp");
  // What the guest recipe screen shows: the same core, plus the prep note it
  // already carried before this fix.
  assert.equal(
    formatIngredientLine(SHRIMP, { includeNotes: true }),
    "1½ pounds large shrimp (patted dry)",
  );
  // The member string is a prefix of the guest string — the shared core.
  assert.ok(
    formatIngredientLine(SHRIMP, { includeNotes: true }).startsWith(
      formatIngredientLine(SHRIMP),
    ),
  );
  // And the bug itself: the unit word is present, not silently swallowed.
  assert.ok(formatIngredientLine(SHRIMP).includes("pound"));
});

test("the other two lines from the browser pass carry their units too", () => {
  assert.equal(
    formatIngredientLine({ name: "unsalted butter", quantity: 4, unit: "tablespoon" }),
    "4 tablespoons unsalted butter",
  );
  assert.equal(
    formatIngredientLine({ name: "angel hair pasta", quantity: 12, unit: "ounce" }),
    "12 ounces angel hair pasta",
  );
});

test("the member screen's fraction glyphs are unchanged — formatQuantity still owns the amount", () => {
  assert.equal(formatIngredientLine({ name: "milk", quantity: 1 / 3, unit: "cup" }), "⅓ cup milk");
  assert.equal(
    formatIngredientLine({ name: "flour", quantity: 2.125, unit: "cup" }),
    "2⅛ cups flour",
  );
  assert.equal(formatIngredientLine({ name: "salt", quantity: 2, unit: "tsp" }), "2 tsp salt");
  // The whole-unit ceiling rule formatQuantity applies to "clove"/"whole".
  assert.equal(
    formatIngredientLine({ name: "garlic", quantity: 3.2, unit: "clove" }),
    "4 cloves garlic",
  );
});

// ── the unit edge cases ────────────────────────────────────────────────

// 🔴 BUG-317 — THE INVERSION. The test above this line used to read "unit 'each'
// is emitted AS WRITTEN — pinned deliberately, not ruled", and said so at length:
// suppressing it was "a display decision nobody has made; this test is where it
// would change, and the change would be visible in both screens at once."
//
// Hans made the decision on 2026-09-27. This is that test, inverted, and the
// change was visible in both screens at once exactly as predicted — plus a THIRD
// screen the old comment did not know about (app/dish/[id].tsx still composed its
// line inline; S2 Part E moved it onto this formatter, which is what makes "both
// screens, by construction" true rather than approximate).
test("🔴 BUG-317 — a COUNT unit is SUPPRESSED: '1 large shrimp', not '1 each large shrimp'", () => {
  assert.equal(
    formatIngredientLine({ name: "large shrimp", quantity: 1, unit: "each" }),
    "1 large shrimp",
  );
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "each" }), "2 lemons");
  // Case and whitespace do not smuggle it back in.
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "Each" }), "2 lemons");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: " EACH " }), "2 lemons");
  // The other spellings the ruling names. None of them is in the catalog today
  // (measured: 49 distinct units across both snapshots), but the import path
  // writes `unit` from arbitrary web pages.
  for (const unit of ["piece", "pieces", "count", "ct", "unit", "units"]) {
    assert.equal(
      formatIngredientLine({ name: "chicken thigh", quantity: 3, unit }),
      "3 chicken thighs",
      unit,
    );
  }
});

test("🔴 BUG-317 — REAL units stay words: head, clove, bunch, can, slice, whole, large", () => {
  // The whole point of the ruling is the line between a placeholder and a word a
  // recipe actually says. "1 head garlic" is correct; "1 garlic" is not.
  assert.equal(formatIngredientLine({ name: "garlic", quantity: 1, unit: "head" }), "1 head garlic");
  assert.equal(formatIngredientLine({ name: "garlic", quantity: 6, unit: "clove" }), "6 cloves garlic");
  assert.equal(formatIngredientLine({ name: "parsley", quantity: 1, unit: "bunch" }), "1 bunch parsley");
  assert.equal(
    formatIngredientLine({ name: "coconut milk", quantity: 1, unit: "can" }),
    "1 can coconut milk",
  );
  assert.equal(formatIngredientLine({ name: "bacon", quantity: 6, unit: "slice" }), "6 slices bacon");
  // `whole` is in the SERVER's count-unit table and deliberately NOT suppressed
  // here — "1 whole chicken" is a sentence, and the existing test below pins it.
  assert.equal(formatIngredientLine({ name: "chicken", quantity: 1, unit: "whole" }), "1 whole chicken");
  // `large` maps to "each" in the server's prepCombineEngine canon, and is also
  // deliberately kept: dropping it turns "1 large egg" into "1 egg".
  assert.equal(formatIngredientLine({ name: "egg", quantity: 1, unit: "large" }), "1 large egg");
});

test("🔴 BUG-317 — suppressing the WORD does not change the NUMBER", () => {
  // The suppressed token is STILL handed to formatQuantity, which reads `unit` to
  // pick its whole-unit ceiling rule. Passing "" there instead would be a rounding
  // change disguised as a display change, so this pins that the amount is
  // untouched by the suppression: identical to what the same quantity+unit
  // produced before, for a unit that DOES take the ceiling and one that does not.
  assert.equal(
    formatIngredientLine({ name: "garlic", quantity: 3.2, unit: "clove" }),
    "4 cloves garlic",
    "clove still ceilings, and still prints its word",
  );
  // ⚠️ AN ADJACENT FINDING, PINNED AND NOT FIXED. formatQuantity's ceiling list is
  // ["whole", "clove"] — `each` is NOT in it — so a fractional count prints as a
  // fraction: "3¼ lemons". That is nonsense for a countable thing, and BUG-317
  // makes it slightly more visible by removing the word in front of it. It is NOT
  // this ruling's scope (§2.10 — no changes beyond the above), and adding `each`
  // to that list would move numbers on every screen formatQuantity feeds,
  // including the grocery list. Reported; Hans's call.
  assert.equal(formatIngredientLine({ name: "lemons", quantity: 3.2, unit: "each" }), "3¼ lemons");
  // A whole count is the overwhelmingly common case, and it reads correctly.
  assert.equal(formatIngredientLine({ name: "lemons", quantity: 2, unit: "each" }), "2 lemons");
});

test("BUG-317 — a suppressed unit still leaves no doubled or trailing space", () => {
  for (const unit of ["each", "piece", "count", "ct", "unit"]) {
    const line = formatIngredientLine({ name: "lemon", quantity: 2, unit });
    assert.equal(line, line.trim(), unit);
    assert.ok(!line.includes("  "), unit);
    assert.equal(line, "2 lemons", unit);
  }
  // And with notes on, the parenthetical still attaches to the name.
  assert.equal(
    formatIngredientLine(
      { name: "lemons", quantity: 2, unit: "each", preparationNote: "1 juiced" },
      { includeNotes: true },
    ),
    "2 lemons (1 juiced)",
  );
});

test("a missing unit drops the token instead of emitting a blank word", () => {
  // The wire schema types unit as z.string(), so null is defensive — but an
  // EMPTY string is real (a bare count), and the old inline JSX rendered a
  // double space for it. All three collapse to "amount name".
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: null }), "2 lemons");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "" }), "2 lemons");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "   " }), "2 lemons");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2 }), "2 lemons");
  // No leading, trailing or doubled space in any of them.
  for (const unit of [null, "", "   ", undefined]) {
    const line = formatIngredientLine({ name: "lemon", quantity: 2, unit });
    assert.equal(line, line.trim(), JSON.stringify(unit));
    assert.ok(!line.includes("  "), JSON.stringify(unit));
  }
});

// ── the options, and why their defaults are what they are ──────────────

test("includeNotes is OFF by default — the member screen renders neither note today", () => {
  const ing = { name: "shallot", quantity: 1, unit: "whole", preparationNote: "thinly sliced", isOptional: true };
  assert.equal(formatIngredientLine(ing), "1 whole shallot");
  assert.equal(formatIngredientLine(ing, { includeNotes: true }), "1 whole shallot (thinly sliced) — optional");
});

test("an absent / blank prep note adds nothing even with includeNotes on", () => {
  for (const preparationNote of [null, "", "  ", undefined]) {
    assert.equal(
      formatIngredientLine({ name: "salt", quantity: 1, unit: "tsp", preparationNote }, { includeNotes: true }),
      "1 tsp salt",
      JSON.stringify(preparationNote),
    );
  }
});

test("the multiplier scales before rounding — the member screen's servings stepper", () => {
  // 1.5 lb at 2x is 3 lb, not "1½ pound" twice.
  assert.equal(formatIngredientLine(SHRIMP, { multiplier: 2 }), "3 pounds large shrimp");
  assert.equal(formatIngredientLine(SHRIMP, { multiplier: 0.5 }), "¾ pound large shrimp");
  // Default 1 — what the read-only guest screen relies on.
  assert.equal(formatIngredientLine(SHRIMP, {}), formatIngredientLine(SHRIMP, { multiplier: 1 }));
});

// ═════════════════════════════════════════════════════════════════════════════
// [grocery] Block C — BUG-329 (plural only above one) and BUG-321 (the measure
// units, ported back from the Cookbook generator).
// ═════════════════════════════════════════════════════════════════════════════

describe("🔴 BUG-329 — plural only ABOVE one", () => {
  it("a sub-one count noun stays singular", () => {
    // The guard was `quantity === 1`, so everything below one pluralized too.
    for (const q of [0.125, 0.25, 0.5, 0.75, 0.875]) {
      assert.equal(pluralizeNeedUnit("bunch", q), "bunch", String(q));
      assert.equal(pluralizeNeedUnit("head", q), "head", String(q));
      assert.equal(pluralizeUnitWord("cup", q), "cup", String(q));
    }
    assert.equal(pluralizeNeedUnit("bunch", 1), "bunch");
    assert.equal(pluralizeNeedUnit("bunch", 2), "bunches");
  });

  it("zero and negatives are not more than one of anything", () => {
    assert.equal(pluralizeNeedUnit("head", 0), "head");
    assert.equal(pluralizeNeedUnit("head", -3), "head");
  });

  it("🔴 the live row that made this a PRECONDITION of BUG-321, not a sibling", () => {
    // The catalog carries `0.5 head` (Shredded Cabbage). Wiring the engine into
    // formatIngredientLine without this fix would have shipped "½ heads green
    // cabbage" as the FIX for "½ head cabbage".
    assert.equal(
      formatIngredientLine({ name: "green cabbage", quantity: 0.5, unit: "head" }),
      "½ head green cabbage",
    );
  });
});

describe("BUG-321 — the measure units, owed back from the web", () => {
  it("measure units take a plural above one", () => {
    const CASES: [string, string][] = [
      ["teaspoon", "teaspoons"],
      ["tablespoon", "tablespoons"],
      ["cup", "cups"],
      ["ounce", "ounces"],
      ["fluid ounce", "fluid ounces"],
      ["pound", "pounds"],
      ["gram", "grams"],
      ["inch", "inches"],
      ["pinch", "pinches"],
    ];
    for (const [one, many] of CASES) {
      assert.equal(pluralizeUnitWord(one, 2), many, one);
      assert.equal(pluralizeUnitWord(one, 1), one, `${one} @ 1`);
    }
  });

  it("🔴 ABBREVIATIONS STAY INVARIANT — `2 tbsp`, never `2 tbsps`", () => {
    // All four are live in the catalog (tbsp 110, tsp 98, lb 64, oz 32) and an
    // abbreviation is already invariant in recipe English. Pluralizing one is
    // the exact mistake COUNT_NOUN_PLURALS warns against.
    for (const abbr of ["tbsp", "tsp", "lb", "oz", "g", "kg", "ml", "l"]) {
      assert.equal(pluralizeUnitWord(abbr, 4), abbr, abbr);
    }
    // `large` is not a unit to pluralize either — "2 large eggs" moves the NAME.
    assert.equal(pluralizeUnitWord("large", 2), "large");
  });

  it("the GROCERY parenthetical is unchanged — pluralizeNeedUnit reads one table", () => {
    // "4⅞ ozs" would be worse than the bug pluralizeNeedUnit was written for,
    // so the measure table must NOT leak into it.
    assert.equal(pluralizeNeedUnit("oz", 4.875), "oz");
    assert.equal(pluralizeNeedUnit("cup", 3), "cup");
    assert.equal(pluralizeNeedUnit("teaspoon", 3), "teaspoon");
    // while the recipe-line pluralizer does move them
    assert.equal(pluralizeUnitWord("cup", 3), "cups");
  });

  it("case is preserved, and an unknown unit passes through", () => {
    assert.equal(pluralizeUnitWord("Cup", 2), "Cups");
    assert.equal(pluralizeUnitWord("splorch", 5), "splorch");
    assert.equal(pluralizeUnitWord("cup", null), "cup");
    assert.equal(pluralizeUnitWord("cup", undefined), "cup");
  });
});

describe("🔴 BUG-321 — the line pluralizes on the DISPLAYED amount, not the raw one", () => {
  it("1.05 cup renders `1` and must therefore say `cup`", () => {
    // formatQuantity rounds to the nearest 1/8: Math.round(8.4)/8 = 1. Reading
    // the RAW 1.05 would give "1 cups". A servings multiplier reaches these
    // values routinely (0.7 cup x 1.5 = 1.05).
    assert.equal(formatQuantity(1.05, "cup"), "1");
    assert.equal(displayedQuantity(1.05, "cup"), 1);
    assert.equal(
      formatIngredientLine({ name: "milk", quantity: 0.7, unit: "cup" }, { multiplier: 1.5 }),
      "1 cup milk",
    );
  });

  it("and 1.2 cup rounds UP to 1⅛, which is still not plural", () => {
    assert.equal(formatQuantity(1.2, "cup"), "1¼");
    assert.equal(
      formatIngredientLine({ name: "milk", quantity: 1.2, unit: "cup" }),
      "1¼ cups milk",
    );
  });

  it("the whole-unit ceiling agrees too — 0.6 clove shows `1` and says `clove`", () => {
    assert.equal(formatQuantity(0.6, "clove"), "1");
    assert.equal(displayedQuantity(0.6, "clove"), 1);
    assert.equal(
      formatIngredientLine({ name: "garlic", quantity: 0.6, unit: "clove" }),
      "1 clove garlic",
    );
  });

  it("displayedQuantity and formatQuantity never disagree across the ladder", () => {
    for (let q = 0; q <= 5.001; q += 0.0125) {
      for (const unit of ["cup", "clove", "tablespoon", ""]) {
        const shown = displayedQuantity(q, unit);
        const str = formatQuantity(q, unit);
        // The rendered string must denote the number displayedQuantity returns.
        const asNum = Number(str);
        if (Number.isFinite(asNum) && str.length > 0 && !/[^0-9.]/.test(str)) {
          assert.ok(
            Math.abs(asNum - shown) < 1e-9,
            `${q} ${unit}: "${str}" vs ${shown}`,
          );
        }
      }
    }
  });
});

describe("🔴 BUG-321 — the NAME is counted only when no unit word stands in front of it", () => {
  it("a measure unit takes the plural and the name does NOT", () => {
    // "4 tablespoons unsalted butters" was the first cut. You have four
    // tablespoons, not four butters.
    assert.equal(
      formatIngredientLine({ name: "unsalted butter", quantity: 4, unit: "tablespoon" }),
      "4 tablespoons unsalted butter",
    );
    assert.equal(
      formatIngredientLine({ name: "flour", quantity: 2.125, unit: "cup" }),
      "2⅛ cups flour",
    );
    assert.equal(
      formatIngredientLine({ name: "garlic", quantity: 6, unit: "clove" }),
      "6 cloves garlic",
    );
  });

  it("a SUPPRESSED count unit leaves the number counting the name", () => {
    assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "each" }), "2 lemons");
    assert.equal(formatIngredientLine({ name: "lemon", quantity: 2 }), "2 lemons");
    assert.equal(formatIngredientLine({ name: "lemon", quantity: 1, unit: "each" }), "1 lemon");
  });

  it("an invariant name is still invariant — the grocery engine decides, not this", () => {
    assert.equal(formatIngredientLine({ name: "corn", quantity: 4 }), "4 corn");
    assert.equal(formatIngredientLine({ name: "bread", quantity: 2 }), "2 bread");
  });

  it("a prep clause rides along untouched", () => {
    assert.equal(
      formatIngredientLine(
        { name: "tomatillo, husked and halved", quantity: 4 },
        {},
      ),
      "4 tomatillos, husked and halved",
    );
  });
});

// ── 🔴 [grocery] F (F5.1) — M13 CLOSED: THE NAME SINGULARISES TOO ───────────
//
// The file's own docblock carried this as a known gap: "NO SINGULARIZATION,
// deliberately, and it leaves one class standing: a name authored PLURAL
// against a quantity of 1 still reads '1 lemons'." Hans found it on the
// meal-detail Ingredients sheet as "1 garlic cloves" — the same class, wearing
// a catalog name that is plural by construction.
describe("F5.1 — a count of exactly 1 singularises the name", () => {
  it("🔴 the literal from the device pass", () => {
    assert.equal(
      formatIngredientLine({ name: "garlic cloves", quantity: 1, unit: "each" }),
      "1 garlic clove",
    );
    assert.equal(formatIngredientLine({ name: "lemons", quantity: 1 }), "1 lemon");
    assert.equal(formatIngredientLine({ name: "roma tomatoes", quantity: 1 }), "1 roma tomato");
  });

  it("above one still pluralises — both directions, one function", () => {
    // countedIngredientName is the grocery line's own countedName, exported
    // rather than copied, so the two surfaces cannot disagree about a noun.
    assert.equal(formatIngredientLine({ name: "garlic cloves", quantity: 3 }), "3 garlic cloves");
    assert.equal(formatIngredientLine({ name: "lemon", quantity: 2 }), "2 lemons");
  });

  it("a REAL unit word still blocks both directions", () => {
    // "4 tablespoons unsalted butter" — you have four tablespoons, not four
    // butters, and not one butter either. The unit branch is untouched.
    assert.equal(
      formatIngredientLine({ name: "unsalted butter", quantity: 1, unit: "tablespoon" }),
      "1 tablespoon unsalted butter",
    );
    assert.equal(
      formatIngredientLine({ name: "garlic cloves", quantity: 1, unit: "head" }),
      "1 head garlic cloves",
    );
  });

  it("an invariant or unstemmable name declines, in both directions", () => {
    // singularizeIngredientName returns the name unchanged whenever it cannot
    // act safely — "molasses" is in NOT_A_PLURAL and asparagus fails the -us
    // test. Neither becomes "molass" or "asparagu".
    assert.equal(formatIngredientLine({ name: "molasses", quantity: 1 }), "1 molasses");
    assert.equal(formatIngredientLine({ name: "asparagus", quantity: 1 }), "1 asparagus");
    assert.equal(formatIngredientLine({ name: "corn", quantity: 1 }), "1 corn");
  });

  it("the prep clause rides along, singularising too", () => {
    assert.equal(
      formatIngredientLine({ name: "tomatillos, husked and halved", quantity: 1 }),
      "1 tomatillo, husked and halved",
    );
  });
});
