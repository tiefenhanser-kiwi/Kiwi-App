// THX-3c item C (BUG-464) — equipment never scales; a stalk or a rib prints whole.
// The stalk inputs are the ones WEB-4c pins on the client (lib/format/quantity.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dishRowMultipliers, displayedPrepQuantity, isEquipmentItem } from "../prepQuantity";
import { formatMeasure } from "../prepWeekAssembly";

describe("THX-3c — equipment never scales (BUG-464)", () => {
  it("knows the brining bag, twine, foil and parchment — and no food, and not skewers (WEB-4c)", () => {
    for (const n of ["large brining bag", "kitchen twine", "aluminum foil", "parchment paper", "turkey-size oven bag", "cheesecloth"]) assert.equal(isEquipmentItem(n), true, n);
    for (const n of ["whole turkey", "celery", "kosher salt", "bamboo skewers", "toothpicks"]) assert.equal(isEquipmentItem(n), false, n);
  });

  it("prints as written at any servings beside a bird by weight, never below 1; one per bird beside a bird by count", () => {
    const weight = [{ quantity: 14, unit: "pound", name: "whole turkey" }, { quantity: 1, unit: "each", name: "large brining bag" }, { quantity: 1, unit: "cup", name: "kosher salt" }];
    const count = [{ quantity: 1, unit: "each", name: "whole turkey" }, { quantity: 1, unit: "each", name: "large brining bag" }];
    for (const m of [0.1, 0.4, 1, 1.4, 2, 3]) assert.equal(1 * dishRowMultipliers(weight, m)[1], 1, `weight ×${m}`);
    for (const m of [0.1, 0.4, 1, 1.4]) assert.equal(1 * dishRowMultipliers(count, m, { feast: true })[1], 1, `count ×${m}`);
    // 15 and 20 of 10: two turkeys, two bags (WEB-4c's pin).
    assert.equal(dishRowMultipliers(count, 1.5, { feast: true })[1], 2);
    assert.equal(dishRowMultipliers(count, 2, { feast: true })[1], 2);
    assert.equal(0.5 * dishRowMultipliers([{ quantity: 0.5, unit: "roll", name: "aluminum foil" }], 0.4)[0], 1);
  });

  it("skewers scale with the food they hold", () => {
    assert.deepEqual(dishRowMultipliers([{ quantity: 8, unit: "each", name: "bamboo skewers" }, { quantity: 1, unit: "pound", name: "shrimp" }], 2), [2, 2]);
  });
});

describe("THX-3c — a stalk or a rib prints whole (BUG-464)", () => {
  // Classic's stuffing celery (6 stalk for 10) and Make-Ahead's (6 each "celery stalks").
  const TABLE: Array<[number, string, string]> = [
    [1, "1 stalk", "1"],
    [4, "2 stalks", "2"],
    [8, "5 stalks", "5"],
    [10, "6 stalks", "6"],
    [15, "9 stalks", "9"],
  ];
  for (const [servings, byUnit, byName] of TABLE) {
    it(`${servings} servings of 6 → ${byUnit} / ${byName}`, () => {
      assert.equal(formatMeasure(6 * (servings / 10), "stalk", "celery"), byUnit);
      assert.equal(formatMeasure(6 * (servings / 10), "each", "celery stalks"), byName);
    });
  }

  it("the nearest whole, halves up, never below 1 — by the unit word or a count of the name", () => {
    assert.equal(displayedPrepQuantity(4.75, "stalk", "celery"), 5);
    assert.equal(displayedPrepQuantity(2.4, "stalks", "celery"), 2);
    assert.equal(displayedPrepQuantity(0.3, "rib", "celery"), 1);
    assert.equal(displayedPrepQuantity(2.5, "ribs", "celery"), 3);
    assert.equal(displayedPrepQuantity(1.6, "", "lemongrass stalks"), 2);
    assert.equal(displayedPrepQuantity(1.6, "each", "celery ribs"), 2);
    // Not a count of stalks: a cup of sliced celery, a pound of ribs.
    assert.equal(displayedPrepQuantity(1.6, "cup", "celery stalks"), 1 + 2 / 3);
    assert.equal(displayedPrepQuantity(2.6, "lb", "pork ribs"), 2.5);
  });
});
