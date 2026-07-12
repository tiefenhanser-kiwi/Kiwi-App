// WS7-8b B2 conversion-backfill — pure-helper tests.
// node:test; no DB, no USDA. (main() is guarded behind an import.meta check.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  classifyRows,
  curatedRef,
  derivedRef,
  applyActionFromCsvFields,
  dryRunToCsvFields,
  stableStringify,
  CSV_HEADER,
  type CatalogRow,
} from "../../../scripts/ws7-8b-b2-conversion-backfill";

function matched(fdcId: number): unknown {
  return { basis: "per100g", per100g: { calories: 1, protein: 1, carbs: 1, fat: 1 }, source: "usda", fdcId, matched: undefined, dataType: "SR Legacy", foodCategory: null, fetchedAt: "2026-01-01T00:00:00Z" };
}
function missMarker(): unknown {
  return { source: "usda", matched: false, fetchedAt: "2026-01-01T00:00:00Z" };
}

describe("parseArgs", () => {
  it("defaults to dry-run", () => {
    assert.deepEqual(parseArgs([]), { mode: "dryrun", applyPath: null, help: false });
  });
  it("--apply requires a path", () => {
    assert.throws(() => parseArgs(["--apply"]), /requires a path/);
    assert.equal(parseArgs(["--apply", "x.csv"]).applyPath, "x.csv");
  });
  it("rejects unknown flags", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  });
});

describe("classifyRows", () => {
  it("curated wins over a USDA match", () => {
    const rows: CatalogRow[] = [
      { id: "1", canonicalName: "parmesan", nutritionRefPerUnit: matched(99) },
    ];
    const c = classifyRows(rows);
    assert.equal(c.curated.length, 1);
    assert.equal(c.usdaCandidates.length, 0);
  });
  it("a matched non-curated row is a USDA candidate carrying its fdcId", () => {
    const rows: CatalogRow[] = [
      { id: "2", canonicalName: "zucchini", nutritionRefPerUnit: matched(123) },
    ];
    const c = classifyRows(rows);
    assert.equal(c.usdaCandidates.length, 1);
    assert.equal(c.usdaCandidates[0].fdcId, 123);
  });
  it("miss-marker / null non-curated rows are plain misses", () => {
    const rows: CatalogRow[] = [
      { id: "3", canonicalName: "obscureherb", nutritionRefPerUnit: missMarker() },
      { id: "4", canonicalName: "anotherthing", nutritionRefPerUnit: null },
    ];
    const c = classifyRows(rows);
    assert.equal(c.plainMiss.length, 2);
    assert.equal(c.usdaCandidates.length, 0);
  });
});

describe("curatedRef / derivedRef", () => {
  it("curatedRef returns the code-table row stamped curated", () => {
    const r = curatedRef("parmesan");
    assert.equal(r?.source, "curated");
    assert.equal(r?.gramsPerCup, 100);
  });
  it("derivedRef null when no factor; stamped usda_derived otherwise", () => {
    assert.equal(derivedRef(null, null), null);
    const r = derivedRef(113, null);
    assert.deepEqual(r, { source: "usda_derived", confidence: "medium", gramsPerCup: 113 });
  });
});

describe("applyActionFromCsvFields", () => {
  const H = [...CSV_HEADER];
  void H;
  it("CURATED → write code-table ref", () => {
    const a = applyActionFromCsvFields(["id1", "parmesan", "CURATED", "", "", "", "", "curated"]);
    assert.equal(a.kind, "write");
    assert.equal(a.kind === "write" && a.ref.source, "curated");
  });
  it("USDA_DERIVED → write factors from CSV (respecting hand edits)", () => {
    const a = applyActionFromCsvFields(["id2", "zucchini", "USDA_DERIVED", "124", "196", "9", "Squash", ""]);
    assert.equal(a.kind, "write");
    assert.equal(a.kind === "write" && a.ref.gramsPerCup, 124);
    assert.equal(a.kind === "write" && a.ref.gramsPerEach, 196);
    assert.equal(a.kind === "write" && a.ref.source, "usda_derived");
  });
  it("MISS / missing id / bad decision → skip", () => {
    assert.equal(applyActionFromCsvFields(["id3", "x", "MISS", "", "", "", "", ""]).kind, "skip");
    assert.equal(applyActionFromCsvFields(["", "x", "CURATED", "", "", "", "", ""]).kind, "skip");
    assert.equal(applyActionFromCsvFields(["id4", "x", "WAT", "", "", "", "", ""]).kind, "skip");
  });
  it("USDA_DERIVED with no usable factor → skip", () => {
    assert.equal(applyActionFromCsvFields(["id5", "x", "USDA_DERIVED", "", "", "", "", ""]).kind, "skip");
  });
});

describe("stableStringify (idempotency)", () => {
  it("is key-order independent", () => {
    assert.equal(
      stableStringify({ source: "curated", gramsPerCup: 100 }),
      stableStringify({ gramsPerCup: 100, source: "curated" }),
    );
  });
});

describe("dryRunToCsvFields", () => {
  it("emits blanks for null factors", () => {
    const f = dryRunToCsvFields({
      row: { id: "i", canonicalName: "n", nutritionRefPerUnit: null },
      decision: "MISS",
      gramsPerCup: null,
      gramsPerEach: null,
      fdcId: null,
      usdaDescription: "",
      note: "x",
    });
    assert.deepEqual(f, ["i", "n", "MISS", "", "", "", "", "x"]);
  });
});
