// Cook Mode family — routes for in-cooking and pre-cooking AI helpers.
//
// Endpoints:
//   POST /api/meals/:mealId/cooking-sequence   — 6d-1, Cook Mode launch
//   POST /api/plans/:planId/prep-week          — 6d-2, Prep the Week aggregation
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts / plans.ts
// so unit tests can inject stubbed loaders + prisma + subscription service
// without standing up the full stack.

import { Router, type IRouter, type Request } from "express";
import type { PrismaClient } from "@prisma/client";

import {
  runCookingSequence as productionRunCookingSequence,
  CookingSequenceAIError,
  CookingSequenceEmptyMealError,
  CookingSequenceNotFoundError,
  EMPTY_MEAL_COPY,
} from "../lib/cookingSequence";
import {
  loadPrepWeekInput as productionLoadPrepWeekInput,
  PrepWeekEmptyPlanError,
  PrepWeekNotFoundError,
  EMPTY_PLAN_COPY,
} from "../lib/prepWeekAggregation";
import { runAICall as productionRunAICall } from "../lib/ai/runAICall";
import {
  PrepWeekResultSchema,
  type PrepWeekResult,
} from "../lib/ai/schemas/prepWeek";
import { buildPrepCombineInput } from "../lib/prepCombineAdapter";
import { combinePrep } from "../lib/prepCombineEngine";
import {
  buildStepPlan,
  assemblePrepWeekResult,
  PrepNarrationIncompleteError,
} from "../lib/prepWeekAssembly";
import { PrepNarrationResultSchema } from "../lib/ai/schemas/prepNarration";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import {
  subscriptionService as productionSubscriptionService,
  type SubscriptionService,
} from "../lib/subscriptionService";
import { requireAuth } from "../middleware/auth";

// UUID v1-v5 — same shape Zod uses; pre-validating in the route lets us
// return 400 cleanly before we hit the DB.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CookingRouterDeps {
  runCookingSequence: typeof productionRunCookingSequence;
  loadPrepWeekInput: typeof productionLoadPrepWeekInput;
  prisma: PrismaClient;
  runAICall: typeof productionRunAICall;
  subscriptionService: SubscriptionService;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

