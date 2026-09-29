// WS9 D-WS9-284 / D-WS9-188 — R3, the recurring line.
//
// Every fixture is a row measured on the B3 after-state corpus
// (artifacts/api-server/scripts/grocery-census/out/b3__*__r1.json — 96 recurring
// rows across 20 plans, 21 distinct), not an invented example.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isHouseholdRow, recurringDetail, withRecurringDetail } from "../format/recurringLine";
import type { RecurringFacets } from "../types";

const facets = (f: Partial<RecurringFacets>): RecurringFacets => ({
  recurringQuantity: null,
  recurringUnit: null,
  mealQuantity: null,
  mealUnit: null,
  comparable: false,
  household: false,
  ...f,
});

describe("R3 branch 1 — SAME UNIT: one line, summed, with the split", () => {
  it("the ruled sentence", () => {
    // Hans, D-WS9-188: "5 lemons — 2 recurring + 3 for meals".
    const r = recurringDetail(
      facets({
        recurringQuantity: 2,
        recurringUnit: "each",
        mealQuantity: 3,
        mealUnit: "each",
        comparable: true,
      }),
    );
    assert.equal(r?.branch, "summed");
    assert.equal(r?.detail, "2 recurring + 3 for meals");
    assert.equal(withRecurringDetail("5 lemons", facets({
      recurringQuantity: 2, recurringUnit: "each", mealQuantity: 3, mealUnit: "each", comparable: true,
    })), "5 lemons — 2 recurring + 3 for meals");
  });

  it("the live limes row: 4 limes, 2 of them the standing order", () => {
    assert.equal(
      withRecurringDetail(
        "4 limes",
        facets({ recurringQuantity: 2, recurringUnit: "each", mealQuantity: 2, mealUnit: "each", comparable: true }),
      ),
      "4 limes — 2 recurring + 2 for meals",
    );
  });

  it("the unit is NOT repeated on the split — the line already said it", () => {
    const r = recurringDetail(
      facets({ recurringQuantity: 2, recurringUnit: "each", mealQuantity: 14, mealUnit: "each", comparable: true }),
    );
    assert.equal(r?.detail, "2 recurring + 14 for meals");
    assert.ok(!r?.detail.includes("each"));
  });
});

describe("R3 branch 2 — OTHERWISE: the recurring quantity orders, the need shows beside it", () => {
  it("🔴 the ruled sentence, and the standing prohibition it encodes", () => {
    // "1 gallon whole milk — recurring; ½ cup for meals." A gallon and half a
    // cup convert perfectly, and Hans put that exact pair in this branch on
    // purpose: THE APP NEVER DECIDES THAT A GALLON COVERS THE CUPS.
    assert.equal(
      withRecurringDetail(
        "1 gallon whole milk",
        facets({ recurringQuantity: 1, recurringUnit: "gallon", mealQuantity: 0.5, mealUnit: "cup" }),
      ),
      "1 gallon whole milk — recurring; ½ cup for meals",
    );
  });

  it("fractions render as GLYPHS, not decimals", () => {
    for (const [q, glyph] of [[0.5, "½"], [0.25, "¼"], [0.75, "¾"], [1.25, "1¼"]] as const) {
      const r = recurringDetail(
        facets({ recurringQuantity: 1, recurringUnit: "gallon", mealQuantity: q, mealUnit: "cup" }),
      );
      assert.equal(r?.detail, `recurring; ${glyph} cup for meals`, String(q));
    }
  });

  it("dozen↔each is NOT converted (ruling 4) — it takes this branch", () => {
    // A recurring "1 dozen" against a recipe's 5 each is two units.
    assert.equal(
      withRecurringDetail(
        "1 dozen large eggs",
        facets({ recurringQuantity: 1, recurringUnit: "dozen", mealQuantity: 5, mealUnit: "each" }),
      ),
      "1 dozen large eggs — recurring; 5 each for meals",
    );
  });

  it("the count-noun plural applies to the need unit", () => {
    const r = recurringDetail(
      facets({ recurringQuantity: 1, recurringUnit: "bag", mealQuantity: 3, mealUnit: "clove" }),
    );
    assert.equal(r?.detail, "recurring; 3 cloves for meals");
  });
});

describe("R3 branch 3 — no plan need: `recurring` and nothing else", () => {
  it("the five live rows the plan needs none of", () => {
    for (const line of ["1 gallon whole milk", "1 dozen large eggs", "1 bag Pet treats"]) {
      const r = recurringDetail(facets({ recurringQuantity: 1, recurringUnit: "gallon", mealQuantity: null }));
      assert.equal(r?.branch, "recurring_only");
      assert.equal(withRecurringDetail(line, facets({ mealQuantity: null })), `${line} — recurring`);
    }
  });

  it("a zero meal quantity is the same thing — no `+ 0 for meals`", () => {
    const r = recurringDetail(
      facets({ recurringQuantity: 2, recurringUnit: "each", mealQuantity: 0, mealUnit: "each", comparable: true }),
    );
    assert.equal(r?.branch, "recurring_only");
    assert.equal(r?.detail, "recurring");
  });
});

describe("R3 — additive by construction", () => {
  it("no facets → no clause, and the line is byte-identical", () => {
    assert.equal(recurringDetail(undefined), null);
    assert.equal(withRecurringDetail("1 gallon whole milk (1 gallon)", undefined), "1 gallon whole milk (1 gallon)");
  });

  it("comparable but with no recurring quantity falls to the default-purchase branch", () => {
    // A resolution with no pack cannot state a split; it must not print
    // "null recurring".
    const r = recurringDetail(
      facets({ recurringQuantity: null, recurringUnit: null, mealQuantity: 3, mealUnit: "each", comparable: true }),
    );
    assert.equal(r?.branch, "default_purchase");
    assert.equal(r?.detail, "recurring; 3 each for meals");
  });
});

describe("🔴 household is keyed on sectionKey, not on the facet", () => {
  it("the three live household rows", () => {
    for (const name of ["Paper towels", "Toilet paper", "Pet treats"]) {
      assert.equal(isHouseholdRow({ sectionKey: "household" }), true, name);
    }
  });

  it("and every food section is not", () => {
    for (const k of ["produce", "meat_seafood", "dairy_eggs", "bakery_bread", "pantry", "canned", "frozen", "snacks", "extras"]) {
      assert.equal(isHouseholdRow({ sectionKey: k }), false, k);
    }
  });

  it("it does not depend on the row still being claimed by a recurring text", () => {
    // A pre-B3 list, or one whose user deleted the recurring text since, keeps
    // the SECTION and loses the facet. The section is the durable signal.
    assert.equal(isHouseholdRow({ sectionKey: "household" }), true);
  });
});
