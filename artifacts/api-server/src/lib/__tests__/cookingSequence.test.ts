// WS6 6d-1 — runCookingSequence loader unit tests.
// Mocked Prisma (small ad-hoc stub keyed by mealId) + mocked runAICall.
// No DB, no real AI. Mirrors the planMacros.test.ts harness pattern.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  runCookingSequence,
  CookingSequenceNotFoundError,
  CookingSequenceEmptyMealError,
  EMPTY_MEAL_COPY,
  type RunCookingSequenceDeps,
} from "../cookingSequence";
import type { runAICall as productionRunAICall } from "../ai/runAICall";
import type { SequencedStepsResult } from "../ai/schemas/sequencer";

// ── tiny prisma stub ──────────────────────────────────────────────────

interface MealFixture {
  id: string;
  userId: string | null;
  isPublic: boolean;
  dishLinks: Array<{
    dishId: string;
    positionIndex: number;
    dish: { id: string; title: string };
  }>;
}

interface StepFixture {
  ownerType: "dish";
  ownerId: string;
  stepIndex: number;
  stepTextTranslated: string;
  estimatedMinutes: number;
  phaseType: "prep" | "cook" | "rest" | "preheat" | "assemble" | "hold";
  parallelGroup: string | null;
  isTimingSensitive: boolean;
}

function makePrismaStub(opts: {
  meals: MealFixture[];
  steps: StepFixture[];
}): PrismaClient {
  return {
    meal: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = opts.meals.find((mm) => mm.id === where.id);
        if (!m) return null;
        // Mirror Prisma's `orderBy: { positionIndex: "asc" }` on dishLinks.
        return {
          ...m,
          dishLinks: [...m.dishLinks].sort(
            (a, b) => a.positionIndex - b.positionIndex,
          ),
        };
      },
    },
    recipeInstructionStep: {
      findMany: async ({
        where,
      }: {
        where: { ownerType: string; ownerId: { in: string[] } };
      }) => {
        const ids = new Set(where.ownerId.in);
        return opts.steps
          .filter((s) => s.ownerType === where.ownerType && ids.has(s.ownerId))
          .sort((a, b) => {
            if (a.ownerId !== b.ownerId) return a.ownerId < b.ownerId ? -1 : 1;
            return a.stepIndex - b.stepIndex;
          });
      },
    },
  } as unknown as PrismaClient;
}

// ── happy-path AI stub ────────────────────────────────────────────────

function makeRunAICallStub(opts: {
  result?: SequencedStepsResult;
  failure?: { reason: string; userFacingMessage: string };
  capture?: (vars: Record<string, unknown>) => void;
}): typeof productionRunAICall {
  return (async (
    _promptKey: string,
    vars: Record<string, unknown>,
    _schema: unknown,
    _opts: unknown,
  ) => {
    opts.capture?.(vars);
    if (opts.failure) {
      return {
        success: false,
        reason: opts.failure.reason as never,
        userFacingMessage: opts.failure.userFacingMessage,
        metadata: {},
      };
    }
    return {
      success: true,
      data: opts.result ?? { steps: [], totalEstimatedMinutes: 0 },
      metadata: {
        promptKey: "sequencer.step_ordering",
        promptVersion: 1,
        model: "claude-sonnet-4-6",
        mode: "tool",
        latencyMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        costEstimateUsd: 0,
        retryCount: 0,
      },
    };
  }) as unknown as typeof productionRunAICall;
}

function makeDeps(prisma: PrismaClient, runAICall: typeof productionRunAICall): RunCookingSequenceDeps {
  return { prisma, runAICall };
}

const USER_ID = "user-cooking-seq-test";
const OTHER_USER_ID = "user-cooking-seq-other";

// ── tests ─────────────────────────────────────────────────────────────

