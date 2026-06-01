// WS7-5c Block A — wizard finalize-steps orchestration.
//
// Call #3 of the three-stage wizard (PRD §5.6 redline). The "view details"
// step (WS7-5a expand → call #2) now persists a stepless details-stage
// draft so users only pay the Sonnet latency for plans they wouldn't keep
// once. Activate/save flips: read the stepless draft, generate per-dish
// steps via wizard.candidate.finalize_steps, merge them positionally back
// in, and hand the merged with-steps shape to the materializer.
//
// Runs OUTSIDE the activate/save $transaction by design — the 60s tx
// budget is sized for the materializer alone (see wizard.ts:838-852); a
// ~Sonnet call inside the tx would blow that budget. The orchestration
// here is the bridge between the route read and the tx-bounded write.

import type { PrismaClient } from "@prisma/client";

import { logger } from "./logger";
import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  WizardExpandedPlanDetailsSchema,
  WizardExpandedPlanSchema,
  WizardFinalizeStepsResultSchema,
  type WizardExpandedPlan,
  type WizardExpandedPlanDetails,
  type WizardExpandEnrichedMealDetails,
  type WizardFinalizeStepsDish,
  type WizardFinalizeStepsResult,
} from "./ai/schemas/wizard";
import { WizardDraftMalformedError, WizardDraftNotFoundError } from "./wizardActivation";

// WS7-5c tail — sized for ONE meal's step output, not the whole plan. A
// typical meal is ~3 dishes × ~6-10 steps × ~50-80 tokens per step ≈
// ~1.5-2.5k tokens worst-case. 3k carries ~30% headroom over the realistic
// ceiling while staying comfortably below the prior 8k plan-wide budget.
// If real per-meal telemetry shows tail truncation on the longest meals,
// this is the dial to raise.
const WIZARD_FINALIZE_STEPS_PER_MEAL_MAX_TOKENS = 3072;

export interface ReadAndFinalizeWizardDraftOptions {
  prisma: PrismaClient;
  userId: string;
  draftId: string;
  runAICall?: typeof productionRunAICall;
}

export type ReadAndFinalizeWizardDraftResult =
  | { status: "success"; payload: WizardExpandedPlan; details: WizardExpandedPlanDetails }
  | { status: "not_found" }
  | { status: "malformed"; reason: string }
  | { status: "ai_failed"; reason: string; userFacingMessage: string }
  | { status: "merge_failed"; reason: string };

/**
 * Read the hidden details-stage wizard draft, run the finalize-steps AI
 * call, and merge per-dish steps back into the plan to produce a
 * WizardExpandedPlan ready for the materializer.
 *
 * Failure modes (the route handler maps each to a status code):
 *   - not_found        → draft missing / not owned / not a wizard draft (404)
 *   - malformed        → stored draft fails WizardExpandedPlanDetailsSchema (422)
 *   - ai_failed        → wizard.candidate.finalize_steps failed (502)
 *   - merge_failed     → AI output didn't cover every (mealIndex,dishIndex)
 *                        OR merged payload failed WizardExpandedPlanSchema (422)
 */
