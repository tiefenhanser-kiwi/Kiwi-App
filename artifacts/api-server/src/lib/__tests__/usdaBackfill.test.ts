// WS7-8b USDA Block 2 — backfill script unit tests.
// Run via: pnpm --filter @workspace/api-server test
// node:test; pure functions only — NO live USDA, NO live Anthropic, NO DB.
// (The script guards main() behind an import.meta check, so importing it here
//  does not execute anything.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  selectInScope,
  decideForIngredient,
  BackfillAbortError,
  encodeCsvRow,
  parseCsv,
  csvEscape,
  decisionToCsvFields,
  applyActionFromCsvFields,
  applyDataForAction,
  parseAiPickReply,
  CSV_HEADER,
  type CatalogRow,
  type AiPickFn,
  type SearchFn,
  type DecisionResult,
} from "../../../scripts/ws7-8b-usda-backfill";
import type { FdcFood } from "../usda/fdcClient";

// ── fixtures ────────────────────────────────────────────────────────────

function completeFood(overrides: Partial<FdcFood> = {}): FdcFood {
  return {
    fdcId: 100,
    description: "Onions, raw",
    dataType: "SR Legacy",
    foodNutrients: [
      { nutrient: { number: "208", unitName: "KCAL" }, amount: 40 },
      { nutrient: { number: "203", unitName: "G" }, amount: 1.1 },
      { nutrient: { number: "204", unitName: "G" }, amount: 0.1 },
      { nutrient: { number: "205", unitName: "G" }, amount: 9.3 },
    ],
    ...overrides,
  };
}
function incompleteFood(overrides: Partial<FdcFood> = {}): FdcFood {
  return {
    fdcId: 200,
    description: "Chicken, cooked",
    dataType: "SR Legacy",
    foodNutrients: [{ nutrient: { number: "208", unitName: "KCAL" }, amount: 190 }],
    ...overrides,
  };
}

const okSearch =
  (foods: FdcFood[]): SearchFn =>
  async () => ({ ok: true, data: foods });
const failSearch =
  (): SearchFn =>
  async () => ({ ok: false, reason: "rate_limited", status: 429 });
const aiPick =
  (result: { pick: number | null; reason: string }): AiPickFn =>
  async () => result;
const NEVER_AI: AiPickFn = async () => {
  throw new Error("aiPick should not be called");
};

// ── parseArgs ───────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("defaults to dry-run with no flags", () => {
    const a = parseArgs([]);
    assert.equal(a.mode, "dryrun");
    assert.equal(a.retryMisses, false);
    assert.equal(a.refreshStaleBefore, null);
  });
  it("parses --retry-misses and --refresh-stale", () => {
    const a = parseArgs(["--retry-misses", "--refresh-stale", "2026-04-06"]);
    assert.equal(a.retryMisses, true);
    assert.equal(a.refreshStaleBefore?.toISOString().slice(0, 10), "2026-04-06");
  });
  it("parses --apply <path>", () => {
    const a = parseArgs(["--apply", "scripts/output/x.csv"]);
    assert.equal(a.mode, "apply");
    assert.equal(a.applyPath, "scripts/output/x.csv");
  });
  it("throws on a bad date, missing apply path, and unknown args", () => {
    assert.throws(() => parseArgs(["--refresh-stale", "not-a-date"]));
    assert.throws(() => parseArgs(["--apply"]));
    assert.throws(() => parseArgs(["--wat"]));
  });
});

// ── selectInScope ───────────────────────────────────────────────────────

