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
import { z } from "zod";

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
import {
  stepKeysOfResult,
  derivePrepCompletion,
  effectivePrepStatus,
} from "../lib/prepCompletion";
import { loadPrepStepSet } from "../lib/prepStepSet";
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

// BUG-022 — prep.narrate_steps output ceiling. runAICall defaults to 4096
// output tokens, but this call narrates the WHOLE week in one shot:
// PrepNarrationResultSchema.steps is a flat array up to 120 entries, each with
// instructions ≤800 chars (~200 tok) + title + storageNote (~340 tok worst case,
// ~120 typical). A heavy real plan (~30-50 steps) blows past 4096, so the forced
// tool_use JSON truncates mid-array → parses to {} → "steps: Required" → 502
// (observed: 48.8k-input plan, both attempts capped at exactly 4096 out). max_tokens
// is a CEILING (billed only for tokens generated), so we size it generously for
// realistic plans. Residual: a pathological plan near the 120-step schema ceiling
// could still truncate — the durable fix there is chunked narration (deferral TBD).
const PREP_NARRATION_MAX_TOKENS = 16384;

export interface CookingRouterDeps {
  runCookingSequence: typeof productionRunCookingSequence;
  loadPrepWeekInput: typeof productionLoadPrepWeekInput;
  prisma: PrismaClient;
  runAICall: typeof productionRunAICall;
  subscriptionService: SubscriptionService;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
  // WS7-8a B3 — separate (more generous) bucket for the free checkbox
  // toggle/read endpoints; checking off a prep list is bursty and must not
  // share the tight 12/min AI-launch bucket above.
  completionLimiterOpts?: { capacity: number; refillPerSec: number };
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
  // WS7-8a B3 — checkbox toggle/read tier. Matches plans.ts mutationLimiter
  // (60/min, 1/sec sustained) so rapid box-ticking isn't throttled.
  const completionLimiterOpts = deps.completionLimiterOpts ?? {
    capacity: 60,
    refillPerSec: 60 / 60,
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
      // WS7-8a B2b — step text per dishId (folded dish + meal owned) so the
      // narration layer can judge combine-vs-season and demote skip steps.
      const stepTextByDishId = new Map<string, string[]>();
      for (const meal of input.meals) {
        for (const dish of meal.dishes) {
          stepTextByDishId.set(dish.dishId, dish.stepTexts);
        }
      }
      const stepPlan = buildStepPlan(
        combineResult,
        input.planName,
        stepTextByDishId,
      );

      // Nothing in the plan is prep-worthy (all denylisted / buy-and-use) —
      // same 400 + copy as a structurally empty plan.
      if (stepPlan.steps.length === 0) {
        return res.status(400).json({ error: EMPTY_PLAN_COPY });
      }

      const aiResult = await runAICall(
        "prep.narrate_steps",
        { prepNarrationInput: stepPlan.narrationInput },
        PrepNarrationResultSchema,
        { prisma, userId, maxTokens: PREP_NARRATION_MAX_TOKENS },
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

        // WS7-8a B3 — orphan-prune. structureJson is regenerated wholesale, so
        // any PrepStepCompletion row whose stepKey is no longer in the fresh
        // step set is stale (its step was dropped / re-keyed by the edit that
        // bumped the revision). Prune to the new set — do NOT merge-forward
        // blindly. Still-valid keys (same ingredient → same key) survive.
        const keepKeys = [...stepKeysOfResult(result)];
        await prisma.prepStepCompletion.deleteMany({
          where: { planId, stepKey: { notIn: keepKeys } },
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

  // ── WS7-8a B3 — prep-step checkbox persistence (D-WS7-153) ────────────
  // Free (no entitlement check — only AI generation above is premium). Plan
  // ownership is enforced as-404 (cookingSequence convention: never leak a
  // plan's existence to a non-owner). State is one PrepStepCompletion row per
  // checked step; the row's presence IS the checked state.

  const completionLimiter = rateLimit({
    ...completionLimiterOpts,
    keyFn: (req: Request) => `prepcompletion:${req.userId ?? "anonymous"}`,
  });

  const StepKeyBody = z
    .object({ stepKey: z.string().min(1).max(80) })
    .strict();

  // Shared planId param guard.
  const readPlanId = (req: Request): string | null => {
    const raw = req.params.planId;
    const planId = Array.isArray(raw) ? raw[0] : raw;
    if (!planId || typeof planId !== "string" || !UUID_RE.test(planId)) {
      return null;
    }
    return planId;
  };

  // GET …/prep-week/completions — all checked rows + derived per-meal map +
  // the rolled-up (or manually-pinned) prepStatus.
  router.get(
    "/plans/:planId/prep-week/completions",
    requireAuth,
    completionLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const planId = readPlanId(req);
      if (!planId) return res.status(400).json({ error: "invalid plan id" });

      const plan = await prisma.mealPlanInstance.findUnique({
        where: { id: planId },
        select: {
          userId: true,
          prepStatus: true,
          prepStatusIsManual: true,
          items: { select: { mealId: true } },
        },
      });
      if (!plan || plan.userId !== userId) {
        return res.status(404).json({ error: "plan not found" });
      }

      const rows = await prisma.prepStepCompletion.findMany({
        where: { planId },
        orderBy: { checkedAt: "asc" },
        select: { stepKey: true, checkedAt: true },
      });

      // Denominator = the plan's full meal universe (deduped). Zero-prep meals
      // roll up as vacuously prepped (D-WS7-153 ruling). Steps = the freshly
      // assembled deterministic set (no AI), so an all-easy plan correctly
      // reports prepped and a fresh prep-worthy plan reports not_prepped.
      const allMealIds = [...new Set(plan.items.map((i) => i.mealId))];
      const steps = await loadPrepStepSet({
        planId,
        userId,
        prisma,
        loadPrepWeekInput,
      });
      const checkedKeys = new Set(rows.map((r) => r.stepKey));
      const { perMeal, derivedPrepStatus } = derivePrepCompletion(
        allMealIds,
        steps,
        checkedKeys,
      );

      return res.json({
        completions: rows.map((r) => ({
          stepKey: r.stepKey,
          checkedAt: r.checkedAt.toISOString(),
        })),
        perMeal,
        derivedPrepStatus,
        prepStatusIsManual: plan.prepStatusIsManual,
        prepStatus: effectivePrepStatus(
          plan.prepStatusIsManual,
          plan.prepStatus,
          derivedPrepStatus,
        ),
      });
    },
  );

  // PUT …/prep-week/completions — check a step (idempotent upsert). Per the B3
  // design, a check is just a row upsert: there is no stepKey allowlist here.
  // Orphan rows (a key not in the freshly assembled step set) are ignored by
  // the per-meal derivation and swept by the regenerate prune, so the rollup
  // can never be corrupted by a junk key — keeping this endpoint a cheap write
  // (ownership only, no structure load on the bursty check path).
  router.put(
    "/plans/:planId/prep-week/completions",
    requireAuth,
    completionLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const planId = readPlanId(req);
      if (!planId) return res.status(400).json({ error: "invalid plan id" });

      const parsed = StepKeyBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid body" });
      }
      const { stepKey } = parsed.data;

      const plan = await prisma.mealPlanInstance.findUnique({
        where: { id: planId },
        select: { userId: true },
      });
      if (!plan || plan.userId !== userId) {
        return res.status(404).json({ error: "plan not found" });
      }

      await prisma.prepStepCompletion.upsert({
        where: { planId_stepKey: { planId, stepKey } },
        create: { planId, stepKey },
        update: {}, // idempotent — keep the original checkedAt on re-check.
      });

      return res.json({ stepKey, checked: true });
    },
  );

  // DELETE …/prep-week/completions — uncheck a step (idempotent delete). No
  // structure lookup: deleting a missing/orphan row is a harmless no-op, which
  // is exactly the desired uncheck semantics.
  router.delete(
    "/plans/:planId/prep-week/completions",
    requireAuth,
    completionLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const planId = readPlanId(req);
      if (!planId) return res.status(400).json({ error: "invalid plan id" });

      const parsed = StepKeyBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid body" });
      }
      const { stepKey } = parsed.data;

      const plan = await prisma.mealPlanInstance.findUnique({
        where: { id: planId },
        select: { userId: true },
      });
      if (!plan || plan.userId !== userId) {
        return res.status(404).json({ error: "plan not found" });
      }

      await prisma.prepStepCompletion.deleteMany({ where: { planId, stepKey } });

      return res.json({ stepKey, checked: false });
    },
  );

  return router;
}

const router = createCookingRouter();
export default router;