export async function readAndFinalizeWizardDraft(
  opts: ReadAndFinalizeWizardDraftOptions,
): Promise<ReadAndFinalizeWizardDraftResult> {
  const { prisma, userId, draftId } = opts;
  const runAICall = opts.runAICall ?? productionRunAICall;

  // 1. Read draft row + ownership check.
  const row = await prisma.mealPlanInstance.findUnique({
    where: { id: draftId },
    select: {
      userId: true,
      isWizardDraft: true,
      optimizationNotes: true,
    },
  });
  if (!row || row.userId !== userId || !row.isWizardDraft) {
    return { status: "not_found" };
  }

  // 2. Parse the stored details-stage shape.
  const detailsParse = WizardExpandedPlanDetailsSchema.safeParse(
    row.optimizationNotes,
  );
  if (!detailsParse.success) {
    const reason =
      detailsParse.error.issues
        .slice(0, 3)
        .map((i) => i.path.join(".") || "root")
        .join(",") || "shape_mismatch";
    return { status: "malformed", reason };
  }
  const details = detailsParse.data;

  // 3. Run the finalize-steps AI call SHARDED — one Sonnet call per meal,
  //    Promise.all fan-out. Mirrors the proven per-meal expand pattern
  //    (wizardExpansion.ts:83). The pre-shard path issued one whole-plan
  //    call that measured ~51s on device (May 31 telemetry); fanning out
  //    cuts wall-clock to ~the slowest single-meal call.
  //
  //    Slicing: each shard receives a single-meal details slice (the AI
  //    prompt is unchanged — it just sees a 1-meal `meals[]` and returns
  //    mealIndex=0 for each dish). The server re-indexes mealIndex from
  //    0 → the real meal index during concatenation, so the seeded prompt
  //    body needs no edit.
  const perMealResults = await Promise.all(
    details.meals.map((meal, mi) =>
      finalizeOneMeal({
        runAICall,
        prisma,
        userId,
        details,
        mealIndex: mi,
        meal,
      }),
    ),
  );

  const firstFailure = perMealResults.find((r) => !r.ok);
  if (firstFailure && !firstFailure.ok) {
    logger.warn(
      {
        event: "wizard_finalize_steps_failed",
        userId,
        draftId,
        mealIndex: firstFailure.mealIndex,
        reason: firstFailure.reason,
        promptKey: "wizard.candidate.finalize_steps",
      },
      "Wizard finalize-steps AI call failed",
    );
    return {
      status: "ai_failed",
      reason: `meal_failed:${firstFailure.mealIndex}:${firstFailure.reason}`,
      userFacingMessage: firstFailure.userFacingMessage,
    };
  }

  // Concatenate the N per-meal dishSteps[] arrays into a single result,
  // re-indexing mealIndex from the shard-local 0 to the real meal index.
  const assembledDishSteps: WizardFinalizeStepsDish[] = [];
  for (const r of perMealResults) {
    if (!r.ok) continue; // already returned above; type-narrowing only.
    for (const entry of r.dishSteps) {
      assembledDishSteps.push({
        mealIndex: r.mealIndex,
        dishIndex: entry.dishIndex,
        steps: entry.steps,
      });
    }
  }
  const assembled: WizardFinalizeStepsResult = {
    dishSteps: assembledDishSteps,
  };

  // 4. Merge: positionally insert steps into the details payload. The
  //    mergeFinalizeStepsIntoDetails invariants (no dup / no missing /
  //    no extra) still apply to the assembled array — that's exactly
  //    the safety property the per-meal fan-out preserves.
  const merged = mergeFinalizeStepsIntoDetails(details, assembled);
  if (merged.status !== "ok") {
    logger.warn(
      {
        event: "wizard_finalize_steps_merge_failed",
        userId,
        draftId,
        reason: merged.reason,
      },
      "Wizard finalize-steps merge failed",
    );
    return { status: "merge_failed", reason: merged.reason };
  }

  // 5. Defensive: the merged shape must satisfy the materializer's read-side
  //    schema (the §27 round-trip contract). The mergeFinalizeStepsIntoDetails
  //    helper enforces the same invariants, but parsing here pins it as the
  //    durable check.
  const finalParse = WizardExpandedPlanSchema.safeParse(merged.payload);
  if (!finalParse.success) {
    const reason =
      finalParse.error.issues
        .slice(0, 3)
        .map((i) => i.path.join(".") || "root")
        .join(",") || "merged_shape_mismatch";
    return { status: "merge_failed", reason };
  }

  return { status: "success", payload: finalParse.data, details };
}

// ── merge helper (exported for tests) ────────────────────────────────────

export type MergeFinalizeStepsResult =
  | { status: "ok"; payload: WizardExpandedPlan }
  | { status: "error"; reason: string };

/**
 * Positionally merge the finalize-steps AI output into a details-stage
 * plan to produce the with-steps WizardExpandedPlan shape.
 *
 * Invariants:
 *   - Every (mealIndex, dishIndex) pair in the input details MUST have
 *     a matching entry in `result.dishSteps`. Missing → error.
 *   - Every entry in `result.dishSteps` MUST reference a real
 *     (mealIndex, dishIndex) pair. Out-of-range → error.
 *   - Duplicate (mealIndex, dishIndex) entries in `result.dishSteps`
 *     → error.
 */
