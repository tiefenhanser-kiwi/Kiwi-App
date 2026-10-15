// PREP-1 F — A WEEK WITHOUT A FEAST IS THE WEEK IT WAS.
//
// prep1Regression.pre.json is the pre-PREP-1 engine's output (commit 54a1533) for
// the shared fixture week, through the route's sequence. Today's engine must give
// the same bytes except for exactly what Part A (BUG-413) changed:
//   • the engine-demoted steps are off the wire — here the avocado (browns once cut)
//     and the cherry tomatoes (nothing to cut), both `skipSuggested` before, so never
//     rendered;
//   • `totalEstimatedMinutes` no longer counts them: 21 → 19;
//   • the composition fingerprint moves by the engine version alone (7 → 8).
// The narration input — and so the prose the model is paid to write — is identical.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { PrepWeekResultSchema, type PrepWeekResult } from "../ai/schemas/prepWeek";
import { assemblePrepWeekResult, summarizePrepWeek } from "../prepWeekAssembly";
import { buildCoreWeek, finishPrepWeek } from "../prepWeekBuild";
import { PREP_ENGINE_VERSION, prepCompositionFingerprint } from "../prepWeekFingerprint";
import { makeAheadForPlan } from "../makeAheadSchedule";
import { regressionWeek, stubNarration } from "./fixtures/prep1Regression";
import PRE from "./fixtures/prep1Regression.pre.json" with { type: "json" };

const AVOCADO = "produce#a0000000-0000-4000-8000-000000000010";
const CHERRY_TOMATOES = "produce#a0000000-0000-4000-8000-000000000011";

const load = regressionWeek() as LoadPrepWeekInputResult;
// The route's own sequence for a full week (cooking.ts): buildCoreWeek, which for a
// plan without a feast is the unscoped whole-plan build.
const build = buildCoreWeek(load);
const result = summarizePrepWeek(
  finishPrepWeek(PrepWeekResultSchema.parse(assemblePrepWeekResult(build.stepPlan, stubNarration(build.stepPlan.narrationInput.steps))), build),
);
const pre = PRE as unknown as { fingerprint: string; narrationInput: unknown; result: PrepWeekResult };
const steps = (r: PrepWeekResult) => r.phases.flatMap((p) => p.steps);

describe("PREP-1 F — a plan with no thanksgiving-feast is unchanged but for Part A", () => {
  it("no feast: no makeAhead, and no dish query to find out", async () => {
    const reads: unknown[] = [];
    const makeAhead = await makeAheadForPlan(
      { dish: { findMany: async (a: unknown) => (reads.push(a), []) } } as never,
      {
        startDate: new Date("2026-10-05T00:00:00Z"),
        items: load.input.meals.map((m, i) => ({
          id: `item-${i}`,
          mealId: m.mealId,
          assignedDayOfWeek: null,
          meal: { tags: ["american", "easy"], dishes: m.dishes.map((d) => ({ dishId: d.dishId, title: d.dishName, steps: [] })) },
        })),
      },
    );
    assert.equal(makeAhead, null);
    assert.equal(reads.length, 0);
  });

  it("the narration input is byte-identical", () => {
    assert.equal(JSON.stringify(build.stepPlan.narrationInput), JSON.stringify(pre.narrationInput));
  });

  it("the result is byte-identical once the two engine-demoted steps and their minutes are taken out", () => {
    // What Part A removed: exactly the engine's demotions, each one never rendered before.
    const gone = steps(pre.result).filter((s) => !steps(result).some((t) => t.stepKey === s.stepKey));
    assert.deepEqual(gone.map((s) => s.stepKey), [AVOCADO, CHERRY_TOMATOES]);
    assert.ok(gone.every((s) => s.skipSuggested === true));
    assert.deepEqual(build.stepPlan.steps.filter((s) => s.demoted).map((s) => s.stepKey).sort(), [AVOCADO, CHERRY_TOMATOES]);
    assert.equal(pre.result.totalEstimatedMinutes, 21);
    assert.equal(result.totalEstimatedMinutes, 19);

    const expected: PrepWeekResult = {
      ...pre.result,
      totalEstimatedMinutes: 19,
      phases: pre.result.phases.map((p) => ({ ...p, steps: p.steps.filter((s) => s.stepKey !== AVOCADO && s.stepKey !== CHERRY_TOMATOES) })),
    };
    assert.equal(JSON.stringify(result), JSON.stringify(expected));
  });

  it("the fingerprint moved by the engine version alone (7 → 8): the hashed input is the same", () => {
    const hash = (engine: number) =>
      createHash("sha256").update(JSON.stringify({ v: 1, engine, input: load.input })).digest("hex");
    assert.equal(PREP_ENGINE_VERSION, 8);
    assert.equal(hash(7), pre.fingerprint);
    assert.equal(prepCompositionFingerprint(load.input), hash(8));
  });
});
