// WS7-8b BUG-018 B2 — runCookingSequence loader unit tests.
// Mocked Prisma (small ad-hoc stub keyed by mealId). NO AI: the loader now hands
// step data to the pure deterministic scheduler (cookingScheduler.ts). These
// tests pin the loader plumbing (access checks, empty guards, 0->1 coercion,
// scheduler wiring); the ordering algorithm itself is proven in
// cookingScheduler.test.ts (incl. the D-WS7-164 + BUG-018 regressions).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  runCookingSequence,
  CookingSequenceNotFoundError,
  CookingSequenceEmptyMealError,
  EMPTY_MEAL_COPY,
} from "../cookingSequence";

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
  // Still a DB column (retired write-side in B1); the loader no longer reads it.
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

const USER_ID = "user-cooking-seq-test";
const OTHER_USER_ID = "user-cooking-seq-other";

// ── tests ─────────────────────────────────────────────────────────────

describe("runCookingSequence — 404 paths", () => {
  it("throws NotFoundError when the meal does not exist", async () => {
    const prisma = makePrismaStub({ meals: [], steps: [] });
    await assert.rejects(
      runCookingSequence({
        mealId: "missing-meal",
        userId: USER_ID,
        deps: { prisma },
      }),
      (err) => err instanceof CookingSequenceNotFoundError,
    );
  });

  it("throws NotFoundError when the meal belongs to a different user", async () => {
    const prisma = makePrismaStub({
      meals: [
        { id: "meal-stranger", userId: OTHER_USER_ID, isPublic: false, dishLinks: [] },
      ],
      steps: [],
    });
    await assert.rejects(
      runCookingSequence({
        mealId: "meal-stranger",
        userId: USER_ID,
        deps: { prisma },
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
            { dishId: "dish-pub", positionIndex: 0, dish: { id: "dish-pub", title: "Public Dish" } },
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
    const result = await runCookingSequence({
      mealId: "meal-public",
      userId: USER_ID,
      deps: { prisma },
    });
    assert.equal(result.usedAI, false);
    assert.equal(result.sequence.length, 1);
  });

  it("allows access to an OWNED-public community meal (userId set, isPublic=true) — D-WS9-036", async () => {
    // The pre-fix gate was `userId===null && isPublic`, which 404'd a meal
    // published by another user (owned + public). The widened `isPublic===true`
    // gate admits it — the launch community-kitchen case.
    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-community",
          userId: OTHER_USER_ID,
          isPublic: true,
          dishLinks: [
            { dishId: "dish-c", positionIndex: 0, dish: { id: "dish-c", title: "Community Dish" } },
          ],
        },
      ],
      steps: [
        {
          ownerType: "dish",
          ownerId: "dish-c",
          stepIndex: 0,
          stepTextTranslated: "Cook it.",
          estimatedMinutes: 5,
          phaseType: "cook",
          parallelGroup: null,
          isTimingSensitive: false,
        },
      ],
    });
    const result = await runCookingSequence({
      mealId: "meal-community",
      userId: USER_ID,
      deps: { prisma },
    });
    assert.equal(result.usedAI, false);
    assert.equal(result.sequence.length, 1);
  });
});

describe("runCookingSequence — EmptyMealError paths", () => {
  it("throws EmptyMealError when the meal has zero dishLinks", async () => {
    const prisma = makePrismaStub({
      meals: [{ id: "meal-empty", userId: USER_ID, isPublic: false, dishLinks: [] }],
      steps: [],
    });
    await assert.rejects(
      runCookingSequence({ mealId: "meal-empty", userId: USER_ID, deps: { prisma } }),
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
            { dishId: "dish-stepless", positionIndex: 0, dish: { id: "dish-stepless", title: "Stepless" } },
          ],
        },
      ],
      steps: [],
    });
    await assert.rejects(
      runCookingSequence({ mealId: "meal-no-steps", userId: USER_ID, deps: { prisma } }),
      (err) =>
        err instanceof CookingSequenceEmptyMealError && EMPTY_MEAL_COPY.length > 0,
    );
  });
});

