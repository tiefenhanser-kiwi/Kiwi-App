// Row 8 · Block 1 — R5, the Instacart search term. Every shape listed in the
// block prompt's §3 census is pinned with a LITERAL expected string.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { instacartSearchName } from "../retailers/instacartName";

describe("instacartSearchName — R5", () => {
  it("leaves a clean name alone, case included", () => {
    assert.equal(instacartSearchName("Parmesan cheese", null), "Parmesan cheese");
    assert.equal(instacartSearchName("olive oil", null), "olive oil");
  });

  it("prefers userResolvedTo over displayName", () => {
    assert.equal(instacartSearchName("milk", "whole milk"), "whole milk");
    assert.equal(instacartSearchName("coffee", "Nespresso pods"), "Nespresso pods");
    // Blank resolution is no resolution.
    assert.equal(instacartSearchName("milk", "   "), "milk");
  });

  it("strips a baked pack prefix with a size — '<number> <word> (<size>) '", () => {
    assert.equal(instacartSearchName("1 bottle (15 oz) lemon juice", null), "lemon juice");
    assert.equal(instacartSearchName("2 cans (14.5 oz each) diced tomatoes", null), "diced tomatoes");
    assert.equal(instacartSearchName("1 bunch (~6-8 scallions) scallions", null), "scallions");
  });

  it("strips a bare pack prefix only when the word is a unit noun", () => {
    assert.equal(instacartSearchName("1 lb ground turkey", null), "ground turkey");
    assert.equal(instacartSearchName("2 cloves garlic", null), "garlic");
    assert.equal(instacartSearchName("1.5 lbs chicken thighs", null), "chicken thighs");
    // "breasts" is not a unit — the count is part of the name and stays.
    assert.equal(instacartSearchName("2 chicken breasts", null), "2 chicken breasts");
  });

  it("strips parentheticals", () => {
    assert.equal(instacartSearchName("ground beef (80/20 chuck)", null), "ground beef");
    assert.equal(instacartSearchName("tomatoes (Roma) ripe", null), "tomatoes ripe");
  });

  it("strips trailing prep clauses, repeatedly", () => {
    assert.equal(instacartSearchName("white onion, roughly chopped", null), "white onion");
    assert.equal(instacartSearchName("garlic, minced", null), "garlic");
    assert.equal(instacartSearchName("parsley, chopped, for garnish", null), "parsley");
    assert.equal(instacartSearchName("salt, to taste", null), "salt");
    assert.equal(instacartSearchName("butter, at room temperature", null), "butter");
    assert.equal(instacartSearchName("cilantro, plus more for serving", null), "cilantro");
  });

  it("keeps a comma clause that does not open with a prep word", () => {
    assert.equal(instacartSearchName("tomatoes, San Marzano", null), "tomatoes, San Marzano");
  });

  it("keeps canned / fresh / frozen / dried and does not rewrite 'or' alternatives", () => {
    assert.equal(instacartSearchName("canned black beans", null), "canned black beans");
    assert.equal(instacartSearchName("fresh basil, chopped", null), "fresh basil");
    assert.equal(instacartSearchName("frozen peas", null), "frozen peas");
    assert.equal(instacartSearchName("dried oregano", null), "dried oregano");
    assert.equal(instacartSearchName("chicken or vegetable broth", null), "chicken or vegetable broth");
  });

  it("combines the shapes", () => {
    assert.equal(
      instacartSearchName("1 lb ground beef (80/20 chuck), divided", null),
      "ground beef",
    );
    assert.equal(instacartSearchName("  Parmesan   cheese , grated ", null), "Parmesan cheese");
  });

  it("falls back to the untouched source when cleaning would empty the name", () => {
    assert.equal(instacartSearchName("1 bottle (15 oz)", null), "1 bottle (15 oz)");
    assert.equal(instacartSearchName("(optional)", null), "(optional)");
  });
});
