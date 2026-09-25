// Row 13 "Test Kitchen" · Block 1 (D-WS9-260) — catalog-only expand.
//
// 🔴 THE CLAIM UNDER TEST IS NOT "the response says catalog_only_gap".
// It is "runAICall WAS NOT CALLED", asserted on the DI seam's call count.
// Phase 0 flagged exactly this: CC's claim that a catalog-only expand makes
// zero AI calls is to be TESTED, not assumed — a guard that returns the right
// shape after spending $0.065 would pass a response-only assertion and fail
// the thing the guard exists for.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { expandCandidate } from "../wizardExpansion";
import type { runAICall as RunAICall } from "../ai/runAICall";
import type { WizardExpandRequest } from "../ai/schemas/wizard";

// ── the seam under observation ───────────────────────────────────────────
let aiCalls: string[] = [];
const countingRunAICall = (async (promptKey: string) => {
  aiCalls.push(promptKey);
  // If the guard ever lets a call through, fail LOUDLY rather than returning a
  // plausible stub — a silent stub would let a broken guard look healthy.
  throw new Error(
    `runAICall reached the model on a catalog-only expand: ${promptKey}`,
  );
}) as unknown as typeof RunAICall;

const countingEstimateMacros = (async () => {
  aiCalls.push("dishMacros");
  throw new Error("estimateDishMacros reached the model on a catalog-only expand");
}) as never;

// ── the minimum prisma the pre-AI section of expandCandidate touches ─────
//
// A meal that composeStoreMealDetails can actually use: it insists on at least
// one dishLink and at least one ingredient on each (the wizard schema's
// .min(1)), and builds the slot field-by-field from this exact select.
function catalogMeal(id: string) {
  return {
    id,
    title: `Catalog meal ${id}`,
    description: "A meal from the shelf",
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    servingsDefault: 2,
    dishLinks: [
      {
        positionIndex: 0,
        roleLabel: "main",
        dish: {
          title: `Dish for ${id}`,
          caloriesPerServing: 500,
          proteinGPerServing: 30,
          carbsGPerServing: 40,
          fatGPerServing: 20,
          dishIngredients: [
            {
              quantity: 1,
              unit: "cup",
              preparationNote: null,
              isOptional: false,
              ingredient: { displayName: "tomato" },
            },
          ],
        },
      },
    ],
  };
}

function makePrisma(storeMealIds: Set<string>) {
  return {
    userPreferences: { findUnique: async () => null },
    playlistMeal: { count: async () => 0 },
    meal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        storeMealIds.has(where.id) ? catalogMeal(where.id) : null,
    },
  } as unknown as PrismaClient;
}

function request(
  mealTitles: string[],
  storeSlots: { slotIndex: number; storeMealId: string }[],
): WizardExpandRequest {
  return {
    candidate: {
      id: "cand-1",
      title: "A catalog week",
      mealTitles,
      tags: [],
      whyBullets: ["because"],
      storeSlots,
    },
    candidateContext: {
      householdSize: 2,
      planDurationDays: mealTitles.length,
      difficulty: "easy",
      weeklyPacing: "mostly_easy",
      cuisines: [],
      eatingStyles: [],
      allergiesAndAvoidances: [],
    },
  } as unknown as WizardExpandRequest;
}

beforeEach(() => {
  aiCalls = [];
});

describe("expandCandidate({ catalogOnly: true })", () => {
  it("ONE live slot → catalog_only_gap, and runAICall is called ZERO times", async () => {
    // Two slots the catalog CAN fill, one it cannot: the real thin-shelf
    // shape, not an all-empty degenerate case. The guard must fire on the one
    // gap even though most of the plan was satisfiable.
    const result = await expandCandidate({
      prisma: makePrisma(new Set(["m-1", "m-2"])),
      userId: "gs-guest-1",
      guestSessionId: "gs-guest-1",
      catalogOnly: true,
      request: request(
        ["Catalog A", "Catalog B", "Invented C"],
        [
          { slotIndex: 0, storeMealId: "m-1" },
          { slotIndex: 1, storeMealId: "m-2" },
        ],
      ),
      runAICall: countingRunAICall,
      estimateDishMacrosImpl: countingEstimateMacros,
    });

    assert.equal(
      result.status,
      "catalog_only_gap",
      `expected the thin-shelf door, got ${result.status}`,
    );
    // 🔴 THE ASSERTION THAT MATTERS.
    assert.deepEqual(
      aiCalls,
      [],
      `the catalog-only guard let ${aiCalls.length} AI call(s) through: ${aiCalls.join(", ")}`,
    );

    if (result.status === "catalog_only_gap") {
      assert.ok(
        result.liveSlotTitles.includes("Invented C"),
        "the door names the title the catalog could not supply",
      );
      assert.equal(result.liveSlotTitles.length, 1, "only the gap is named");
      assert.equal(
        result.storeSlotCount,
        2,
        "the door reports how far the catalog DID get",
      );
    }
  });

  it("the guard is CATALOG-ONLY, not a global off switch: without the flag the same input reaches the model", async () => {
    // The counterpart, and it is what stops the guard silently disabling the
    // live path for signed-in users — the product they are paying for.
    await assert.rejects(
      () =>
        expandCandidate({
          prisma: makePrisma(new Set()),
          userId: "u-real",
          catalogOnly: false,
          request: request(["Invented C"], []),
          runAICall: countingRunAICall,
          estimateDishMacrosImpl: countingEstimateMacros,
        }),
      /reached the model/,
    );
    assert.equal(aiCalls.length, 1, "a live slot for a USER still expands");
    assert.equal(aiCalls[0], "wizard.candidate.expand");
  });
});
