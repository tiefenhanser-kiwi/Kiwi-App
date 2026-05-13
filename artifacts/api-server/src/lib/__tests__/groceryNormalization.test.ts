// WS6 6c-4 Block A — normalizeIngredientName tests.
// Pure function; no DB, no AI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeIngredientName } from "../groceryNormalization";

describe("normalizeIngredientName", () => {
  it("lowercases mixed-case input", () => {
    assert.equal(normalizeIngredientName("Salt"), "salt");
    assert.equal(normalizeIngredientName("SALT"), "salt");
    assert.equal(normalizeIngredientName("OlIvE oIl"), "olive oil");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeIngredientName("  butter  "), "butter");
    assert.equal(normalizeIngredientName("\tflour\n"), "flour");
  });

  it("strips leading article 'the '", () => {
    assert.equal(normalizeIngredientName("the salt"), "salt");
    assert.equal(normalizeIngredientName("The Olive Oil"), "olive oil");
  });

  it("strips leading article 'a '", () => {
    assert.equal(normalizeIngredientName("a lemon"), "lemon");
    assert.equal(normalizeIngredientName("A Lemon"), "lemon");
  });

  it("does NOT strip 'the' or 'a' mid-string", () => {
    assert.equal(normalizeIngredientName("salt of the earth"), "salt of the earth");
    assert.equal(normalizeIngredientName("apple a day"), "apple a day");
  });

  it("collapses internal whitespace", () => {
    assert.equal(normalizeIngredientName("olive    oil"), "olive oil");
    assert.equal(normalizeIngredientName("all  -  purpose  flour"), "all - purpose flour");
  });

  it("is idempotent", () => {
    const cases = [
      "Salt",
      "  THE  Olive Oil  ",
      "a    lemon",
      "all-purpose flour",
      "",
    ];
    for (const c of cases) {
      const once = normalizeIngredientName(c);
      const twice = normalizeIngredientName(once);
      assert.equal(twice, once, `not idempotent for ${JSON.stringify(c)}`);
    }
  });
});
