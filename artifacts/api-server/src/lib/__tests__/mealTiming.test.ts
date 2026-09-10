// WS9 D-WS9-235 — deriveMealTiming unit tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveMealTiming } from "../mealTiming";
import { materializeMeal } from "../mealMaterialize";
import type { SchedulerDish } from "../cookingScheduler";

function dish(
  dishId: string,
  steps: { min: number; phase?: "prep" | "cook" | "rest" | "assemble" | "preheat" | "hold"; sensitive?: boolean }[],
  positionIndex = 0,
): SchedulerDish {
  return {
    dishId,
    title: dishId,
    positionIndex,
    steps: steps.map((s, i) => ({
      stepIndex: i,
      estimatedMinutes: s.min,
      phaseType: s.phase ?? "cook",
      isTimingSensitive: s.sensitive ?? false,
    })),
  };
}

describe("deriveMealTiming (D-WS9-235)", () => {
  it("Hans's acceptance example: 20-min bake beside a 10-min sauté", () => {
    const t = deriveMealTiming([
      dish("bake", [{ min: 20, phase: "cook", sensitive: false }], 0),
      dish("saute", [{ min: 10, phase: "cook", sensitive: true }], 1),
    ]);
    assert.equal(t.totalMinutes, 20, "the sauté overlaps the unattended bake");
    assert.equal(t.activeMinutes, 10, "only the watched sauté costs hands");
    assert.deepEqual([...t.dishTotals.entries()].sort(), [["bake", 20], ["saute", 10]]);
  });

  it("a single-dish meal's total is its serial sum", () => {
    // One dish, nothing to overlap with: every step runs back to back.
    const t = deriveMealTiming([
      dish("solo", [
        { min: 5, phase: "prep" },
        { min: 58, phase: "cook", sensitive: false },
        { min: 10, phase: "rest" },
      ]),
    ]);
    assert.equal(t.totalMinutes, 73, "5 + 58 + 10");
    // prep is hands-on; the bake and the rest are not.
    assert.equal(t.activeMinutes, 5);
    assert.equal(t.dishTotals.get("solo"), 73);
  });

  it("returns NULLS, never zeros, when nothing is derivable", () => {
    // THE DISTINCTION IS LOAD-BEARING: 0 is a claim that the meal takes no
    // time, and a caller writing that into estimatedTimeMinutes would replace
    // an unverified number with a definitely-wrong one. Null means "I cannot
    // say" and the caller keeps what it had.
    for (const input of [[], [dish("empty", [])]]) {
      const t = deriveMealTiming(input);
      assert.equal(t.totalMinutes, null);
      assert.equal(t.activeMinutes, null);
      assert.equal(t.dishTotals.size, 0);
    }
  });

  it("a dish with no steps does not drag the meal's total to zero", () => {
    // A real shape: one dish fully specified, a sibling that never got steps.
    const t = deriveMealTiming([
      dish("real", [{ min: 30, phase: "cook", sensitive: true }], 0),
      dish("stepless", [], 1),
    ]);
    assert.equal(t.totalMinutes, 30);
    assert.equal(t.activeMinutes, 30);
    assert.equal(t.dishTotals.has("stepless"), false, "no total for a dish with no steps");
  });
});

// ── WS9 D-WS9-235 — DERIVE AT SAVE, end to end through materializeMeal ──────
//
// The unit tests above prove the arithmetic. This proves the HOOK: that the
// number actually persisted for a materialised meal is the derived one and not
// the generator's. Without it, deleting the stampMealTiming call would leave
// every test green while every saved meal went back to claiming 30 minutes
// against a 58-minute bake — which is precisely BUG-245.
//
// The stub reads back what it wrote (findMany returns the createdSteps), so the
// "derive from the persisted graph" contract is exercised rather than assumed.
describe("D-WS9-235 — materializeMeal stamps the DERIVED time", () => {
  it("a 58-minute bake overrides the authored 30", async () => {
    const createdSteps: Array<Record<string, unknown>> = [];
    const mealUpdates: Array<Record<string, unknown>> = [];
    const dishUpdates: Array<Record<string, unknown>> = [];
    let dishSeq = 0;
    const fakeTx = {
      meal: {
        create: async () => ({ id: "meal-1" }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          mealUpdates.push(data);
          return {};
        },
        findUnique: async (args: { select?: Record<string, unknown> }) =>
          args.select && "dishLinks" in args.select
            ? { dishLinks: [] }
            : { allergens: [], allergenSources: null, allergensStampedAt: null },
      },
      dish: {
        create: async () => ({ id: `dish-${dishSeq++}` }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          dishUpdates.push(data);
          return {};
        },
      },
      mealDishLink: { create: async () => ({}), findMany: async () => [] },
      dishIngredient: { create: async () => ({}) },
      recipeInstructionStep: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdSteps.push(data);
          return {};
        },
        // Read back exactly what was written — the contract stampMealTiming
        // relies on, and the reason it reads the graph instead of the payload.
        findMany: async () =>
          createdSteps.map((d) => ({
            ownerId: d.ownerId as string,
            stepIndex: d.stepIndex as number,
            estimatedMinutes: (d.estimatedMinutes as number) ?? 1,
            phaseType: (d.phaseType as string) ?? "cook",
            isTimingSensitive: (d.isTimingSensitive as boolean) ?? false,
          })),
      },
    };

    await materializeMeal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeTx as any,
      "user-1",
      {
        title: "Meatloaf",
        // The generator's claim — the exact shape BUG-245 found live.
        estimatedTimeMinutes: 30,
        sourceType: "wizard",
        dishes: [
          {
            kind: "new",
            title: "Glazed Beef Meatloaf",
            role: "main",
            ingredients: [{ name: "ground beef", quantity: 1.5, unit: "lb" }],
            steps: [
              { text: "Dice the onion.", estimatedMinutes: 5, phaseType: "prep", isTimingSensitive: false },
              { text: "Bake at 375F for 55-60 minutes.", estimatedMinutes: 58, phaseType: "cook", isTimingSensitive: false },
              { text: "Rest 10 minutes.", estimatedMinutes: 10, phaseType: "rest", isTimingSensitive: false },
            ],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      new Map([["ground beef", "ing-0"]]),
    );

    const timed = mealUpdates.find((u) => "estimatedTimeMinutes" in u);
    assert.ok(timed, "materializeMeal must stamp a derived time");
    // 5 + 58 + 10 run back to back in one dish.
    assert.equal(timed!.estimatedTimeMinutes, 73, "the DERIVED total, not the authored 30");
    // Only the 5-minute prep is hands-on; the bake and the rest are not.
    assert.equal(timed!.activeTimeMinutes, 5);
    // The dish scalar moves with it.
    assert.ok(
      dishUpdates.some((d) => d.estimatedTimeMinutes === 73),
      "the dish's own total is stamped too",
    );
  });
});
