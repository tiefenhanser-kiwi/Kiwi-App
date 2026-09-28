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
import { test } from "node:test";

import { formatIngredientLine } from "../format/ingredientLine";

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
  assert.equal(formatIngredientLine(SHRIMP), "1½ pound large shrimp");
  // What the guest recipe screen shows: the same core, plus the prep note it
  // already carried before this fix.
  assert.equal(
    formatIngredientLine(SHRIMP, { includeNotes: true }),
    "1½ pound large shrimp (patted dry)",
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
    "4 tablespoon unsalted butter",
  );
  assert.equal(
    formatIngredientLine({ name: "angel hair pasta", quantity: 12, unit: "ounce" }),
    "12 ounce angel hair pasta",
  );
});

test("the member screen's fraction glyphs are unchanged — formatQuantity still owns the amount", () => {
  assert.equal(formatIngredientLine({ name: "milk", quantity: 1 / 3, unit: "cup" }), "⅓ cup milk");
  assert.equal(
    formatIngredientLine({ name: "flour", quantity: 2.125, unit: "cup" }),
    "2⅛ cup flour",
  );
  assert.equal(formatIngredientLine({ name: "salt", quantity: 2, unit: "tsp" }), "2 tsp salt");
  // The whole-unit ceiling rule formatQuantity applies to "clove"/"whole".
  assert.equal(
    formatIngredientLine({ name: "garlic", quantity: 3.2, unit: "clove" }),
    "4 clove garlic",
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
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "each" }), "2 lemon");
  // Case and whitespace do not smuggle it back in.
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "Each" }), "2 lemon");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: " EACH " }), "2 lemon");
  // The other spellings the ruling names. None of them is in the catalog today
  // (measured: 49 distinct units across both snapshots), but the import path
  // writes `unit` from arbitrary web pages.
  for (const unit of ["piece", "pieces", "count", "ct", "unit", "units"]) {
    assert.equal(
      formatIngredientLine({ name: "chicken thigh", quantity: 3, unit }),
      "3 chicken thigh",
      unit,
    );
  }
});

test("🔴 BUG-317 — REAL units stay words: head, clove, bunch, can, slice, whole, large", () => {
  // The whole point of the ruling is the line between a placeholder and a word a
  // recipe actually says. "1 head garlic" is correct; "1 garlic" is not.
  assert.equal(formatIngredientLine({ name: "garlic", quantity: 1, unit: "head" }), "1 head garlic");
  assert.equal(formatIngredientLine({ name: "garlic", quantity: 6, unit: "clove" }), "6 clove garlic");
  assert.equal(formatIngredientLine({ name: "parsley", quantity: 1, unit: "bunch" }), "1 bunch parsley");
  assert.equal(
    formatIngredientLine({ name: "coconut milk", quantity: 1, unit: "can" }),
    "1 can coconut milk",
  );
  assert.equal(formatIngredientLine({ name: "bacon", quantity: 6, unit: "slice" }), "6 slice bacon");
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
    "4 clove garlic",
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
    assert.equal(line, "2 lemon", unit);
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
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: null }), "2 lemon");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "" }), "2 lemon");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "   " }), "2 lemon");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2 }), "2 lemon");
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
  assert.equal(formatIngredientLine(SHRIMP, { multiplier: 2 }), "3 pound large shrimp");
  assert.equal(formatIngredientLine(SHRIMP, { multiplier: 0.5 }), "¾ pound large shrimp");
  // Default 1 — what the read-only guest screen relies on.
  assert.equal(formatIngredientLine(SHRIMP, {}), formatIngredientLine(SHRIMP, { multiplier: 1 }));
});
