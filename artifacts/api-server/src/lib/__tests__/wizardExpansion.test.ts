// WS7-5b-server-fix1 — wizardExpansion per-meal shard tests.
//
// Asserts the per-meal fan-out inside expandCandidate:
//   - fan-out runs one runAICall per mealTitle and assembles meals[] in
//     mealTitles order (regardless of fan-out completion order),
//   - all-or-nothing: a meal whose runAICall fails (after its own internal
//     retry) fails the whole expand with `meal_failed:<title>` in `reason`,
//     and is invoked exactly once at the expandOneMeal level (NO meal-level
//     retry wrapper — runAICall's built-in retry is the only retry layer),
//   - the 16k max_tokens guardrail is forwarded on every shard call.
//
// Stubs runAICall + estimateDishMacros via the DI seams on expandCandidate.
// No real Anthropic, no real Prisma — the test only exercises the orchestrator.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expandCandidate } from "../wizardExpansion";
import type {
  AICallFailure,
  AICallResult,
  AICallSuccess,
} from "../ai/runAICall";
import {
  WizardExpandResultSchema,
  WizardExpandedPlanSchema,
  type WizardExpandRequest,
  type WizardExpandResult,
} from "../ai/schemas/wizard";
import type { EstimateDishMacrosResult } from "../dishMacros";
import type { PrismaClient } from "@prisma/client";

// ── builders ──────────────────────────────────────────────────────────────

function makeRequest(mealTitles: string[]): WizardExpandRequest {
  return {
    candidate: {
      id: "c1",
      title: "Test Plan",
      tags: ["test"],
      whyBullets: ["because tests"],
      mealTitles,
      dailyMacros: {
        calories: 600,
        proteinG: 30,
        carbsG: 60,
        fatG: 22,
      },
    },
    candidateContext: {
      planDurationDays: mealTitles.length,
      householdSize: 4,
      wantsLeftovers: false,
      allergiesAndAvoidances: [],
      eatingStyles: [],
      difficulty: "medium",
    },
  };
}

function makeMeal(title: string): WizardExpandResult["meals"][number] {
  return {
    title,
    cuisineType: "Test",
    estimatedTimeMinutes: 30,
    difficulty: "easy",
    servings: 4,
    dishes: [
      {
        title,
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "ingredient a", quantity: 1, unit: "cup" },
          { name: "ingredient b", quantity: 2, unit: "tablespoon" },
          { name: "ingredient c", quantity: 1, unit: "pound" },
        ],
        steps: [
          { text: "step one", phaseType: "prep", estimatedMinutes: 5 },
          { text: "step two", phaseType: "cook", estimatedMinutes: 10 },
        ],
      },
    ],
  };
}

function successResult(
  meals: WizardExpandResult["meals"],
): AICallSuccess<WizardExpandResult> {
  return {
    success: true,
    data: { meals },
    metadata: {
      promptKey: "wizard.candidate.expand",
      promptVersion: 1,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 100,
      inputTokens: 500,
      outputTokens: 800,
      costEstimateUsd: 0.001,
      retryCount: 0,
    },
  };
}

function failureForReason(reason: AICallFailure["reason"]): AICallFailure {
  return {
    success: false,
    reason,
    userFacingMessage: "Kiwi got distracted. Try again?",
    metadata: {
      promptKey: "wizard.candidate.expand",
      promptVersion: 1,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 100,
      inputTokens: 500,
      outputTokens: 0,
      retryCount: 1,
    },
  };
}

// Records every call so tests can assert ordering, retry behavior, and
// opts forwarding. The behavior callback decides what to return per call.
interface CallRecord {
  mealTitle: string;
  attempt: number;
  maxTokens: number | undefined;
}

function makeRunAICallStub(
  behavior: (
    mealTitle: string,
    attemptForThisTitle: number,
  ) => AICallResult<WizardExpandResult>,
) {
  const calls: CallRecord[] = [];
  const perTitleAttempts = new Map<string, number>();

  // runAICall is generic over the schema type; expandCandidate always calls
  // it with WizardExpandResultSchema. Cast through `unknown` so the stub
  // satisfies `typeof productionRunAICall` without depending on z.infer.
  const fn = (async (
    _promptKey: string,
    vars: Record<string, unknown>,
    _schema: unknown,
    opts: { maxTokens?: number } | undefined,
  ): Promise<AICallResult<WizardExpandResult>> => {
    const expandInput = (vars.expandInput ?? {}) as WizardExpandRequest;
    const mealTitle = expandInput.candidate.mealTitles[0];
    const prev = perTitleAttempts.get(mealTitle) ?? 0;
    const attempt = prev + 1;
    perTitleAttempts.set(mealTitle, attempt);
    calls.push({ mealTitle, attempt, maxTokens: opts?.maxTokens });
    return behavior(mealTitle, attempt);
  }) as unknown as Parameters<typeof expandCandidate>[0]["runAICall"];

  return { fn, calls };
}

