// Row 8 · Block 1 — Instacart unit mapping (R3 order line, R4 measurement).
//
// ⚠️ EVERY expectation below is an EXPLICIT LITERAL. Nothing loops over
// INSTACART_ORDER_UNITS / INSTACART_MEASURE_UNITS, because an assertion that
// reads the same table the code reads pins nothing (§27.4). The pairs are
// written out by hand from the live unit census in the block prompt.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mapMeasurement,
  mapOrderUnit,
  normalizeUnitToken,
} from "../retailers/instacartUnits";

describe("normalizeUnitToken", () => {
  it("lower-cases, trims, collapses inner whitespace, and reads null as empty", () => {
    assert.equal(normalizeUnitToken("  Fl   Oz "), "fl oz");
    assert.equal(normalizeUnitToken(null), "");
    assert.equal(normalizeUnitToken(undefined), "");
  });
});

describe("mapOrderUnit — R3, the order line", () => {
  it("countable pack units pass through at the given quantity", () => {
    assert.deepEqual(mapOrderUnit("each", 3), { quantity: 3, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("can", 2), { quantity: 2, unit: "can", mapped: true });
    assert.deepEqual(mapOrderUnit("cans", 2), { quantity: 2, unit: "can", mapped: true });
    assert.deepEqual(mapOrderUnit("bunch", 1), { quantity: 1, unit: "bunch", mapped: true });
    assert.deepEqual(mapOrderUnit("head", 1), { quantity: 1, unit: "head", mapped: true });
    assert.deepEqual(mapOrderUnit("package", 1), { quantity: 1, unit: "package", mapped: true });
    assert.deepEqual(mapOrderUnit("packages", 2), { quantity: 2, unit: "package", mapped: true });
    assert.deepEqual(mapOrderUnit("packet", 1), { quantity: 1, unit: "packet", mapped: true });
    assert.deepEqual(mapOrderUnit("large", 2), { quantity: 2, unit: "large", mapped: true });
    assert.deepEqual(mapOrderUnit("medium", 2), { quantity: 2, unit: "medium", mapped: true });
    assert.deepEqual(mapOrderUnit("small", 2), { quantity: 2, unit: "small", mapped: true });
    assert.deepEqual(mapOrderUnit("ears", 4), { quantity: 4, unit: "ears", mapped: true });
  });

  it("weight / volume pack units send the TOTAL in Instacart's spelling", () => {
    // A 2-pack of 1.5 lb: the caller passes the total (3); the unit becomes pound.
    assert.deepEqual(mapOrderUnit("lb", 3), { quantity: 3, unit: "pound", mapped: true });
    assert.deepEqual(mapOrderUnit("pound", 1.5), { quantity: 1.5, unit: "pound", mapped: true });
    assert.deepEqual(mapOrderUnit("lbs", 2), { quantity: 2, unit: "pound", mapped: true });
    assert.deepEqual(mapOrderUnit("oz", 15), { quantity: 15, unit: "ounce", mapped: true });
    assert.deepEqual(mapOrderUnit("ounce", 8), { quantity: 8, unit: "ounce", mapped: true });
    assert.deepEqual(mapOrderUnit("pint", 1), { quantity: 1, unit: "pint", mapped: true });
    assert.deepEqual(mapOrderUnit("gram", 250), { quantity: 250, unit: "gram", mapped: true });
  });

  it("dozen becomes twelve each", () => {
    assert.deepEqual(mapOrderUnit("dozen", 1), { quantity: 12, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("dozen", 2), { quantity: 24, unit: "each", mapped: true });
  });

  it("container words become each at the pack count — the size stays in display_text", () => {
    assert.deepEqual(mapOrderUnit("container", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("bottle", 2), { quantity: 2, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("jar", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("bag", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("box", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("block", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("carton", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("loaf", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("piece", 3), { quantity: 3, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("tube", 1), { quantity: 1, unit: "each", mapped: true });
    assert.deepEqual(mapOrderUnit("wedge", 1), { quantity: 1, unit: "each", mapped: true });
  });

  it("is case- and whitespace-insensitive", () => {
    assert.deepEqual(mapOrderUnit(" LB ", 2), { quantity: 2, unit: "pound", mapped: true });
  });

  it("anything unlisted becomes each, unmapped, at the same quantity", () => {
    assert.deepEqual(mapOrderUnit("sheet", 2), { quantity: 2, unit: "each", mapped: false });
    // Measured need units are deliberately NOT order units: "2 teaspoon cumin"
    // is one jar, not two teaspoons in the cart.
    assert.deepEqual(mapOrderUnit("teaspoon", 2), { quantity: 2, unit: "each", mapped: false });
    assert.deepEqual(mapOrderUnit("cup", 1), { quantity: 1, unit: "each", mapped: false });
    assert.deepEqual(mapOrderUnit("clove", 3), { quantity: 3, unit: "each", mapped: false });
    assert.deepEqual(mapOrderUnit("", 1), { quantity: 1, unit: "each", mapped: false });
    assert.deepEqual(mapOrderUnit(null, 1), { quantity: 1, unit: "each", mapped: false });
  });

  it("size-bearing Instacart units are NOT in the table (Part D probes them)", () => {
    assert.equal(mapOrderUnit("oz can", 2).mapped, false);
    assert.equal(mapOrderUnit("lb bag", 1).mapped, false);
    assert.equal(mapOrderUnit("fl oz jar", 1).mapped, false);
  });

  it("rounds float noise to two decimals", () => {
    assert.deepEqual(mapOrderUnit("lb", 0.1 + 0.2), { quantity: 0.3, unit: "pound", mapped: true });
  });
});

describe("mapMeasurement — R4 (Part E2: true measures only)", () => {
  it("maps weight and volume need units", () => {
    assert.deepEqual(mapMeasurement("teaspoon", 2), { quantity: 2, unit: "teaspoon" });
    assert.deepEqual(mapMeasurement("tsp", 1), { quantity: 1, unit: "teaspoon" });
    assert.deepEqual(mapMeasurement("tablespoon", 3), { quantity: 3, unit: "tablespoon" });
    assert.deepEqual(mapMeasurement("cup", 1.5), { quantity: 1.5, unit: "cup" });
    assert.deepEqual(mapMeasurement("pound", 2), { quantity: 2, unit: "pound" });
    assert.deepEqual(mapMeasurement("lb", 1), { quantity: 1, unit: "pound" });
    assert.deepEqual(mapMeasurement("ounce", 9), { quantity: 9, unit: "ounce" });
    assert.deepEqual(mapMeasurement("oz", 4), { quantity: 4, unit: "ounce" });
    assert.deepEqual(mapMeasurement("gram", 100), { quantity: 100, unit: "gram" });
    assert.deepEqual(mapMeasurement("kg", 1), { quantity: 1, unit: "kilogram" });
    assert.deepEqual(mapMeasurement("pint", 1), { quantity: 1, unit: "pint" });
    assert.deepEqual(mapMeasurement("quart", 1), { quantity: 1, unit: "quart" });
    assert.deepEqual(mapMeasurement("ml", 250), { quantity: 250, unit: "milliliter" });
    assert.deepEqual(mapMeasurement("liter", 1), { quantity: 1, unit: "liter" });
    assert.deepEqual(mapMeasurement("gallon", 1), { quantity: 1, unit: "gallon" });
  });

  it("tbsp is not in Instacart list — it becomes tablespoon", () => {
    assert.deepEqual(mapMeasurement("tbsp", 2), { quantity: 2, unit: "tablespoon" });
  });

  it("COUNT need units yield NO measurement — the order line carries the count (E2)", () => {
    for (const u of ["each", "can", "cans", "bunch", "head", "large", "package", "packet", "dozen", "ears"]) {
      assert.equal(mapMeasurement(u, 2), null, `expected no measurement for "${u}"`);
    }
  });

  it("units with no Instacart equivalent yield NO measurement", () => {
    for (const u of [
      "clove", "cloves", "sprig", "slice", "pinch", "pod", "stalk", "pepper",
      "second", "jar", "bottle", "bag", "container", "loaf", "fl oz", "",
    ]) {
      assert.equal(mapMeasurement(u, 1), null, `expected no measurement for "${u}"`);
    }
  });

  it("a non-positive or non-finite quantity yields no measurement", () => {
    assert.equal(mapMeasurement("cup", 0), null);
    assert.equal(mapMeasurement("cup", Number.NaN), null);
  });
});
