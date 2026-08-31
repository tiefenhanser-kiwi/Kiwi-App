// WS9 BUG-186 — prep-category override: integrity + behaviour.
//
// The override table is keyed on ingredient NAME, which is its one structural
// weakness: a canonical rename unlinks an entry silently and restores exactly
// the behaviour BUG-186 removed. The first suite makes that falsifiable
// against a catalog-generated fixture; the rest pin the rulings themselves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeIngredientName } from "../groceryNormalization";
import {
  PREP_CATEGORY_OVERRIDE,
  resolvePrepCategory,
} from "../prepCategoryOverride";
import { CATALOG_FAMILY_CANONICAL_NAMES } from "./catalogFamilyNames.fixture";

describe("PREP_CATEGORY_OVERRIDE — integrity against the catalog", () => {
  it("every key resolves to a real Ingredient.canonicalName", () => {
    const catalog = new Set(CATALOG_FAMILY_CANONICAL_NAMES);
    const orphans = Object.keys(PREP_CATEGORY_OVERRIDE).filter(
      (k) => !catalog.has(k),
    );
    assert.deepEqual(
      orphans,
      [],
      `override keys with no catalog row (renamed or deleted?): ${orphans.join(", ")}`,
    );
  });

  it("every key is already normalized, so lookups cannot miss", () => {
    for (const key of Object.keys(PREP_CATEGORY_OVERRIDE)) {
      assert.equal(
        normalizeIngredientName(key),
        key,
        `key ${JSON.stringify(key)} is not in normalized form`,
      );
    }
  });

  it("only ever maps to categories the prep engine understands", () => {
    // assignPhase / classifyPrepWorthy switch on these lowercased tokens; a
    // typo would silently become the "no prep phase" default.
    const known = new Set(["Produce", "Protein", "Pantry", "Dairy"]);
    for (const [key, value] of Object.entries(PREP_CATEGORY_OVERRIDE)) {
      assert.ok(known.has(value), `${key} maps to unknown category ${value}`);
    }
  });

  it("covers exactly the 22 ruled rows", () => {
    assert.equal(Object.keys(PREP_CATEGORY_OVERRIDE).length, 22);
  });
});

describe("resolvePrepCategory — the BUG-186 rulings", () => {
  it("is the identity for every un-listed ingredient", () => {
    assert.equal(resolvePrepCategory("yellow onion", "Produce"), "Produce");
    assert.equal(resolvePrepCategory("chicken thighs", "Protein"), "Protein");
    assert.equal(resolvePrepCategory("whole milk", "Dairy"), "Dairy");
    assert.equal(resolvePrepCategory("kosher salt", "Pantry"), "Pantry");
  });

  it("pins cheese to Pantry so grating stays prep work", () => {
    // Aisle is now Dairy; prep must still see the pre-fix token.
    assert.equal(resolvePrepCategory("parmigiano-reggiano", "Dairy"), "Pantry");
    assert.equal(resolvePrepCategory("pecorino romano", "Dairy"), "Pantry");
    assert.equal(resolvePrepCategory("queso fresco", "Dairy"), "Pantry");
  });

  it("pins tofu to Protein so pressing/marinating stays prep work", () => {
    assert.equal(resolvePrepCategory("extra-firm tofu", "Dairy"), "Protein");
    assert.equal(resolvePrepCategory("firm tofu", "Dairy"), "Protein");
    assert.equal(resolvePrepCategory("silken tofu", "Dairy"), "Protein");
  });

  it("keeps egg pasta out of Prep Week after its aisle move to Pantry", () => {
    // Pantry would have GIVEN them a phase; the aisle fix must add nothing.
    assert.equal(resolvePrepCategory("wide egg noodles", "Pantry"), "Dairy");
    assert.equal(resolvePrepCategory("egg noodles", "Pantry"), "Dairy");
    assert.equal(
      resolvePrepCategory("fresh lo mein egg noodles", "Pantry"),
      "Dairy",
    );
  });

  it("drops large eggs out of Prep Week (Hans: not on Sunday for Thursday)", () => {
    assert.equal(resolvePrepCategory("large eggs", "Dairy"), "Dairy");
  });

  it("brings hard-boiled eggs IN as the one egg exception", () => {
    assert.equal(resolvePrepCategory("hard-boiled eggs", "Dairy"), "Protein");
  });

  it("matches on the display-cased name the engine actually carries", () => {
    // The loader passes Ingredient.displayName, not canonicalName.
    assert.equal(resolvePrepCategory("Large eggs", "Dairy"), "Dairy");
    assert.equal(
      resolvePrepCategory("Parmigiano-Reggiano rind", "Dairy"),
      "Pantry",
    );
    assert.equal(resolvePrepCategory("Extra-firm tofu", "Dairy"), "Protein");
  });
});
