import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeWizardContentHash } from "../wizardContentHash";

describe("computeWizardContentHash", () => {
  it("is deterministic — same title + meals produce the same key", () => {
    const a = computeWizardContentHash("Cozy Comfort Week", [
      "Sheet-pan harissa chicken",
      "Tomato soup + grilled cheese",
    ]);
    const b = computeWizardContentHash("Cozy Comfort Week", [
      "Sheet-pan harissa chicken",
      "Tomato soup + grilled cheese",
    ]);
    assert.equal(a, b);
  });

  it("is order-independent across meal titles", () => {
    const a = computeWizardContentHash("Cozy Comfort Week", [
      "Sheet-pan harissa chicken",
      "Tomato soup + grilled cheese",
      "Steak + green beans",
    ]);
    const b = computeWizardContentHash("Cozy Comfort Week", [
      "Steak + green beans",
      "Tomato soup + grilled cheese",
      "Sheet-pan harissa chicken",
    ]);
    assert.equal(a, b);
  });

  it("normalizes case, padding, and collapsed whitespace", () => {
    const a = computeWizardContentHash("Cozy Comfort Week", [
      "Sheet-pan harissa chicken",
    ]);
    const b = computeWizardContentHash("  cozy   COMFORT week ", [
      "sheet-pan  harissa   chicken",
    ]);
    assert.equal(a, b);
  });

  it("ignores empty / whitespace-only meal titles", () => {
    const a = computeWizardContentHash("Week", ["Tacos", "Salmon"]);
    const b = computeWizardContentHash("Week", ["Tacos", "", "  ", "Salmon"]);
    assert.equal(a, b);
  });

  it("differs when the title differs", () => {
    const a = computeWizardContentHash("Cozy Comfort Week", ["Tacos"]);
    const b = computeWizardContentHash("High-Protein Reset", ["Tacos"]);
    assert.notEqual(a, b);
  });

  it("differs when the meal set differs", () => {
    const a = computeWizardContentHash("Week", ["Tacos", "Salmon"]);
    const b = computeWizardContentHash("Week", ["Tacos", "Lasagna"]);
    assert.notEqual(a, b);
  });

  it("is delimiter-safe — a title with separators can't forge a collision", () => {
    // Naive join('|') would make ['a','b'] collide with ['a|b'].
    const a = computeWizardContentHash("Week", ["a", "b"]);
    const b = computeWizardContentHash("Week", ["a|b"]);
    assert.notEqual(a, b);
  });

  it("returns a hex SHA-256 digest (64 hex chars)", () => {
    const key = computeWizardContentHash("Week", ["Tacos"]);
    assert.match(key, /^[0-9a-f]{64}$/);
  });
});
