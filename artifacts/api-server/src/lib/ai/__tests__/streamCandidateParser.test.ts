// Latency Block (D-WS9-076) — partial-JSON candidate scanner fuzz tests.
// Run via: pnpm --filter @workspace/api-server test
//
// The load-bearing property: extractCompleteCandidates must NEVER surface a
// candidate object that has not structurally closed (a half-drawn card is worse
// than waiting). We prove it by truncating a realistic response at EVERY byte
// offset and asserting the count exactly matches the number of candidates whose
// closing brace has been received — no more, no fewer — and that every returned
// object round-trips and passes the real WizardPlanCandidateSchema.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractCompleteCandidates } from "../streamCandidateParser";
import {
  WizardPlanCandidateSchema,
  type WizardPlanCandidate,
} from "../schemas/wizard";

// Candidates crafted with adversarial content the scanner must survive: title
// text containing `{ } [ ]` and escaped quotes (must NOT be read as structure),
// plus one candidate carrying a storeSlots array (nested objects).
const CANDIDATES: WizardPlanCandidate[] = [
  {
    id: "c1",
    title: 'Beans {spicy} [hot] "quoted" week',
    tags: ["Comfort", "Easy"],
    whyBullets: ["One-pot meals, minimal cleanup ]}", "Uses garlic {x3}"],
    mealTitles: ["Chili", "Tacos", "Rice bowl", "Soup", "Wraps"],
    dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
  },
  {
    id: "c2",
    title: "Mediterranean Variety",
    tags: ["Mediterranean"],
    whyBullets: ["Lemons across 4 meals"],
    mealTitles: ["Greek salad", "Salmon + quinoa", "Pesto pasta"],
    dailyMacros: { calories: 520, proteinG: 32, carbsG: 48, fatG: 24 },
    storeSlots: [
      { slotIndex: 0, storeMealId: "m12" },
      { slotIndex: 2, storeMealId: "m88" },
    ],
  },
  {
    id: "c3",
    title: "High-Protein Reset",
    tags: ["High Protein"],
    whyBullets: [">25g protein/night", "Chicken prepped once"],
    mealTitles: ["Herb chicken", "Steak", "Salmon", "Taco bowls", "Wraps"],
    dailyMacros: { calories: 560, proteinG: 42, carbsG: 32, fatG: 24 },
  },
];

// Assemble the full tool_use input string AND record the exclusive end offset
// of each candidate's closing brace, so we can compute the exact expected count
// at any truncation offset.
function assemble(): { full: string; endOffsets: number[] } {
  const parts = CANDIDATES.map((c) => JSON.stringify(c));
  const prefix = '{"candidates":[';
  const endOffsets: number[] = [];
  let cursor = prefix.length;
  parts.forEach((p, i) => {
    if (i > 0) cursor += 1; // the joining comma
    cursor += p.length;
    endOffsets.push(cursor); // exclusive index just past this candidate's `}`
  });
  const full = `${prefix}${parts.join(",")}],"cannotGenerateMore":false}`;
  return { full, endOffsets };
}

describe("extractCompleteCandidates — every-offset fuzz", () => {
  const { full, endOffsets } = assemble();

  it("never surfaces an unclosed candidate at any truncation offset", () => {
    let prevLen = 0;
    for (let offset = 0; offset <= full.length; offset++) {
      const got = extractCompleteCandidates(full.slice(0, offset));
      const expectedCount = endOffsets.filter((e) => e <= offset).length;

      assert.equal(
        got.length,
        expectedCount,
        `offset ${offset}: expected ${expectedCount} complete candidate(s), got ${got.length}`,
      );
      // Monotonic — a completed candidate never un-completes as bytes arrive.
      assert.ok(
        got.length >= prevLen,
        `offset ${offset}: count went backwards (${prevLen} → ${got.length})`,
      );
      prevLen = got.length;

      // Every returned object equals the source candidate AND passes the real
      // schema the render path gates on.
      for (let i = 0; i < got.length; i++) {
        assert.deepEqual(got[i], CANDIDATES[i], `offset ${offset}, candidate ${i}`);
        assert.ok(
          WizardPlanCandidateSchema.safeParse(got[i]).success,
          `offset ${offset}, candidate ${i} failed schema`,
        );
      }
    }
  });

  it("returns the full set once the whole response has arrived", () => {
    const got = extractCompleteCandidates(full);
    assert.equal(got.length, CANDIDATES.length);
    assert.deepEqual(got, CANDIDATES);
  });
});

describe("extractCompleteCandidates — edge cases", () => {
  it("returns [] before the candidates key/array has arrived", () => {
    assert.deepEqual(extractCompleteCandidates(""), []);
    assert.deepEqual(extractCompleteCandidates("{"), []);
    assert.deepEqual(extractCompleteCandidates('{"candi'), []);
    assert.deepEqual(extractCompleteCandidates('{"candidates":'), []);
    assert.deepEqual(extractCompleteCandidates('{"candidates":['), []);
    assert.deepEqual(extractCompleteCandidates('{"candidates":[{'), []);
  });

  it("tolerates a key emitted before candidates", () => {
    const s = '{"reason":"tight {constraints}","candidates":[';
    assert.deepEqual(extractCompleteCandidates(s), []);
    const c = JSON.stringify(CANDIDATES[0]);
    assert.deepEqual(extractCompleteCandidates(`${s}${c}`), [CANDIDATES[0]]);
  });

  it("stops at the array close and ignores trailing keys", () => {
    const c = JSON.stringify(CANDIDATES[0]);
    const s = `{"candidates":[${c}],"cannotGenerateMore":true}`;
    assert.deepEqual(extractCompleteCandidates(s), [CANDIDATES[0]]);
  });
});
