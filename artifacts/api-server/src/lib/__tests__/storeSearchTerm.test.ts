// SERVER-6 B (D-WS9-325) — Shop Your Store's search term: the Instacart cleaner plus
// SHOP-0 Phase 0 §4's rules. Every row below is a live dev row's shape (§4's table and
// its "also seen" list), pinned with a LITERAL expected string.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { storeSearchTerm } from "../retailers/storeSearchTerm";

const cases: Array<[string, string]> = [
  // already clean: the cleaner's term
  ["extra-firm tofu", "extra-firm tofu"],
  ["fresh flat-leaf parsley", "fresh flat-leaf parsley"],
  ["1 lb ground turkey", "ground turkey"],
  // 1. accents folded
  ["jalapeño", "jalapeno"],
  ["jalapeño, stemmed and halved", "jalapeno"],
  // 2. a leading "pinch of"
  ["pinch of Kashmiri red chili powder", "Kashmiri red chili powder"],
  // 3. comma clauses: one adjective first, a short proper name first, anything else dropped
  ["guajillo chiles, dried", "dried guajillo chiles"],
  ["cumin, ground", "ground cumin"],
  ["black pepper, freshly ground", "ground black pepper"],
  ["tomatoes, San Marzano", "San Marzano tomatoes"],
  ["porterhouse steaks, about 1.25 inches thick", "porterhouse steaks"],
  ["day-old Italian bread, crusts removed", "Italian bread"],
  ["whole milk, 1 qt", "whole milk"],
  ["lime juice, freshly squeezed", "lime juice"],
  // 4. the first of an "or" pair
  ["chicken or vegetable broth", "chicken broth"],
  ["lard or vegetable oil", "lard"],
  ["avocado oil or olive oil", "avocado oil"],
  ["toothpicks or wooden skewers", "toothpicks"],
  ["soft or silken tofu", "soft tofu"],
  ["fresh or thawed frozen corn kernels", "fresh corn kernels"],
  // 5. prep states
  ["hard-boiled eggs", "eggs"],
  ["ripe avocado", "avocado"],
  ["coarsely ground black pepper", "black pepper"],
  ["store-bought empanada discs (5-inch)", "empanada discs"],
  ["day-old cooked long-grain white rice", "long-grain white rice"],
  // 6. the lean ratio kept, once
  ["ground beef (80/20)", "80/20 ground beef"],
  ["ground beef (80/20 chuck)", "80/20 ground beef"],
  ["80/20 ground beef", "80/20 ground beef"],
  ["2 lb pack ground beef (80/20)", "80/20 ground beef"],
  // and the rest SHOP-0 listed
  ["1/2&1/2", "half and half"],
  ["3 lb pack bone-in skin-on chicken thighs", "bone-in skin-on chicken thighs"],
];

describe("storeSearchTerm — SHOP-0's rules over the Instacart cleaner", () => {
  for (const [row, want] of cases) {
    it(`${row} → ${want}`, () => assert.equal(storeSearchTerm(row, null), want));
  }

  it("prefers userResolvedTo, and the lean ratio comes from the source it chose", () => {
    assert.equal(storeSearchTerm("milk", "whole milk"), "whole milk");
    assert.equal(storeSearchTerm("ground beef", "ground beef (93/7)"), "93/7 ground beef");
    assert.equal(storeSearchTerm("ground beef (80/20)", "ground turkey"), "ground turkey");
  });

  it("a fraction is not a lean ratio; an emptied term falls back to the cleaner's", () => {
    assert.equal(storeSearchTerm("1/2 cup rice", null), "rice");
    assert.equal(storeSearchTerm("ripe", null), "ripe");
  });
});