describe("runCookingSequence — 404 paths", () => {
  it("throws NotFoundError when the meal does not exist", async () => {
    const prisma = makePrismaStub({ meals: [], steps: [] });
    const ai = makeRunAICallStub({});
    await assert.rejects(
      runCookingSequence({
        mealId: "missing-meal",
        userId: USER_ID,
        deps: makeDeps(prisma, ai),
      }),
      (err) => err instanceof CookingSequenceNotFoundError,
    );
  });

  it("throws NotFoundError when the meal belongs to a different user", async () => {
    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-stranger",
          userId: OTHER_USER_ID,
          isPublic: false,
          dishLinks: [],
        },
      ],
      steps: [],
    });
    const ai = makeRunAICallStub({});
    await assert.rejects(
      runCookingSequence({
        mealId: "meal-stranger",
        userId: USER_ID,
        deps: makeDeps(prisma, ai),
      }),
      (err) => err instanceof CookingSequenceNotFoundError,
    );
  });

  it("allows access when the meal is public (userId=null, isPublic=true)", async () => {
    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-public",
          userId: null,
          isPublic: true,
          dishLinks: [
            {
              dishId: "dish-pub",
              positionIndex: 0,
              dish: { id: "dish-pub", title: "Public Dish" },
            },
          ],
        },
      ],
      steps: [
        {
          ownerType: "dish",
          ownerId: "dish-pub",
          stepIndex: 0,
          stepTextTranslated: "Cook it.",
          estimatedMinutes: 5,
          phaseType: "cook",
          parallelGroup: null,
          isTimingSensitive: false,
        },
      ],
    });
    const ai = makeRunAICallStub({});
    const result = await runCookingSequence({
      mealId: "meal-public",
      userId: USER_ID,
      deps: makeDeps(prisma, ai),
    });
    assert.equal(result.usedAI, false);
    assert.equal(result.sequence.length, 1);
  });
});

describe("runCookingSequence — EmptyMealError paths", () => {
  it("throws EmptyMealError when the meal has zero dishLinks", async () => {
    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-empty",
          userId: USER_ID,
          isPublic: false,
          dishLinks: [],
        },
      ],
      steps: [],
    });
    const ai = makeRunAICallStub({});
    await assert.rejects(
      runCookingSequence({
        mealId: "meal-empty",
        userId: USER_ID,
        deps: makeDeps(prisma, ai),
      }),
      (err) => err instanceof CookingSequenceEmptyMealError,
    );
  });

  it("throws EmptyMealError when dishes exist but no steps", async () => {
    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-no-steps",
          userId: USER_ID,
          isPublic: false,
          dishLinks: [
            {
              dishId: "dish-stepless",
              positionIndex: 0,
              dish: { id: "dish-stepless", title: "Stepless" },
            },
          ],
        },
      ],
      steps: [],
    });
    const ai = makeRunAICallStub({});
    await assert.rejects(
      runCookingSequence({
        mealId: "meal-no-steps",
        userId: USER_ID,
        deps: makeDeps(prisma, ai),
      }),
      (err) =>
        err instanceof CookingSequenceEmptyMealError &&
        // sanity — error class is named distinctly; route wraps it with the
        // locked copy. We assert EMPTY_MEAL_COPY is exported for the route.
        EMPTY_MEAL_COPY.length > 0,
    );
  });
});

describe("runCookingSequence — single-dish branch", () => {
  it("returns usedAI=false and cumulative startsAtMinutes; no runAICall", async () => {
    let aiCalls = 0;
    const ai = makeRunAICallStub({ capture: () => aiCalls++ });

    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-single",
          userId: USER_ID,
          isPublic: false,
          dishLinks: [
            {
              dishId: "dish-only",
              positionIndex: 0,
              dish: { id: "dish-only", title: "Only Dish" },
            },
          ],
        },
      ],
      steps: [
        {
          ownerType: "dish",
          ownerId: "dish-only",
          stepIndex: 0,
          stepTextTranslated: "Chop onion.",
          estimatedMinutes: 3,
          phaseType: "prep",
          parallelGroup: null,
          isTimingSensitive: false,
        },
        {
          ownerType: "dish",
          ownerId: "dish-only",
          stepIndex: 1,
          stepTextTranslated: "Sauté.",
          estimatedMinutes: 5,
          phaseType: "cook",
          parallelGroup: null,
          isTimingSensitive: false,
        },
        {
          ownerType: "dish",
          ownerId: "dish-only",
          stepIndex: 2,
          stepTextTranslated: "Plate.",
          estimatedMinutes: 1,
          phaseType: "assemble",
          parallelGroup: null,
          isTimingSensitive: false,
        },
      ],
    });

    const result = await runCookingSequence({
      mealId: "meal-single",
      userId: USER_ID,
      deps: makeDeps(prisma, ai),
    });

    assert.equal(result.usedAI, false);
    assert.equal(aiCalls, 0);
    assert.equal(result.dishCount, 1);
    assert.equal(result.sequence.length, 3);
    assert.equal(result.totalEstimatedMinutes, 9);
    assert.deepEqual(
      result.sequence.map((s) => [s.sequenceIndex, s.originalStepIndex, s.startsAtMinutes]),
      [
        [0, 0, 0],
        [1, 1, 3],
        [2, 2, 8],
      ],
    );
  });
});