describe("selectInScope", () => {
  const rows: CatalogRow[] = [
    { id: "null-1", canonicalName: "onion", displayName: "Onion", nutritionRefPerUnit: null },
    {
      id: "miss-1",
      canonicalName: "harissa",
      displayName: "Harissa",
      nutritionRefPerUnit: { source: "usda", matched: false, fetchedAt: "2026-05-01T00:00:00.000Z" },
    },
    {
      id: "matched-old",
      canonicalName: "garlic",
      displayName: "Garlic",
      nutritionRefPerUnit: {
        basis: "per100g",
        per100g: { calories: 1, protein: 1, carbs: 1, fat: 1 },
        source: "usda",
        fdcId: 1,
        dataType: "SR Legacy",
        foodCategory: null,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      id: "matched-new",
      canonicalName: "salt",
      displayName: "Salt",
      nutritionRefPerUnit: {
        basis: "per100g",
        per100g: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        source: "usda",
        fdcId: 2,
        dataType: "SR Legacy",
        foodCategory: null,
        fetchedAt: "2026-07-01T00:00:00.000Z",
      },
    },
  ];

  it("default scope: null rows only", () => {
    const got = selectInScope(rows, { retryMisses: false, refreshStaleBefore: null });
    assert.deepEqual(got.map((r) => r.id), ["null-1"]);
  });
  it("--retry-misses adds miss-marker rows", () => {
    const got = selectInScope(rows, { retryMisses: true, refreshStaleBefore: null });
    assert.deepEqual(got.map((r) => r.id).sort(), ["miss-1", "null-1"]);
  });
  it("--refresh-stale adds only matched rows older than the cutoff", () => {
    const got = selectInScope(rows, {
      retryMisses: false,
      refreshStaleBefore: new Date("2026-04-01T00:00:00.000Z"),
    });
    assert.deepEqual(got.map((r) => r.id).sort(), ["matched-old", "null-1"]);
  });
  it("flags combine (null + misses + stale matched)", () => {
    const got = selectInScope(rows, {
      retryMisses: true,
      refreshStaleBefore: new Date("2026-04-01T00:00:00.000Z"),
    });
    assert.deepEqual(got.map((r) => r.id).sort(), ["matched-old", "miss-1", "null-1"]);
  });
});

// ── decideForIngredient routing ─────────────────────────────────────────

describe("decideForIngredient", () => {
  it("AUTO when the guardrail auto-accepts", async () => {
    const d = await decideForIngredient("onion", { search: okSearch([completeFood()]), aiPick: NEVER_AI });
    assert.equal(d.decision, "AUTO");
    assert.equal(d.food?.fdcId, 100);
    assert.deepEqual(d.per100g, { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 });
  });

  it("MISS when there are zero candidates (no AI call)", async () => {
    const d = await decideForIngredient("unobtanium", { search: okSearch([]), aiPick: NEVER_AI });
    assert.equal(d.decision, "MISS");
    assert.equal(d.candidateCount, 0);
  });

  it("AI_PICK when guardrail rejects but AI picks a complete-macro candidate", async () => {
    // "chicken breast" vs "Chicken, cooked" — 'breast' absent → guardrail miss.
    const food = completeFood({ fdcId: 300, description: "Chicken, cooked" });
    const d = await decideForIngredient("chicken breast", {
      search: okSearch([food]),
      aiPick: aiPick({ pick: 0, reason: "closest generic cooked chicken" }),
    });
    assert.equal(d.decision, "AI_PICK");
    assert.equal(d.food?.fdcId, 300);
    assert.equal(d.aiReason, "closest generic cooked chicken");
  });

  it("MISS when AI returns null", async () => {
    const food = completeFood({ description: "Chicken, cooked" });
    const d = await decideForIngredient("chicken breast", {
      search: okSearch([food]),
      aiPick: aiPick({ pick: null, reason: "no clear match" }),
    });
    assert.equal(d.decision, "MISS");
    assert.equal(d.aiReason, "no clear match");
  });

  it("MISS when AI picks a candidate with incomplete macros (no fall-through)", async () => {
    const d = await decideForIngredient("chicken breast", {
      search: okSearch([incompleteFood()]),
      aiPick: aiPick({ pick: 0, reason: "looks right" }),
    });
    assert.equal(d.decision, "MISS");
    assert.match(d.aiReason, /incomplete/);
  });

  it("MISS when AI pick index is out of range", async () => {
    const d = await decideForIngredient("chicken breast", {
      search: okSearch([completeFood({ description: "Chicken, cooked" })]),
      aiPick: aiPick({ pick: 5, reason: "oops" }),
    });
    assert.equal(d.decision, "MISS");
  });

  it("throws BackfillAbortError on a USDA search failure", async () => {
    await assert.rejects(
      () => decideForIngredient("onion", { search: failSearch(), aiPick: NEVER_AI }),
      BackfillAbortError,
    );
  });
});

// ── parseAiPickReply ────────────────────────────────────────────────────

describe("parseAiPickReply", () => {
  it("parses a clean JSON object", () => {
    assert.deepEqual(parseAiPickReply('{"pick": 2, "reason": "ok"}'), { pick: 2, reason: "ok" });
  });
  it("extracts JSON embedded in prose/fences", () => {
    assert.deepEqual(parseAiPickReply('here:\n```json\n{"pick": null, "reason": "none"}\n```'), {
      pick: null,
      reason: "none",
    });
  });
  it("coerces a non-integer pick to null and defaults reason", () => {
    assert.deepEqual(parseAiPickReply('{"pick": "two"}'), { pick: null, reason: "" });
  });
  it("returns a safe MISS on unparseable text", () => {
    assert.deepEqual(parseAiPickReply("no json here"), { pick: null, reason: "unparseable AI reply" });
  });
});

// ── CSV round-trip (descriptions contain commas) ────────────────────────

describe("CSV encode/parse round-trip", () => {
  it("quotes and recovers fields containing commas and quotes", () => {
    assert.equal(csvEscape("Onions, raw"), '"Onions, raw"');
    assert.equal(csvEscape('has "quote"'), '"has ""quote"""');
    const encoded = encodeCsvRow(["a", "Onions, raw", 'x "y"', 3]);
    const parsed = parseCsv(encoded);
    assert.deepEqual(parsed[0], ["a", "Onions, raw", 'x "y"', "3"]);
  });

  it("round-trips a full dry-run row through to an apply action", () => {
    const row: CatalogRow = {
      id: "ing-42",
      canonicalName: "onion",
      displayName: "Onion",
      nutritionRefPerUnit: null,
    };
    const decision: DecisionResult = {
      decision: "AUTO",
      food: { fdcId: 100, description: "Onions, raw", dataType: "SR Legacy" },
      per100g: { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 },
      aiReason: "",
      candidateCount: 7,
    };
    const csv = [
      encodeCsvRow([...CSV_HEADER]),
      encodeCsvRow(decisionToCsvFields(row, decision)),
    ].join("\n");
    const rows = parseCsv(csv);
    assert.equal(rows.length, 2);
    // Header intact.
    assert.equal(rows[0][0], "ingredientId");
    // The comma in "Onions, raw" survived.
    assert.equal(rows[1][4], "Onions, raw");

    const action = applyActionFromCsvFields(rows[1], "2026-07-06T12:00:00.000Z");
    assert.equal(action.kind, "write-match");
    if (action.kind === "write-match") {
      assert.equal(action.ingredientId, "ing-42");
      assert.equal(action.record.fdcId, 100);
      assert.deepEqual(action.record.per100g, { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 });
      // foodCategory is null on apply (not carried in the CSV — Ruling 4 metadata).
      assert.equal(action.record.foodCategory, null);
      assert.equal(action.record.fetchedAt, "2026-07-06T12:00:00.000Z");
    }
  });
});

// ── apply actions ───────────────────────────────────────────────────────

describe("applyActionFromCsvFields", () => {
  const fetchedAt = "2026-07-06T12:00:00.000Z";
  const matchFields = ["ing-1", "onion", "AUTO", "100", "Onions, raw", "SR Legacy", "40", "1.1", "9.3", "0.1", "", "7"];

  it("MISS decision → miss-marker", () => {
    const a = applyActionFromCsvFields(["ing-2", "harissa", "MISS", "", "", "", "", "", "", "", "no match", "3"], fetchedAt);
    assert.equal(a.kind, "write-miss");
    if (a.kind === "write-miss") {
      assert.deepEqual(a.marker, { source: "usda", matched: false, fetchedAt });
    }
  });

  it("invalid on missing ingredientId or non-numeric macros", () => {
    assert.equal(applyActionFromCsvFields(["", "x", "AUTO"], fetchedAt).kind, "invalid");
    const bad = [...matchFields];
    bad[6] = "NaN-cal";
    assert.equal(applyActionFromCsvFields(bad, fetchedAt).kind, "invalid");
  });

  it("is idempotent for the same fields + fetchedAt", () => {
    const a1 = applyActionFromCsvFields(matchFields, fetchedAt);
    const a2 = applyActionFromCsvFields(matchFields, fetchedAt);
    assert.deepEqual(a1, a2);
  });
});

describe("applyDataForAction — category invariant (Ruling 4)", () => {
  it("write-match update touches ONLY nutritionRefPerUnit", () => {
    const a = applyActionFromCsvFields(
      ["ing-1", "onion", "AUTO", "100", "Onions, raw", "SR Legacy", "40", "1.1", "9.3", "0.1", "", "7"],
      "2026-07-06T12:00:00.000Z",
    );
    const data = applyDataForAction(a);
    assert.ok(data);
    assert.deepEqual(Object.keys(data as object), ["nutritionRefPerUnit"]);
  });
  it("write-miss update touches ONLY nutritionRefPerUnit", () => {
    const a = applyActionFromCsvFields(["ing-2", "harissa", "MISS"], "2026-07-06T12:00:00.000Z");
    const data = applyDataForAction(a);
    assert.deepEqual(Object.keys(data as object), ["nutritionRefPerUnit"]);
  });
  it("invalid action → null data (no write)", () => {
    const a = applyActionFromCsvFields(["", "x", "AUTO"], "2026-07-06T12:00:00.000Z");
    assert.equal(applyDataForAction(a), null);
  });
});
