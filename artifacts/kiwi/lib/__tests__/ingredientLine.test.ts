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

test("unit 'each' is emitted AS WRITTEN — pinned deliberately, not ruled", () => {
  // "1 each large shrimp" is what the member meal screen shows today for a
  // count unit, and Block 2b ruled no copy changes beyond the three fixes. So
  // this formatter reproduces it rather than quietly suppressing the word.
  // Suppressing it is a display decision nobody has made; this test is where it
  // would change, and the change would be visible in both screens at once.
  assert.equal(formatIngredientLine({ name: "large shrimp", quantity: 1, unit: "each" }), "1 each large shrimp");
  assert.equal(formatIngredientLine({ name: "lemon", quantity: 2, unit: "each" }), "2 each lemon");
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
