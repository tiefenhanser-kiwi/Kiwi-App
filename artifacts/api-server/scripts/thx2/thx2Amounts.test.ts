// THX-3c (F) — a feast step that adds cut food names its amounts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nameCutAmounts } from "./thx2Amounts";
import { FINALIZE_RULES } from "./thx2Core";

// Make-Ahead's Overnight Sage Stuffing and Turkey Gravy rows (dev 7bba38a8).
const STUFFING = [
  { name: "yellow onion", quantity: 2, unit: "each" },
  { name: "celery stalks", quantity: 6, unit: "each", note: "diced" },
  { name: "garlic", quantity: 4, unit: "clove" },
  { name: "fresh sage", quantity: 0.25, unit: "cup" },
];
const GRAVY = [
  { name: "yellow onion", quantity: 1, unit: "each" },
  { name: "celery stalks", quantity: 2, unit: "each", note: "roughly chopped" },
  { name: "carrots", quantity: 2, unit: "each", note: "roughly chopped" },
  { name: "garlic", quantity: 4, unit: "clove" },
];

describe("THX-3c F — nameCutAmounts", () => {
  it("the stuffing's onions and celery (the prompt's own example)", () => {
    assert.equal(
      nameCutAmounts("Make ahead (Wednesday): Melt 8 tablespoons butter; add the diced onions and celery and cook 10 minutes.", STUFFING),
      "Make ahead (Wednesday): Melt 8 tablespoons butter; add the 2 diced onions and 6 diced celery stalks and cook 10 minutes.",
    );
  });

  it("a unit word goes in front, unless the phrase already says it", () => {
    assert.equal(nameCutAmounts("Stir in the minced garlic, ¼ cup chopped sage.", STUFFING), "Stir in the 4 cloves minced garlic, ¼ cup chopped sage.");
    assert.equal(nameCutAmounts("Mash the butter with the smashed garlic cloves.", [{ name: "garlic", quantity: 6, unit: "clove" }]), "Mash the butter with the 6 smashed garlic cloves.");
  });

  it("each phrase on its own: the gravy's chopped onion, then its smashed garlic", () => {
    assert.equal(
      nameCutAmounts("Add the chopped onion, celery, and carrots to the pot; cook 5 minutes, then add the smashed garlic, 4 thyme sprigs.", GRAVY),
      "Add the 1 chopped onion, 2 chopped celery stalks, and 2 chopped carrots to the pot; cook 5 minutes, then add the 4 cloves smashed garlic, 4 thyme sprigs.",
    );
  });

  it("a listed food after the first takes its own cut, or none — never the first one's", () => {
    const rows = [{ name: "cremini mushrooms", quantity: 12, unit: "ounce" }, { name: "fresh thyme", quantity: 1, unit: "tablespoon", note: "leaves, chopped" }, { name: "fresh rosemary", quantity: 1, unit: "teaspoon" }];
    assert.equal(nameCutAmounts("Add the sliced mushrooms, thyme, and rosemary; cook 8 minutes.", rows), "Add the 12 oz sliced mushrooms, 1 tbsp chopped thyme, and 1 tsp rosemary; cook 8 minutes.");
  });

  it("a food named by its head noun: the gravy's sliced mushrooms are its cremini mushrooms", () => {
    assert.equal(nameCutAmounts("Add the sliced mushrooms.", [{ name: "cremini mushrooms", quantity: 12, unit: "ounce" }]), "Add the 12 oz sliced mushrooms.");
  });

  it("leaves alone a food the step already measures, a food the dish does not list, and a phrase with a number", () => {
    const t = "Add the diced onions and cook.";
    assert.equal(nameCutAmounts(t, STUFFING, new Set(["yellow onion"])), t);
    assert.equal(nameCutAmounts("Add the sliced mushrooms.", STUFFING), "Add the sliced mushrooms.");
    assert.equal(nameCutAmounts("Add the 2 diced onions.", STUFFING), "Add the 2 diced onions.");
  });

  it("is idempotent", () => {
    const once = nameCutAmounts("add the diced onions and celery and cook", STUFFING);
    assert.equal(nameCutAmounts(once, STUFFING), once);
  });

  it("FINALIZE_RULES (h) asks new generations for the same", () => {
    assert.match(FINALIZE_RULES, /\(h\) A step that adds food cut earlier names its amount/);
  });
});
