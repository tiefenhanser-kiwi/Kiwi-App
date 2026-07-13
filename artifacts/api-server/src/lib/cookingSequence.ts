// WS7-8b BUG-018 B2 — Cooking Sequencer loader (now fully deterministic).
// Per kiwi_ws6_plan.md §3 6d-1 + PRD §13.5.4 / §13.5.5.
//
// Server-side endpoint at Cook Mode launch. Loads all step data from a meal's
// dishes and hands it to the pure scheduler (cookingScheduler.ts), which returns
// one ordered sequence intermixing steps from all dishes with serve-anchored
// offsets + parallel cues.
//
// BUG-018 B2: the Sonnet `sequencer.step_ordering` call is GONE. PRD §13.5.5
// [LOCKED] says the Sequencer "runs deterministically on existing step data" and
// prices it FREE on that basis; the AI was doing single-resource scheduling
// arithmetic it is bad at (corn cold; shorter roast started first). No AI call,
// no LLMCallLog row, no rate limit — the same free path for single- AND
// multi-dish meals. `usedAI` remains on the wire, permanently false.

import type { PrismaClient } from "@prisma/client";

import {
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "./cookingScheduler";
import type { SequencedStep } from "./ai/schemas/sequencer";

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

export interface RunCookingSequenceDeps {
  prisma: PrismaClient;
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
  // Retained on the wire for backward compatibility; permanently false now that
  // ordering is computed (no Sonnet call on any path).
  usedAI: boolean;
}

export async function runCookingSequence(
  params: RunCookingSequenceParams,
): Promise<CookingSequenceResult> {
  const { mealId, userId, deps } = params;
  const { prisma } = deps;

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

  // 8. Build the scheduler input (dishes in positionIndex order, steps in
  //    stepIndex order) and compute the sequence. Pure, deterministic, free —
  //    single- and multi-dish meals take the same path.
  const schedulerDishes: SchedulerDish[] = meal.dishLinks
    .filter((dl) => stepsByDish.has(dl.dishId))
    .map((dl) => ({
      dishId: dl.dishId,
      title: dl.dish.title,
      positionIndex: dl.positionIndex,
      steps: (stepsByDish.get(dl.dishId) ?? []).map((s) => ({
        stepIndex: s.stepIndex,
        estimatedMinutes: s.estimatedMinutes,
        phaseType: s.phaseType as SchedulerPhase,
        isTimingSensitive: s.isTimingSensitive,
      })),
    }));

  const result = scheduleCookingSequence(schedulerDishes);

  return {
    sequence: result.steps,
    totalEstimatedMinutes: result.totalEstimatedMinutes,
    dishCount,
    usedAI: false,
  };
}