describe("runCookingSequence — single-dish", () => {
  it("returns usedAI=false and serve-anchored offsets (deterministic, no AI)", async () => {
    const prisma = makePrismaStub({
      meals: [
        {
          id: "meal-single",
          userId: USER_ID,
          isPublic: false,
          dishLinks: [
            { dishId: "dish-only", positionIndex: 0, dish: { id: "dish-only", title: "Only Dish" } },
          ],
        },
      ],
      steps: [
        { ownerType: "dish", ownerId: "dish-only", stepIndex: 0, stepTextTranslated: "Chop onion.", estimatedMinutes: 3, phaseType: "prep", parallelGroup: null, isTimingSensitive: false },
        { ownerType: "dish", ownerId: "dish-only", stepIndex: 1, stepTextTranslated: "Sauté.", estimatedMinutes: 5, phaseType: "cook", parallelGroup: null, isTimingSensitive: false },
        { ownerType: "dish", ownerId: "dish-only", stepIndex: 2, stepTextTranslated: "Plate.", estimatedMinutes: 1, phaseType: "assemble", parallelGroup: null, isTimingSensitive: false },
      ],
    });

    const result = await runCookingSequence({
      mealId: "meal-single",
      userId: USER_ID,
      deps: { prisma },
    });

    assert.equal(result.usedAI, false);
    assert.equal(result.dishCount, 1);
    assert.equal(result.sequence.length, 3);
    assert.equal(result.totalEstimatedMinutes, 9);
    // Sequential from cook-start; serve-anchored offsets = start - serve(9).
    assert.deepEqual(
      result.sequence.map((s) => [s.sequenceIndex, s.originalStepIndex, s.startOffsetMinutes]),
      [
        [0, 0, -9],
        [1, 1, -6],
        [2, 2, -1],
      ],
    );
  });
});

describe("runCookingSequence — multi-dish (deterministic)", () => {
  function buildMultiDishFixture() {
    const meals: MealFixture[] = [
      {
        id: "meal-multi",
        userId: USER_ID,
        isPublic: false,
        dishLinks: [
          // Reversed insertion order — the prisma stub re-sorts by positionIndex.
          { dishId: "dish-b", positionIndex: 1, dish: { id: "dish-b", title: "Side" } },
          { dishId: "dish-a", positionIndex: 0, dish: { id: "dish-a", title: "Main" } },
        ],
      },
    ];
    const steps: StepFixture[] = [
      // dish-a: a watched sear (0 min -> coerces to 1) then a 5-min rest. D=6.
      { ownerType: "dish", ownerId: "dish-a", stepIndex: 0, stepTextTranslated: "Sear protein.", estimatedMinutes: 0, phaseType: "cook", parallelGroup: null, isTimingSensitive: true },
      { ownerType: "dish", ownerId: "dish-a", stepIndex: 1, stepTextTranslated: "Rest.", estimatedMinutes: 5, phaseType: "rest", parallelGroup: null, isTimingSensitive: false },
      // dish-b: a 2-min salad toss. D=2.
      { ownerType: "dish", ownerId: "dish-b", stepIndex: 0, stepTextTranslated: "Toss salad.", estimatedMinutes: 2, phaseType: "assemble", parallelGroup: "side-prep", isTimingSensitive: false },
    ];
    return { meals, steps };
  }

  it("computes the sequence deterministically with usedAI=false (no AI call)", async () => {
    const prisma = makePrismaStub(buildMultiDishFixture());
    const result = await runCookingSequence({
      mealId: "meal-multi",
      userId: USER_ID,
      deps: { prisma },
    });

    assert.equal(result.usedAI, false);
    assert.equal(result.dishCount, 2);
    // anchor = max(D_a=6 [0->1 coercion makes the sear 1 min], D_b=2) = 6.
    assert.equal(result.totalEstimatedMinutes, 6);
    assert.equal(result.sequence.length, 3);

    // Main leads (it gates the meal); the salad toss fills the rest window and
    // finishes at serve, so it never sits.
    assert.deepEqual(
      result.sequence.map((s) => [s.dishId, s.originalStepIndex, s.sequenceIndex, s.startOffsetMinutes]),
      [
        ["dish-a", 0, 0, -6], // sear (coerced 1 min)
        ["dish-a", 1, 1, -5], // rest 5 min -> ends at serve
        ["dish-b", 0, 2, -2], // toss during the rest, ends at serve
      ],
    );

    // The salad toss opens during the main's passive rest -> carries a cue.
    const toss = result.sequence.find((s) => s.dishId === "dish-b");
    assert.ok(toss?.reason, "toss gets a passive-window cue");
    assert.match(toss!.reason!, /Main/);
  });

  it("respects isTimingSensitive — nothing overlaps the watched sear", async () => {
    const prisma = makePrismaStub(buildMultiDishFixture());
    const result = await runCookingSequence({
      mealId: "meal-multi",
      userId: USER_ID,
      deps: { prisma },
    });
    // Reconstruct absolute times from serve-anchored offsets.
    const serve = result.totalEstimatedMinutes;
    const dur: Record<string, number> = {
      "dish-a#0": 1, // coerced from 0
      "dish-a#1": 5,
      "dish-b#0": 2,
    };
    const rows = result.sequence.map((s) => {
      const start = s.startOffsetMinutes + serve;
      return { key: `${s.dishId}#${s.originalStepIndex}`, start, finish: start + dur[`${s.dishId}#${s.originalStepIndex}`] };
    });
    const sear = rows.find((r) => r.key === "dish-a#0")!;
    for (const r of rows) {
      if (r.key === "dish-a#0") continue;
      const overlap = r.start < sear.finish && sear.start < r.finish;
      assert.ok(!overlap, `${r.key} must not overlap the sear window`);
    }
  });
});