export function mergeFinalizeStepsIntoDetails(
  details: WizardExpandedPlanDetails,
  result: WizardFinalizeStepsResult,
): MergeFinalizeStepsResult {
  const keyed = new Map<string, string[]>();
  for (const entry of result.dishSteps) {
    const key = `${entry.mealIndex}:${entry.dishIndex}`;
    if (keyed.has(key)) {
      return {
        status: "error",
        reason: `duplicate_dish_steps:${key}`,
      };
    }
    keyed.set(key, entry.steps);
  }

  const mergedMeals = [];
  for (let mi = 0; mi < details.meals.length; mi++) {
    const meal = details.meals[mi];
    const mergedDishes = [];
    for (let di = 0; di < meal.dishes.length; di++) {
      const dish = meal.dishes[di];
      const steps = keyed.get(`${mi}:${di}`);
      if (!steps) {
        return {
          status: "error",
          reason: `missing_dish_steps:${mi}:${di}`,
        };
      }
      keyed.delete(`${mi}:${di}`);
      mergedDishes.push({ ...dish, steps });
    }
    mergedMeals.push({ ...meal, dishes: mergedDishes });
  }

  if (keyed.size > 0) {
    const [extraKey] = keyed.keys();
    return {
      status: "error",
      reason: `extra_dish_steps:${extraKey}`,
    };
  }

  return {
    status: "ok",
    payload: {
      candidateId: details.candidateId,
      title: details.title,
      tags: details.tags,
      whyBullets: details.whyBullets,
      meals: mergedMeals,
    },
  };
}

// ── route helper ────────────────────────────────────────────────────────

/**
 * Convenience for the route layer: turns a finalize result into a Prisma-
 * style error or returns the payload. The route handler is responsible
 * for the HTTP response; this helper just shrinks the boilerplate.
 *
 * Mapping:
 *   - not_found     → WizardDraftNotFoundError (route returns 404)
 *   - malformed     → WizardDraftMalformedError (route returns 422)
 *   - merge_failed  → WizardDraftMalformedError (route returns 422)
 *
 * AI failures are NOT thrown — the caller branches on the discriminated
 * union so the 502 response can surface the userFacingMessage.
 */
export function unwrapFinalizeResultOrThrow(
  result: ReadAndFinalizeWizardDraftResult,
  draftId: string,
): WizardExpandedPlan {
  if (result.status === "success") return result.payload;
  if (result.status === "not_found") {
    throw new WizardDraftNotFoundError(draftId);
  }
  if (result.status === "malformed" || result.status === "merge_failed") {
    throw new WizardDraftMalformedError(draftId, result.reason);
  }
  // ai_failed — caller must handle this branch before calling the helper.
  throw new Error(
    `wizard_finalize_unhandled_status:${result.status}`,
  );
}

// ── per-meal shard helper ────────────────────────────────────────────────

type PerMealFinalizeResult =
  | { ok: true; mealIndex: number; dishSteps: WizardFinalizeStepsDish[] }
  | {
      ok: false;
      mealIndex: number;
      reason: string;
      userFacingMessage: string;
    };

interface FinalizeOneMealOptions {
  runAICall: typeof productionRunAICall;
  prisma: PrismaClient;
  userId: string;
  // The full plan provides candidateId / title / tags / whyBullets so the
  // single-meal slice we send remains a valid WizardExpandedPlanDetails.
  details: WizardExpandedPlanDetails;
  mealIndex: number;
  meal: WizardExpandEnrichedMealDetails;
}

/**
 * Run wizard.candidate.finalize_steps for ONE meal. The AI sees a one-meal
 * slice and returns dishSteps keyed to that shard-local index space
 * (mealIndex=0 for every dish). The caller re-indexes mealIndex to the real
 * plan-level index during concatenation.
 *
 * Retry semantics: relies SOLELY on runAICall's built-in retry
 * (`retryOnValidationFailure: true` → up to 2 attempts). No meal-level
 * retry wrapper — that would compound to up to 4 Sonnet attempts on a
 * doomed meal. If runAICall fails for a meal, that meal fails; the caller
 * fails the whole finalize — all-or-nothing because the merge requires
 * every (mealIndex, dishIndex) pair.
 */
async function finalizeOneMeal(
  opts: FinalizeOneMealOptions,
): Promise<PerMealFinalizeResult> {
  const perMealInput: WizardExpandedPlanDetails = {
    candidateId: opts.details.candidateId,
    title: opts.details.title,
    tags: opts.details.tags,
    whyBullets: opts.details.whyBullets,
    meals: [opts.meal],
  };
  const ai = await opts.runAICall(
    "wizard.candidate.finalize_steps",
    { finalizeInput: perMealInput },
    WizardFinalizeStepsResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      maxTokens: WIZARD_FINALIZE_STEPS_PER_MEAL_MAX_TOKENS,
    },
  );
  if (!ai.success) {
    return {
      ok: false,
      mealIndex: opts.mealIndex,
      reason: ai.reason,
      userFacingMessage: ai.userFacingMessage,
    };
  }
  return {
    ok: true,
    mealIndex: opts.mealIndex,
    dishSteps: ai.data.dishSteps,
  };
}
