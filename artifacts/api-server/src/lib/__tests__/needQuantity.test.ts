// WS9 Root B — the NEED quantity stays fine-grained for EVERY unit.
//
// PRD §2.8 [LOCKED]: the need "must stay fine-grained and must NEVER be rounded
// toward a purchasable amount." Until this block, discrete/unknown units were
// ceiled to a whole (1.25 bunch → 2 bunch), which is exactly that. Two live
// consequences: a cilantro row read "(2 bunches)" against a true need of 1¼,
// and a ½-lemon addition to a plan was invisible because 0.5 and 0.5+0.5 both
// ceiled to 1.
//
// `083d935` moved the round-UP responsibility to the ORDER line
// (composePackName ceils the pack count), so the need-side ceil is now
// redundant as well as spec-violating.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { roundNeedQuantity } from "../needQuantity";

describe("Root B: roundNeedQuantity keeps count units fine-grained", () => {
  it("guard B1 — a fractional COUNT need is no longer ceiled to a whole", () => {
    // The cilantro headline: 0.5 + 0.5 + 0.25 = 1.25 bunch.
    assert.equal(roundNeedQuantity(1.25, "bunch"), 1.25);
    // The lemon headline: half a lemon stays half a lemon.
    assert.equal(roundNeedQuantity(0.5, "each"), 0.5);
    // ...and adding the second half moves it to a whole, visibly.
    assert.equal(roundNeedQuantity(1, "each"), 1);
    assert.equal(roundNeedQuantity(3.5, "each"), 3.5);
    assert.equal(roundNeedQuantity(0.75, "clove"), 0.75);
  });

  it("guard B2 — count units use the SAME ⅛ ladder as measured units", () => {
    // Round UP to ⅛ granularity, keeping clean thirds. Never down.
    assert.equal(roundNeedQuantity(1.3, "each"), 1 + 1 / 3);
    assert.equal(roundNeedQuantity(0.6, "bunch"), 0.625);
    assert.equal(roundNeedQuantity(2.1, "clove"), 2.125);
  });

  it("guard B3 — whole numbers and measured units are unchanged", () => {
    assert.equal(roundNeedQuantity(4, "each"), 4);
    assert.equal(roundNeedQuantity(30, "clove"), 30);
    assert.equal(roundNeedQuantity(2, "bunch"), 2);
    // Measured-unit behaviour is byte-identical to before this block.
    assert.equal(roundNeedQuantity(4.4093, "oz"), 4.5);
    assert.equal(roundNeedQuantity(0.5, "cup"), 0.5);
    assert.equal(roundNeedQuantity(1.3, "cup"), 1 + 1 / 3);
    assert.equal(roundNeedQuantity(0.34, "cup"), 0.375);
    assert.equal(roundNeedQuantity(0.68, "cup"), 0.75);
  });

  it("guard B4 — non-positive quantities pass through", () => {
    assert.equal(roundNeedQuantity(0, "each"), 0);
    assert.equal(roundNeedQuantity(-1, "each"), -1);
  });
});