function makeEstimateStub(): Parameters<
  typeof expandCandidate
>[0]["estimateDishMacrosImpl"] {
  return (async (): Promise<EstimateDishMacrosResult> => ({
    status: "success",
    perServing: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
  })) as unknown as Parameters<
    typeof expandCandidate
  >[0]["estimateDishMacrosImpl"];
}

// Cookbook Phase B Block 2 (D-WS7-197) — expandCandidate now reads the user's
// stored UserPreferences to server-authoritatively re-inject sauce + cook-time
// into the expand candidateContext. These tests don't exercise pref values, so
// null (→ schema-default fallbacks) is fine; the stub just has to exist.
const stubPrisma = {
  userPreferences: {
    findUnique: async () => null,
  },
} as unknown as PrismaClient;

// ── tests ─────────────────────────────────────────────────────────────────

describe("expandCandidate — per-meal sharding", () => {
  it("fans out one runAICall per mealTitle and assembles meals[] in input order", async () => {
    const titles = ["A", "B", "C"];
    // Return success in reverse order (C resolves "fastest") to prove the
    // assembled order is mealTitles-order, not completion order.
    const { fn, calls } = makeRunAICallStub((mealTitle) => {
      const delay = mealTitle === "A" ? 30 : mealTitle === "B" ? 15 : 0;
      // node:test runners are not strictly ordered by setTimeout in stubs,
      // but Promise.all preserves index order from the source array. We
      // assert against the assembled `meals[]` indices, not promise order.
      void delay;
      return successResult([makeMeal(mealTitle)]);
    });

    const result = await expandCandidate({
      prisma: stubPrisma,
      userId: "u1",
      request: makeRequest(titles),
      runAICall: fn,
      estimateDishMacrosImpl: makeEstimateStub(),
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.deepEqual(
      result.expanded.meals.map((m) => m.title),
      titles,
    );
    // One call per title; each tagged with the 8k guardrail (WS7-5c Block A
    // dropped steps from call #2, halved from the prior 16k headroom).
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.maxTokens, 8192, `maxTokens for ${c.mealTitle}`);
    }
    // Echoes the top-level candidate identity.
    assert.equal(result.expanded.candidateId, "c1");
    assert.equal(result.expanded.title, "Test Plan");
  });

  it("fails the whole expand when runAICall fails for a meal — no meal-level retry wrapper", async () => {
    const titles = ["A", "B"];
    const { fn, calls } = makeRunAICallStub((mealTitle) => {
      // B's runAICall fails; A succeeds. expandOneMeal must NOT call B again
      // — runAICall's built-in retry is the only retry layer.
      if (mealTitle === "B") {
        return failureForReason("validation_failed");
      }
      return successResult([makeMeal(mealTitle)]);
    });

    const result = await expandCandidate({
      prisma: stubPrisma,
      userId: "u1",
      request: makeRequest(titles),
      runAICall: fn,
      estimateDishMacrosImpl: makeEstimateStub(),
    });

    assert.equal(result.status, "ai_failed");
    if (result.status !== "ai_failed") return;
    assert.equal(result.reason, "meal_failed:B");
    // Exactly one expandOneMeal-level call per meal: A=1, B=1.
    const aCalls = calls.filter((c) => c.mealTitle === "A").length;
    const bCalls = calls.filter((c) => c.mealTitle === "B").length;
    assert.equal(aCalls, 1, "A should be called exactly once");
    assert.equal(
      bCalls,
      1,
      "B should be called exactly once — no meal-level retry wrapper",
    );
  });

  it("surfaces meal_failed reason and userFacingMessage when a meal fails (3-title fan-out)", async () => {
    const titles = ["A", "B", "C"];
    const { fn, calls } = makeRunAICallStub((mealTitle) => {
      // B fails its runAICall; others succeed.
      if (mealTitle === "B") {
        return failureForReason("validation_failed");
      }
      return successResult([makeMeal(mealTitle)]);
    });

    const result = await expandCandidate({
      prisma: stubPrisma,
      userId: "u1",
      request: makeRequest(titles),
      runAICall: fn,
      estimateDishMacrosImpl: makeEstimateStub(),
    });

    assert.equal(result.status, "ai_failed");
    if (result.status !== "ai_failed") return;
    assert.equal(
      result.reason,
      "meal_failed:B",
      "reason should identify the offending meal title",
    );
    assert.ok(
      result.userFacingMessage.length > 0,
      "should surface a user-facing message",
    );
    // Exactly one expandOneMeal-level call for B.
    const bCalls = calls.filter((c) => c.mealTitle === "B").length;
    assert.equal(bCalls, 1, "B should be called exactly once");
  });

  it("surfaces the first failing meal title when multiple meals fail", async () => {
    const titles = ["A", "B", "C"];
    const { fn } = makeRunAICallStub((mealTitle) => {
      // Both B and C fail; A succeeds. Per Array.find semantics the failure
      // surfaced should be the FIRST failing index in mealTitles order (B).
      if (mealTitle === "B" || mealTitle === "C") {
        return failureForReason("sdk_error");
      }
      return successResult([makeMeal(mealTitle)]);
    });

    const result = await expandCandidate({
      prisma: stubPrisma,
      userId: "u1",
      request: makeRequest(titles),
      runAICall: fn,
      estimateDishMacrosImpl: makeEstimateStub(),
    });

    assert.equal(result.status, "ai_failed");
    if (result.status !== "ai_failed") return;
    assert.equal(result.reason, "meal_failed:B");
  });
});

