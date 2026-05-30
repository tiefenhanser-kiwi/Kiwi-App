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
  type WizardFinalizeStepsResult,
} from "./ai/schemas/wizard";
import { WizardDraftMalformedError, WizardDraftNotFoundError } from "./wizardActivation";

// Steps-only output is much smaller than the old 16k full-expand. 8k
// covers a 7-meal × 3-dish plan with ~12 steps per dish at ~50 tokens each
// (~14k worst-case, but real plans land well inside 8k). Held at 8k as
// the headroom budget; if real telemetry shows tail truncation, raise.
const WIZARD_FINALIZE_STEPS_MAX_TOKENS = 8192;

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

  // 3. Run the finalize-steps AI call. Sonnet, tool_use. The prompt
  //    instructs the model to return per-dish steps keyed by
  //    (mealIndex, dishIndex) so the merge is positional.
  const ai = await runAICall(
    "wizard.candidate.finalize_steps",
    { finalizeInput: details },
    WizardFinalizeStepsResultSchema,
    {
      prisma,
      userId,
      maxTokens: WIZARD_FINALIZE_STEPS_MAX_TOKENS,
    },
  );
  if (!ai.success) {
    logger.warn(
      {
        event: "wizard_finalize_steps_failed",
        userId,
        draftId,
        reason: ai.reason,
        promptKey: "wizard.candidate.finalize_steps",
      },
      "Wizard finalize-steps AI call failed",
    );
    return {
      status: "ai_failed",
      reason: ai.reason,
      userFacingMessage: ai.userFacingMessage,
    };
  }

  // 4. Merge: positionally insert steps into the details payload.
  const merged = mergeFinalizeStepsIntoDetails(details, ai.data);
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