export function createCookingRouter(
  deps: Partial<CookingRouterDeps> = {},
): IRouter {
  const runCookingSequence =
    deps.runCookingSequence ?? productionRunCookingSequence;
  const loadPrepWeekInput =
    deps.loadPrepWeekInput ?? productionLoadPrepWeekInput;
  const prisma = deps.prisma ?? productionPrisma;
  const runAICall = deps.runAICall ?? productionRunAICall;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
  // Per-user token-bucket. Cook Mode launches are not high-frequency;
  // 12/min matches the editing-cadence tier used elsewhere and provides
  // a tight cost-of-bug ceiling for the Sonnet call. Shared between
  // sequencer and prep-week — both are launch-pad endpoints.
  const limiterOpts = deps.rateLimiterOpts ?? {
    capacity: 12,
    refillPerSec: 12 / 60,
  };

  const router: IRouter = Router();

  const sequencerLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `sequencer:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/meals/:mealId/cooking-sequence",
    requireAuth,
    sequencerLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const mealIdRaw = req.params.mealId;
      const mealId = Array.isArray(mealIdRaw) ? mealIdRaw[0] : mealIdRaw;
      if (!mealId || typeof mealId !== "string") {
        return res.status(400).json({ error: "missing meal id" });
      }

      try {
        const result = await runCookingSequence({
          mealId,
          userId,
          deps: { prisma, runAICall },
        });
        return res.json({
          sequence: result.sequence,
          totalEstimatedMinutes: result.totalEstimatedMinutes,
          dishCount: result.dishCount,
          usedAI: result.usedAI,
        });
      } catch (err) {
        if (err instanceof CookingSequenceNotFoundError) {
          return res.status(404).json({ error: "meal not found" });
        }
        if (err instanceof CookingSequenceEmptyMealError) {
          return res.status(400).json({ error: EMPTY_MEAL_COPY });
        }
        if (err instanceof CookingSequenceAIError) {
          return res.status(502).json({
            error: err.userFacingMessage,
            reason: err.reason,
          });
        }
        logger.error(
          { event: "cooking_sequence_failed", userId, mealId, err },
          "Cooking sequence failed unexpectedly",
        );
        return res.status(500).json({ error: "internal server error" });
      }
    },
  );

  // ── POST /plans/:planId/prep-week — 6d-2 Prep the Week aggregation ───

  const prepWeekLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `prepweek:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/plans/:planId/prep-week",
    requireAuth,
    prepWeekLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      const planIdRaw = req.params.planId;
      const planId = Array.isArray(planIdRaw) ? planIdRaw[0] : planIdRaw;
      if (!planId || typeof planId !== "string" || !UUID_RE.test(planId)) {
        return res.status(400).json({ error: "invalid plan id" });
      }

      // 1. Entitlement check. Stripe-phase swap-in lands here.
      const ent = await subscriptionService.can(
        userId,
        "prep_the_week_orchestrated",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Prep the Week is a Premium feature",
        });
      }

      // 2. Load the plan + meals payload AND read revisionId, both from
      //    one query in the loader.
      let loadResult;
      try {
        loadResult = await loadPrepWeekInput({ planId, userId, prisma });
      } catch (err) {
        if (err instanceof PrepWeekNotFoundError) {
          return res.status(404).json({ error: "plan not found" });
        }
        if (err instanceof PrepWeekEmptyPlanError) {
          return res.status(400).json({ error: EMPTY_PLAN_COPY });
        }
        logger.error(
          { event: "prep_week_load_failed", userId, planId, err },
          "Prep the Week loader failed unexpectedly",
        );
        return res.status(500).json({ error: "internal server error" });
      }
      const { input, planRevisionId } = loadResult;

      // 3. Cache lookup. Hit + matching revisionId returns the stored
      //    structureJson without an AI call (no LLMCallLog row).
      const cached = await prisma.prepWeekStructure.findUnique({
        where: { planId },
      });
      if (cached && cached.lastGeneratedFromPlanRevisionId === planRevisionId) {
        return res.json({
          cacheHit: true,
          result: cached.structureJson as unknown as PrepWeekResult,
          planRevisionId,
          generatedAt: cached.lastGeneratedAt.toISOString(),
          promptVersion: cached.promptVersion,
        });
      }

      // 4. Cache miss or stale. BLENDED path: deterministic engine does ALL
      //    grouping / summing / scaling / attribution / phase placement; the
      //    AI is called only to narrate the computed step plan into prose.
      const combineInput = buildPrepCombineInput(input);
      const combineResult = combinePrep(combineInput);
      const stepPlan = buildStepPlan(combineResult, input.planName);

      // Nothing in the plan is prep-worthy (all denylisted / buy-and-use) —
      // same 400 + copy as a structurally empty plan.
      if (stepPlan.steps.length === 0) {
        return res.status(400).json({ error: EMPTY_PLAN_COPY });
      }

      const aiResult = await runAICall(
        "prep.narrate_steps",
        { prepNarrationInput: stepPlan.narrationInput },
        PrepNarrationResultSchema,
        { prisma, userId },
      );

      if (!aiResult.success) {
        logger.warn(
          {
            event: "prep_week_ai_failed",
            userId,
            planId,
            reason: aiResult.reason,
            promptKey: "prep.narrate_steps",
          },
          "Prep the Week narration AI call failed",
        );
        return res.status(502).json({
          error: aiResult.userFacingMessage,
          reason: aiResult.reason,
        });
      }

      // 5. Assemble the response IN CODE. Numeric + attribution fields come
      //    from the engine/step plan; only title/instructions/storageNote/
      //    estimatedMinutes come from the AI. The narration schema has no
      //    quantity or mealId field, so prose cannot move the math — fail
      //    closed if the AI didn't narrate every planned step.
      let assembled: PrepWeekResult;
      try {
        assembled = assemblePrepWeekResult(stepPlan, aiResult.data);
      } catch (err) {
        if (err instanceof PrepNarrationIncompleteError) {
          logger.warn(
            {
              event: "prep_week_narration_incomplete",
              userId,
              planId,
              missing: err.missingStepIds.slice(0, 10),
              missingCount: err.missingStepIds.length,
            },
            "Prep the Week narration omitted planned steps",
          );
          return res.status(502).json({
            error: "Kiwi got distracted. Try again?",
            reason: "narration_incomplete",
          });
        }
        throw err;
      }

      // 6. Defensive: the assembled result must satisfy the locked wire
      //    contract (mobile shape unchanged). Step/phase ceilings live here.
      const validated = PrepWeekResultSchema.safeParse(assembled);
      if (!validated.success) {
        logger.warn(
          {
            event: "prep_week_assembly_invalid",
            userId,
            planId,
            error: validated.error.flatten(),
          },
          "Assembled Prep the Week result failed schema validation",
        );
        return res.status(502).json({
          error: "Kiwi got distracted. Try again?",
          reason: "assembly_invalid",
        });
      }
      const result = validated.data;

      // 7. Defensive assertion — attribution is now code-owned, so this should
      //    never fire. Kept as a guard that every contributesToMealId traces
      //    to a real input meal.
      const validMealIds = new Set(input.meals.map((m) => m.mealId));
      const invalidRefs: string[] = [];
      for (const phase of result.phases) {
        for (const step of phase.steps) {
          for (const id of step.contributesToMealIds) {
            if (!validMealIds.has(id)) invalidRefs.push(id);
          }
        }
      }
      if (invalidRefs.length > 0) {
        logger.warn(
          {
            event: "prep_week_invalid_meal_ref",
            userId,
            planId,
            invalidRefs: invalidRefs.slice(0, 10),
            invalidCount: invalidRefs.length,
          },
          "Prep the Week produced unknown mealIds (code-owned — unexpected)",
        );
        return res.status(502).json({
          error: "Kiwi got distracted. Try again?",
          reason: "invalid_meal_reference",
        });
      }

      // 8. Cache write. UPSERT keyed by planId — covers create (cache
      //    miss, no prior row) AND stale-update (revisionId moved) in
      //    one operation.
      const promptVersion = aiResult.metadata.promptVersion ?? 0;
      const structureJson = result as unknown as object;
      try {
        await prisma.prepWeekStructure.upsert({
          where: { planId },
          create: {
            planId,
            structureJson,
            lastGeneratedFromPlanRevisionId: planRevisionId,
            lastGeneratedAt: new Date(),
            promptVersion,
          },
          update: {
            structureJson,
            lastGeneratedFromPlanRevisionId: planRevisionId,
            lastGeneratedAt: new Date(),
            promptVersion,
          },
        });
      } catch (err) {
        // Cache-write failures must not bubble up — the AI result is
        // already in memory and the caller can still use it. Next call
        // will retry the cache write.
        logger.warn(
          { event: "prep_week_cache_write_failed", userId, planId, err },
          "Prep the Week cache write failed",
        );
      }

      return res.json({
        cacheHit: false,
        result,
        planRevisionId,
        generatedAt: new Date().toISOString(),
        promptVersion,
        metadata: {
          latencyMs: aiResult.metadata.latencyMs,
        },
      });
    },
  );

  return router;
}

const router = createCookingRouter();
export default router;
