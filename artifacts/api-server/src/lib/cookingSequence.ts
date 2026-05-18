// WS6 6d-1 — Cooking Sequencer loader.
// Per kiwi_ws6_plan.md §3 6d-1 + PRD §13.5.4 / §13.5.5.
//
// Server-side endpoint at Cook Mode launch. Takes all step data from a
// meal's dishes (with phase types, parallel groups, estimated times),
// calls Sonnet via tool_use, returns one ordered sequence intermixing
// steps from all dishes for parallel execution.
//
// Single-dish meals skip the AI and return stored step order directly —
// no `runAICall` invocation, no `LLMCallLog` row. Free per PRD §13.5.5
// (infrastructure AI; reorders + annotates existing steps, does NOT
// rewrite or generate new content).

import type { PrismaClient } from "@prisma/client";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  SequencedStepsResultSchema,
  type SequencedStep,
  type SequencerInput,
} from "./ai/schemas/sequencer";
import { logger } from "./logger";

// Route handler maps NotFoundError → 404; meal-exists-but-empty maps to
// 400 with the locked copy.
export class CookingSequenceNotFoundError extends Error {
  constructor(mealId: string) {
    super(`meal ${mealId} not found`);
    this.name = "CookingSequenceNotFoundError";
  }
}

export const EMPTY_MEAL_COPY =
  "Kiwi didn't find anything to cook, check the meal to make sure the dishes and ingredients are there.";

export class CookingSequenceEmptyMealError extends Error {
  constructor(mealId: string) {
    super(`meal ${mealId} has nothing to sequence`);
    this.name = "CookingSequenceEmptyMealError";
  }
}

export class CookingSequenceAIError extends Error {
  constructor(
    public readonly userFacingMessage: string,
    public readonly reason: string,
  ) {
    super(`sequencer AI call failed: ${reason}`);
    this.name = "CookingSequenceAIError";
  }
}

export interface RunCookingSequenceDeps {
  prisma: PrismaClient;
  runAICall: typeof productionRunAICall;
}

export interface RunCookingSequenceParams {
  mealId: string;
  userId: string;
  deps: RunCookingSequenceDeps;
}

export interface CookingSequenceResult {
  sequence: SequencedStep[];
  totalEstimatedMinutes: number;
  dishCount: number;
  // true for multi-dish path, false for single-dish branch.
  usedAI: boolean;
}

export async function runCookingSequence(
  params: RunCookingSequenceParams,
): Promise<CookingSequenceResult> {
  const { mealId, userId, deps } = params;
  const { prisma, runAICall } = deps;

  // 1. Load meal + dishLinks (with dish metadata) in one round-trip.
  const meal = await prisma.meal.findUnique({
    where: { id: mealId },
    include: {
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        include: { dish: true },
      },
    },
  });

  // 2. Access check — owner OR public. Treat missing + forbidden as 404
  //    so the route handler doesn't leak meal existence to non-owners.
  if (!meal) {
    throw new CookingSequenceNotFoundError(mealId);
  }
  const isOwner = meal.userId === userId;
  const isPublic = meal.userId === null && meal.isPublic === true;
  if (!isOwner && !isPublic) {
    throw new CookingSequenceNotFoundError(mealId);
  }

  // 3. Empty meal — no dishLinks at all.
  if (meal.dishLinks.length === 0) {
    throw new CookingSequenceEmptyMealError(mealId);
  }

  // 4. Bulk-load all steps for the meal's dishes. Polymorphic ownership
  //    means we can't JOIN — separate query keyed by ownerType + ownerId.
  const dishIds = meal.dishLinks.map((dl) => dl.dishId);
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishIds } },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });

  // 5. Empty meal — dishes exist but no steps anywhere.
  if (steps.length === 0) {
    throw new CookingSequenceEmptyMealError(mealId);
  }

  // 6. Coerce estimatedMinutes 0 → 1 at this boundary (the 15-second
  //    floor decision). All downstream code sees a minimum of 1.
  const normalized = steps.map((s) => ({
    ...s,
    estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
  }));

  // 7. Group steps by dishId. The bulk-load is already ordered by
  //    ownerId then stepIndex, so each per-dish slice is sorted.
  const stepsByDish = new Map<string, typeof normalized>();
  for (const step of normalized) {
    const list = stepsByDish.get(step.ownerId);
    if (list) list.push(step);
    else stepsByDish.set(step.ownerId, [step]);
  }

  const dishCount = meal.dishLinks.length;

  // 8. Single-dish branch — no AI, no LLMCallLog row. Walk the single
  //    dish's steps and build the sequence directly with cumulative
  //    startsAtMinutes (each step starts when the previous one finishes).
  if (dishCount === 1) {
    const onlyDishId = meal.dishLinks[0].dishId;
    const onlySteps = stepsByDish.get(onlyDishId) ?? [];
    let cursor = 0;
    const sequence: SequencedStep[] = onlySteps.map((s, idx) => {
      const entry: SequencedStep = {
        dishId: s.ownerId,
        originalStepIndex: s.stepIndex,
        sequenceIndex: idx,
        startsAtMinutes: cursor,
      };
      cursor += s.estimatedMinutes;
      return entry;
    });
    return {
      sequence,
      totalEstimatedMinutes: cursor,
      dishCount,
      usedAI: false,
    };
  }

  // 9. Multi-dish branch — build sequencer input + call Sonnet tool_use.
  const sequencerInput: SequencerInput = {
    mealDishes: meal.dishLinks.map((dl) => ({
      dishId: dl.dishId,
      title: dl.dish.title,
      positionIndex: dl.positionIndex,
    })),
    dishSteps: normalized.map((s) => ({
      dishId: s.ownerId,
      stepIndex: s.stepIndex,
      stepText: s.stepTextTranslated,
      phaseType: s.phaseType,
      parallelGroup: s.parallelGroup,
      estimatedMinutes: s.estimatedMinutes,
      isTimingSensitive: s.isTimingSensitive,
    })),
  };

  const result = await runAICall(
    "sequencer.step_ordering",
    { sequencerInput },
    SequencedStepsResultSchema,
    { prisma, userId },
  );

  if (!result.success) {
    logger.warn(
      {
        event: "cooking_sequence_ai_failed",
        userId,
        mealId,
        reason: result.reason,
        promptKey: "sequencer.step_ordering",
      },
      "Cooking sequencer AI call failed",
    );
    throw new CookingSequenceAIError(result.userFacingMessage, result.reason);
  }

  return {
    sequence: result.data.steps,
    totalEstimatedMinutes: result.data.totalEstimatedMinutes,
    dishCount,
    usedAI: true,
  };
}
