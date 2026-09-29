// [grocery] B4 (D-WS9-286) — THE SHEET GUARDS ITSELF.
//
// B3·F found a pack yield computed as `net oz ÷ 8`, which treats a weight ounce
// as a fluid ounce, over-states the pack by 4.3% and therefore UNDER-buys. The
// sheet that replaced it loads 95 figures; this is the check that none of them
// was arrived at the same way, and that the four rules were followed.
//
// It reads the data file directly rather than the database, because the defect
// is in the ARITHMETIC that produced the number, and that arithmetic is visible
// only in the source string the sheet carries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { YIELD_LOADS } from "../../../scripts/grocery-b4/proposals";

/** Every "<n> oz"/"<n> lb" size a source string quotes from a pack label. */
function weightSizesIn(source: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(oz|ounces?|lb|lbs|pounds?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const n = Number(m[1]);
    out.push(/^lb|^pound/i.test(m[2]) ? n * 16 : n);
  }
  return out;
}

describe("[grocery] B4 — the yield sheet", () => {
  it("loads something, and every row is well formed", () => {
    assert.ok(YIELD_LOADS.length > 0);
    for (const y of YIELD_LOADS) {
      assert.ok(y.canonical.length > 0, "a canonical");
      assert.ok(y.unit.length > 0, `${y.canonical}: a unit`);
      assert.ok(y.perPack > 0, `${y.canonical}: a positive yield`);
      assert.ok(y.source.length > 0, `${y.canonical}: a source`);
    }
  });

  it("⚠️ NO CUP YIELD IS A NET-WEIGHT SIZE DIVIDED BY 8 — the B3·F defect, encoded", () => {
    // 14.5 ÷ 8 = 1.8125 was the broth figure, and the can holds 1.75.
    //
    // ⚠️ AND ÷ 8 IS NOT WRONG IN ITSELF — one FLUID ounce is exactly an eighth
    // of a cup, so 17 fl oz ÷ 8 = 2.125 is the right arithmetic for a bottle of
    // oil. What is wrong is doing it to a NET WEIGHT. The first version of this
    // guard flagged olive oil, neutral oil and vegetable oil, all three correct,
    // because it looked at the division and not at what was being divided.
    //
    // So the offence is: a cup yield equal to a size ÷ 8 on a row that did NOT
    // take the fluid reading from a container filled by volume.
    const offenders: string[] = [];
    for (const y of YIELD_LOADS) {
      if (!y.unit.startsWith("cup")) continue;
      if (/read as FLUID oz \(a (bottle|carton|jug) is filled by volume\)/.test(y.source)) continue;
      for (const oz of weightSizesIn(y.source)) {
        if (Math.abs(oz / 8 - y.perPack) < 1e-6) {
          offenders.push(`${y.canonical}: ${oz} oz ÷ 8 = ${y.perPack} cup — ${y.source}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("every cup yield derived from a WEIGHT names the density it used", () => {
    // Rule 4: a weight size needs a density. A cup figure quoting an oz size and
    // no `gramsPerCup` was guessed.
    for (const y of YIELD_LOADS) {
      if (!y.unit.startsWith("cup")) continue;
      if (weightSizesIn(y.source).length === 0) continue;
      assert.match(
        y.source,
        /gramsPerCup \d/,
        `${y.canonical} states a weight size but names no density: ${y.source}`,
      );
    }
  });

  it("a fluid reading is only ever taken from a bottle, carton or jug", () => {
    // "oz" on a tub of sour cream is net weight; on a bottle of oil it is fluid
    // ounces. Reading a bag or a wedge as fluid made a 5 oz bag of shredded
    // iceberg 0.625 cups and ordered four of them for two cups of leaves.
    for (const y of YIELD_LOADS) {
      if (!/read as FLUID/.test(y.source)) continue;
      assert.match(
        y.source,
        /a (bottle|carton|jug) is filled by volume/,
        `${y.canonical} took a fluid reading from something that is not filled by volume: ${y.source}`,
      );
    }
  });

  it("a count yield is stated in `each` — the unit the recipes use", () => {
    // Naming the child unit "scallion" makes toSubUnitChild ask
    // convertWithinDimension("each","scallion"), which is null, so the ladder
    // silently does nothing and the yield changes no arithmetic at all.
    for (const y of YIELD_LOADS) {
      if (!/\d+\s*(ct|count|slices?|scallions?|stalks?|sprigs?|radishes)\b/i.test(y.source)) continue;
      assert.equal(y.unit, "each", `${y.canonical} is a count yield and must be stated in each`);
    }
  });

  it("a range took its LOWER bound", () => {
    for (const y of YIELD_LOADS) {
      const m = /\((\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(oz|ounces?|ct|count)/i.exec(y.source);
      if (!m) continue;
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      assert.ok(
        y.perPack <= (lo + hi) / 2,
        `${y.canonical} states a range ${lo}-${hi} and must buy on the lower bound, not ${y.perPack}`,
      );
    }
  });

  it("no two rows claim the same canonical", () => {
    const names = YIELD_LOADS.map((y) => y.canonical);
    assert.equal(new Set(names).size, names.length, "one figure per food");
  });
});