describe("runCookingSequence — multi-dish branch", () => {
  function buildMultiDishFixture() {
    const meals: MealFixture[] = [
      {
        id: "meal-multi",
        userId: USER_ID,
        isPublic: false,
        dishLinks: [
          // intentionally reversed insertion order — prisma stub re-sorts,
          // and the loader trusts the `orderBy: positionIndex` to put them
          // in 0,1 order in mealDishes.
          {
            dishId: "dish-b",
            positionIndex: 1,
            dish: { id: "dish-b", title: "Side" },
          },
          {
            dishId: "dish-a",
            positionIndex: 0,
            dish: { id: "dish-a", title: "Main" },
          },
        ],
      },
    ];
    const steps: StepFixture[] = [
      {
        ownerType: "dish",
        ownerId: "dish-a",
        stepIndex: 0,
        stepTextTranslated: "Sear protein.",
        estimatedMinutes: 0, // intentionally 0 — should coerce to 1
        phaseType: "cook",
        parallelGroup: null,
        isTimingSensitive: true,
      },
      {
        ownerType: "dish",
        ownerId: "dish-a",
        stepIndex: 1,
        stepTextTranslated: "Rest.",
        estimatedMinutes: 5,
        phaseType: "rest",
        parallelGroup: null,
        isTimingSensitive: false,
      },
      {
        ownerType: "dish",
        ownerId: "dish-b",
        stepIndex: 0,
        stepTextTranslated: "Toss salad.",
        estimatedMinutes: 2,
        phaseType: "assemble",
        parallelGroup: "side-prep",
        isTimingSensitive: false,
      },
    ];
    return { meals, steps };
  }

  it("invokes runAICall with sequencer.step_ordering and well-formed input", async () => {
    let captured: Record<string, unknown> | null = null;
    const ai = makeRunAICallStub({
      result: {
        steps: [
          { dishId: "dish-a", originalStepIndex: 0, sequenceIndex: 0, startsAtMinutes: 0, reason: "Lead with searing." },
          { dishId: "dish-b", originalStepIndex: 0, sequenceIndex: 1, startsAtMinutes: 1 },
          { dishId: "dish-a", originalStepIndex: 1, sequenceIndex: 2, startsAtMinutes: 3 },
        ],
        totalEstimatedMinutes: 8,
      },
      capture: (vars) => {
        captured = vars;
      },
    });

    const fixture = buildMultiDishFixture();
    const prisma = makePrismaStub(fixture);

    const result = await runCookingSequence({
      mealId: "meal-multi",
      userId: USER_ID,
      deps: makeDeps(prisma, ai),
    });

    assert.equal(result.usedAI, true);
    assert.equal(result.dishCount, 2);
    assert.equal(result.totalEstimatedMinutes, 8);
    assert.equal(result.sequence.length, 3);

    assert.ok(captured, "runAICall should have been invoked with vars");
    const input = (captured as { sequencerInput: { mealDishes: Array<{ dishId: string; positionIndex: number }>; dishSteps: Array<{ dishId: string; stepIndex: number; estimatedMinutes: number; phaseType: string; parallelGroup: string | null; isTimingSensitive: boolean }> } }).sequencerInput;

    // mealDishes ordered by positionIndex ascending: dish-a first, then dish-b.
    assert.deepEqual(
      input.mealDishes.map((d) => [d.dishId, d.positionIndex]),
      [
        ["dish-a", 0],
        ["dish-b", 1],
      ],
    );

    // dishSteps: estimatedMinutes 0 coerced to 1; phaseType pass-through;
    // parallelGroup null preserved.
    const dishAStep0 = input.dishSteps.find(
      (s) => s.dishId === "dish-a" && s.estimatedMinutes >= 1,
    );
    assert.ok(dishAStep0, "dish-a step 0 with coerced estimatedMinutes present");
    assert.equal(dishAStep0.estimatedMinutes, 1, "0 -> 1 coercion");

    const restStep = input.dishSteps.find(
      (s) => s.dishId === "dish-a" && s.phaseType === "rest",
    );
    assert.ok(restStep, "phase 'rest' passed through unchanged");

    const saladStep = input.dishSteps.find((s) => s.dishId === "dish-b");
    assert.ok(saladStep);
    assert.equal(saladStep.parallelGroup, "side-prep");

    // Every step in the sequencer input carries isTimingSensitive (boolean).
    for (const s of input.dishSteps) {
      assert.equal(
        typeof s.isTimingSensitive,
        "boolean",
        `step ${s.dishId}:${s.stepIndex} missing isTimingSensitive`,
      );
    }
  });

  it("passes isTimingSensitive through verbatim (true and false) to runAICall", async () => {
    let captured: Record<string, unknown> | null = null;
    const ai = makeRunAICallStub({
      result: {
        steps: [
          { dishId: "dish-a", originalStepIndex: 0, sequenceIndex: 0, startsAtMinutes: 0 },
          { dishId: "dish-b", originalStepIndex: 0, sequenceIndex: 1, startsAtMinutes: 1 },
          { dishId: "dish-a", originalStepIndex: 1, sequenceIndex: 2, startsAtMinutes: 3 },
        ],
        totalEstimatedMinutes: 8,
      },
      capture: (vars) => {
        captured = vars;
      },
    });

    const fixture = buildMultiDishFixture();
    const prisma = makePrismaStub(fixture);

    await runCookingSequence({
      mealId: "meal-multi",
      userId: USER_ID,
      deps: makeDeps(prisma, ai),
    });

    assert.ok(captured);
    const input = (captured as { sequencerInput: { dishSteps: Array<{ dishId: string; stepIndex: number; isTimingSensitive: boolean }> } }).sequencerInput;

    // dish-a step 0 in the fixture is isTimingSensitive=true; the rest false.
    const sear = input.dishSteps.find((s) => s.dishId === "dish-a" && s.stepIndex === 0);
    const rest = input.dishSteps.find((s) => s.dishId === "dish-a" && s.stepIndex === 1);
    const salad = input.dishSteps.find((s) => s.dishId === "dish-b" && s.stepIndex === 0);
    assert.ok(sear && rest && salad);
    assert.equal(sear.isTimingSensitive, true, "true passed through");
    assert.equal(rest.isTimingSensitive, false, "false passed through");
    assert.equal(salad.isTimingSensitive, false, "false passed through");
  });

  it("propagates AI failure as CookingSequenceAIError", async () => {
    const ai = makeRunAICallStub({
      failure: {
        reason: "validation_failed",
        userFacingMessage: "Kiwi got distracted. Try again?",
      },
    });
    const fixture = buildMultiDishFixture();
    const prisma = makePrismaStub(fixture);

    await assert.rejects(
      runCookingSequence({
        mealId: "meal-multi",
        userId: USER_ID,
        deps: makeDeps(prisma, ai),
      }),
      (err) =>
        err instanceof Error &&
        err.name === "CookingSequenceAIError" &&
        /Kiwi got distracted/.test(
          (err as unknown as { userFacingMessage: string }).userFacingMessage,
        ),
    );
  });
});