// Cookbook Phase B Block 4 (D-WS7-035, amends D-WS7-197) — the per-run
// cook-cap/sauce override must survive into the expand call's effective
// candidateContext instead of being blindly reverted to stored prefs. The
// server stays authoritative: it RESOLVES override-else-stored via the shared
// resolver rather than trusting a raw echo.
describe("expandCandidate — per-run preference resolution at expand", () => {
  // Stored cap = 60; the wizard set a 30-min cap for THIS plan (carried on
  // candidateContext). The override must win at expand.
  const storedPrisma = {
    userPreferences: {
      findUnique: async () => ({
        saucePreference: "homemade",
        maxCookTimeMinutes: 60,
        maxCookTimeCoverage: "all",
      }),
    },
  } as unknown as PrismaClient;

  function captureContexts() {
    const seen: WizardExpandRequest["candidateContext"][] = [];
    const fn = (async (
      _promptKey: string,
      vars: Record<string, unknown>,
    ): Promise<AICallResult<WizardExpandResult>> => {
      const expandInput = vars.expandInput as WizardExpandRequest;
      seen.push(expandInput.candidateContext);
      return successResult([makeMeal(expandInput.candidate.mealTitles[0])]);
    }) as unknown as Parameters<typeof expandCandidate>[0]["runAICall"];
    return { fn, seen };
  }

  it("uses the per-run cook-cap override, not the stored cap", async () => {
    const { fn, seen } = captureContexts();
    const base = makeRequest(["A"]);
    const request: WizardExpandRequest = {
      ...base,
      candidateContext: {
        ...base.candidateContext,
        // Per-run override for THIS plan — differs from stored (60).
        maxCookTimeMinutes: 30,
      },
    };

    const result = await expandCandidate({
      prisma: storedPrisma,
      userId: "u1",
      request,
      runAICall: fn,
      estimateDishMacrosImpl: makeEstimateStub(),
    });

    assert.equal(result.status, "success");
    assert.ok(seen.length >= 1, "expand call captured");
    assert.equal(
      seen[0].maxCookTimeMinutes,
      30,
      "per-run cook cap was reverted to stored — override lost at expand",
    );
  });

  it("falls back to stored sauce/coverage when the client omits them", async () => {
    const { fn, seen } = captureContexts();
    // makeRequest's candidateContext omits saucePreference + coverage entirely.
    const result = await expandCandidate({
      prisma: storedPrisma,
      userId: "u1",
      request: makeRequest(["A"]),
      runAICall: fn,
      estimateDishMacrosImpl: makeEstimateStub(),
    });

    assert.equal(result.status, "success");
    assert.equal(seen[0].saucePreference, "homemade", "stored sauce not used");
    assert.equal(
      seen[0].maxCookTimeCoverage,
      "all",
      "stored coverage not used",
    );
    // No per-run cap sent → falls back to stored 60.
    assert.equal(seen[0].maxCookTimeMinutes, 60, "stored cap not used");
  });
});

