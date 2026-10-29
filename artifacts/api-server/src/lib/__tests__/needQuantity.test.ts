// WS9 Root B — the NEED quantity stays fine-grained for a MEASURED unit.
//
// PRD §2.8 [LOCKED]: the need "must stay fine-grained and must NEVER be rounded
// toward a purchasable amount." Root B removed the old ceil on discrete units
// (1.25 bunch → 2 bunch) and moved the round-UP to the ORDER line.
//
// 🔴 D-WS9-360 (ruled 2026-10-29) overrules that for units sold by the count or
// the bunch: "a list row for anything sold by the count or the bunch never shows
// a fraction. 0.5 cucumber → 1 cucumber, 0.125 bunch cilantro → 1 bunch." A
// counted need rounds UP to whole items; a bunch keeps the pack forgiveness
// (1⅛ bunches is one bunch, what the order line buys). Measured units are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isCountedNeedUnit, roundNeedQuantity } from "../needQuantity";

describe("D-WS9-360: a counted need is whole", () => {
  it("the ruling's examples and the night run's rows", () => {
    assert.equal(roundNeedQuantity(0.5, "each"), 1, "0.5 cucumber → 1");
    assert.equal(roundNeedQuantity(0.125, "bunch"), 1, "0.125 bunch cilantro → 1 bunch");
    assert.equal(roundNeedQuantity(13.625, "clove"), 14);
    assert.equal(roundNeedQuantity(2.875, "sprig"), 3);
    assert.equal(roundNeedQuantity(8.875, "stalk"), 9);
    assert.equal(roundNeedQuantity(5.625, "each"), 6);
    assert.equal(roundNeedQuantity(0.875, "each"), 1);
    assert.equal(roundNeedQuantity(3.2, ""), 4, "a bare count");
    assert.equal(roundNeedQuantity(1.5, "cans"), 2);
  });

  it("a bunch keeps its forgiveness: 1⅛ bunches is one, 1¼ is two", () => {
    assert.equal(roundNeedQuantity(1.125, "bunch"), 1);
    assert.equal(roundNeedQuantity(1.25, "bunches"), 2);
    assert.equal(roundNeedQuantity(1.125, "head"), 2, "a head keeps for weeks: no forgiveness");
  });

  it("whole numbers pass through", () => {
    assert.equal(roundNeedQuantity(4, "each"), 4);
    assert.equal(roundNeedQuantity(30, "clove"), 30);
    assert.equal(roundNeedQuantity(2, "bunch"), 2);
  });

  it("the counted units, and what is not one", () => {
    for (const u of ["each", "", "whole", "large", "cloves", "head", "bunches", "sprigs", "leaves", "stick", "can", "package", "slices"]) {
      assert.ok(isCountedNeedUnit(u), u);
    }
    for (const u of ["cup", "tablespoon", "tsp", "oz", "ounce", "pound", "lb", "g", "ml", "inch", "pinch", "quart"]) {
      assert.ok(!isCountedNeedUnit(u), u);
    }
  });
});

describe("Root B: a MEASURED need stays fine-grained", () => {
  it("guard B3 — measured units round UP to the ⅛ ladder, keeping thirds", () => {
    assert.equal(roundNeedQuantity(4.4093, "oz"), 4.5);
    assert.equal(roundNeedQuantity(0.5, "cup"), 0.5);
    assert.equal(roundNeedQuantity(1.3, "cup"), 1 + 1 / 3);
    assert.equal(roundNeedQuantity(0.34, "cup"), 0.375);
    assert.equal(roundNeedQuantity(0.68, "cup"), 0.75);
    assert.equal(roundNeedQuantity(0.6, "tablespoon"), 0.625);
  });

  it("guard B4 — non-positive quantities pass through", () => {
    assert.equal(roundNeedQuantity(0, "each"), 0);
    assert.equal(roundNeedQuantity(-1, "each"), -1);
  });
});