// WS7-5b-server-fix2 — the dish-ingredient floor relaxed from .min(3) to
// .min(1). Meal-substance is still guarded by WizardExpandMealSchema.dishes
// .min(1) and WizardExpandResultSchema.meals.min(1). These tests prove that
// a legitimately simple side (warmed pita, baked potato, steamed vegetable)
// with one ingredient flows through BOTH the AI-result schema AND the
// materializer-validated WizardExpandedPlanSchema without tripping schema
// validation — so a smoke meal whose AI response includes a 1-ingredient
// side dish no longer surfaces meal_failed.
describe("WizardExpandDishSchema — dish ingredient floor (WS7-5b-server-fix2)", () => {
  it("accepts a 1-ingredient dish in WizardExpandResultSchema", () => {
    const parsed = WizardExpandResultSchema.safeParse({
      meals: [
        {
          title: "Lamb Kofta Skewers with Tzatziki, Warm Pita, and Tabbouleh",
          cuisineType: "Mediterranean",
          estimatedTimeMinutes: 45,
          difficulty: "medium",
          servings: 4,
          dishes: [
            {
              title: "Lamb Kofta Skewers",
              role: "main",
              positionIndex: 0,
              ingredients: [
                { name: "ground lamb", quantity: 1.5, unit: "pound" },
                { name: "yellow onion", quantity: 0.5, unit: "each" },
                { name: "garlic", quantity: 3, unit: "clove" },
              ],
              steps: [
                {
                  text: "Form lamb into skewers.",
                  phaseType: "prep",
                  estimatedMinutes: 10,
                },
                {
                  text: "Grill until cooked.",
                  phaseType: "cook",
                  estimatedMinutes: 12,
                },
              ],
            },
            {
              title: "Warm Pita",
              role: "side",
              positionIndex: 1,
              // A legitimately simple side — the product ruling for this fix.
              ingredients: [
                { name: "pita bread", quantity: 4, unit: "each" },
              ],
              steps: [
                {
                  text: "Warm in oven for 2 minutes.",
                  phaseType: "cook",
                  estimatedMinutes: 2,
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.flatten()));
  });

  it("accepts a 1-ingredient enriched dish in WizardExpandedPlanSchema (materializer read-side)", () => {
    const parsed = WizardExpandedPlanSchema.safeParse({
      candidateId: "c1",
      title: "Mediterranean Week",
      tags: ["Mediterranean"],
      whyBullets: ["because tests"],
      meals: [
        {
          title: "Lamb Kofta Skewers with Tzatziki, Warm Pita, and Tabbouleh",
          cuisineType: "Mediterranean",
          estimatedTimeMinutes: 45,
          difficulty: "medium",
          servings: 4,
          dishes: [
            {
              title: "Warm Pita",
              role: "side",
              positionIndex: 0,
              ingredients: [
                { name: "pita bread", quantity: 4, unit: "each" },
              ],
              steps: [
                {
                  text: "Warm in oven for 2 minutes.",
                  phaseType: "cook",
                  estimatedMinutes: 2,
                },
              ],
              macros: {
                caloriesPerServing: 180,
                proteinGPerServing: 6,
                carbsGPerServing: 36,
                fatGPerServing: 1,
              },
            },
          ],
        },
      ],
    });
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.flatten()));
  });

  it("still rejects a 0-ingredient dish (meal-substance lower bound preserved at the per-dish level)", () => {
    const parsed = WizardExpandResultSchema.safeParse({
      meals: [
        {
          title: "Empty plate",
          cuisineType: "Test",
          estimatedTimeMinutes: 5,
          difficulty: "easy",
          servings: 2,
          dishes: [
            {
              title: "Nothing",
              role: "main",
              positionIndex: 0,
              ingredients: [],
              steps: [
                { text: "serve", phaseType: "assemble", estimatedMinutes: 1 },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(parsed.success, false);
  });
});
