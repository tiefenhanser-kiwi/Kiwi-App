// Cook Mode family — routes for in-cooking and pre-cooking AI helpers.
//
// Endpoints:
//   POST /api/meals/:mealId/cooking-sequence   — 6d-1, Cook Mode launch
//   POST /api/plans/:planId/prep-week          — 6d-2, Prep the Week aggregation
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts / plans.ts
// so unit tests can inject stubbed loaders + prisma + subscription service
// without standing up the full stack.

import { Router, type IRouter, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import {
  runCookingSequence as productionRunCookingSequence,
  CookingSequenceEmptyMealError,
  CookingSequenceNotFoundError,
  EMPTY_MEAL_COPY,
} from "../lib/cookingSequence";
import {
  loadPrepWeekInput as productionLoadPrepWeekInput,
  PrepWeekEmptyPlanError,
  PrepWeekNotFoundError,
  PrepWeekUnknownMealError,
  EMPTY_PLAN_COPY,
} from "../lib/prepWeekAggregation";
import { runAICall as productionRunAICall } from "../lib/ai/runAICall";
import { withAIFailureStatus } from "../lib/ai/errors";
import { resolvePromptDescriptorFromDb as productionResolvePromptDescriptor } from "../lib/ai/promptRegistry";
import { feastSessionFingerprint, prepCompositionFingerprint } from "../lib/prepWeekFingerprint";
import {
  PrepWeekResultSchema,
  type PrepWeekResult,
} from "../lib/ai/schemas/prepWeek";
import {
  assemblePrepWeekResult,
  engineTitle,
  overCapPhases,
  PrepNarrationIncompleteError,
  summarizePrepWeek,
} from "../lib/prepWeekAssembly";
import {
  buildCoreWeek,
  buildFeastSession,
  coreScopeMealIds,
  FEAST_KEY_PREFIX,
  feastOnlyLoad,
  feastSessionDay,
  finishPrepWeek,
  wireStepKeys,
  withFeastKeys,
} from "../lib/prepWeekBuild";
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
  SUBSCRIPTION_REQUIRED_CODE,
  subscriptionService as productionSubscriptionService,
  type SubscriptionService,
} from "../lib/subscriptionService";
import { createRequireAuth } from "../middleware/auth";

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

/** PREP-1 (D-WS9-314) — a Prep Selected Meals run that named only the feast. */
export const FEAST_OWN_PREP_COPY = "The feast has its own prep. See Thanksgiving make-ahead.";

/**
 * PREP-1 (D-WS9-314) — the feast session as it is cached, under `feastSession` in
 * the week's `structureJson` (no migration). The result's keys are the ENGINE's;
 * the `feast#` prefix is put on at the response.
 */
export interface FeastSessionBlob {
  fingerprint: string;
  promptVersion: number;
  generatedAt: string;
  result: PrepWeekResult;
}

/** A cache row's JSON split into the week's result and the feast session (if any). */
export function splitStructure(json: unknown): { week: PrepWeekResult; feast: FeastSessionBlob | null } {
  const { feastSession, ...week } = (json ?? {}) as Record<string, unknown>;
  const f = feastSession as Partial<FeastSessionBlob> | undefined;
  const feast =
    f && typeof f.fingerprint === "string" && typeof f.promptVersion === "number" && typeof f.generatedAt === "string" && f.result
      ? (f as FeastSessionBlob)
      : null;
  return { week: week as unknown as PrepWeekResult, feast };
}

export interface CookingRouterDeps {
  runCookingSequence: typeof productionRunCookingSequence;
  loadPrepWeekInput: typeof productionLoadPrepWeekInput;
  prisma: PrismaClient;
  runAICall: typeof productionRunAICall;
  // WS9 — resolved for the prep-week cache gate, which folds the narrating
  // prompt version into the composition fingerprint. Injectable so a route test
  // can pin the version instead of driving it through the AIPrompt table.
  resolvePromptDescriptor: typeof productionResolvePromptDescriptor;
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
  // WS9A BUG-234 — the session guard now reads User.tokensValidFrom, so it
  // needs a Prisma client. Building it from the injected one (rather than
  // importing the singleton) is what keeps this router's tests hermetic.
  // Shadows the module import: every requireAuth call site below is unchanged.
  const requireAuth = createRequireAuth({ prisma });
  const runAICall = deps.runAICall ?? productionRunAICall;
  const resolvePromptDescriptor =
    deps.resolvePromptDescriptor ?? productionResolvePromptDescriptor;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
  // Per-user token-bucket, 12/min (editing-cadence tier). Shared between the
  // sequencer and prep-week. BUG-018 B2 removed the sequencer's Sonnet call, so
  // for it this is now just a DB-load guardrail (the compute is free +
  // deterministic); for prep-week it remains the premium-AI cost ceiling.
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
          deps: { prisma },
        });
        return res.json({
          sequence: result.sequence,
          totalEstimatedMinutes: result.totalEstimatedMinutes,
          dishCount: result.dishCount,
          usedAI: result.usedAI,
          ...(result.mergedSteps ? { mergedSteps: result.mergedSteps } : {}),
        });
      } catch (err) {
        if (err instanceof CookingSequenceNotFoundError) {
          return res.status(404).json({ error: "meal not found" });
        }
        if (err instanceof CookingSequenceEmptyMealError) {
          return res.status(400).json({ error: EMPTY_MEAL_COPY });
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

  // WS9 — Prep Selected Meals. The request body is OPTIONAL: no body (or `{}`)
  // is today's full-week behaviour, byte-unchanged. `mealIds` present switches
  // the aggregation to just those plan meals.
  //
  // Shape is validated here; MEMBERSHIP ("is this id actually in the plan?") is
  // validated in the loader, which is the only layer that has the plan loaded.
  // Both reject with 400 — an unknown id is never silently dropped.
  const PrepWeekBody = z
    .object({
      mealIds: z
        .array(z.string().uuid())
        .min(1, "mealIds must not be empty")
        .max(50)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "mealIds must not contain duplicates",
        })
        .optional(),
      // PREP-1 (D-WS9-314) — "Prep the feast": the feast meal's own session. A
      // 1.1 binary never sends it, so its requests are byte-unchanged.
      session: z.literal("feast").optional(),
    })
    .strict()
    .refine((b) => !(b.session && b.mealIds), {
      message: "a feast session takes no meal selection",
    });

  // The narration, the code assembly, the wire check and the attribution guard —
  // steps 4b–7, shared by the week and the feast session. A failure is the
  // response to send; a success is the validated result and the call's metadata.
  type Narrated =
    | { ok: true; result: PrepWeekResult; promptVersion: number; latencyMs: number }
    | { ok: false; status?: number; aiReason?: string; body: Record<string, unknown> };
  const sendFailure = (res: Response, n: Extract<Narrated, { ok: false }>) =>
    n.aiReason ? withAIFailureStatus(res, n.aiReason).json(n.body) : res.status(n.status ?? 502).json(n.body);
  const narrateStepPlan = async (
    stepPlan: ReturnType<typeof buildCoreWeek>["stepPlan"],
    input: { meals: { mealId: string }[] },
    ctx: { userId: string; planId: string },
  ): Promise<Narrated> => {
    const distracted = (reason: string): Narrated => ({
      ok: false,
      status: 502,
      body: { error: "Kiwi got distracted. Try again?", reason },
    });
    // PREP-1 (BUG-413) — the 30-step cap, checked BEFORE the narration is paid
    // for. The engine's backstop already moved any overflow to cook day, so this
    // is the guard that it did; the schema check below used to be the first
    // place an over-cap phase was noticed, after the AI call.
    const overCap = overCapPhases(stepPlan);
    if (overCap.length > 0) {
      logger.warn(
        { event: "prep_week_over_cap", ...ctx, phases: overCap },
        "Prep the Week phase over the step cap before narration",
      );
      return distracted("assembly_invalid");
    }

    const aiResult = await runAICall(
      "prep.narrate_steps",
      { prepNarrationInput: stepPlan.narrationInput },
      PrepNarrationResultSchema,
      { prisma, userId: ctx.userId, maxTokens: PREP_NARRATION_MAX_TOKENS },
    );
    if (!aiResult.success) {
      logger.warn(
        { event: "prep_week_ai_failed", ...ctx, reason: aiResult.reason, promptKey: "prep.narrate_steps" },
        "Prep the Week narration AI call failed",
      );
      // The status (and a spend guard's Retry-After) is set on the real response.
      return { ok: false, aiReason: aiResult.reason, body: { error: aiResult.userFacingMessage, reason: aiResult.reason } };
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
            ...ctx,
            missing: err.missingStepIds.slice(0, 10),
            missingCount: err.missingStepIds.length,
          },
          "Prep the Week narration omitted planned steps",
        );
        return distracted("narration_incomplete");
      }
      throw err;
    }

    // 6. Defensive: the assembled result must satisfy the locked wire
    //    contract (mobile shape unchanged). Step/phase ceilings live here.
    const validated = PrepWeekResultSchema.safeParse(assembled);
    if (!validated.success) {
      logger.warn(
        { event: "prep_week_assembly_invalid", ...ctx, error: validated.error.flatten() },
        "Assembled Prep the Week result failed schema validation",
      );
      return distracted("assembly_invalid");
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
          ...ctx,
          invalidRefs: invalidRefs.slice(0, 10),
          invalidCount: invalidRefs.length,
        },
        "Prep the Week produced unknown mealIds (code-owned — unexpected)",
      );
      return distracted("invalid_meal_reference");
    }
    return {
      ok: true,
      result,
      promptVersion: aiResult.metadata.promptVersion ?? 0,
      latencyMs: aiResult.metadata.latencyMs,
    };
  };

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

      // 0. WS9 — optional meal subset. Parsed before the entitlement call so a
      //    malformed body never spends a gate check. `req.body` is `{}` when the
      //    caller sends nothing (express.json), and `undefined` if no json body
      //    parser ran — both mean "full week".
      const parsedBody = PrepWeekBody.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({
          error: "invalid meal selection",
          reason: "invalid_meal_selection",
          details: parsedBody.error.flatten(),
        });
      }
      const subsetMealIds = parsedBody.data.mealIds;
      const isSubset = subsetMealIds !== undefined;

      // 1. Entitlement check. Stripe-phase swap-in lands here. Identical for a
      //    subset — the feature gate is the feature gate. So is the rate-limit
      //    bucket above (same keyFn, same limiter instance).
      const ent = await subscriptionService.can(
        userId,
        "prep_the_week_orchestrated",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          code: ent.code ?? SUBSCRIPTION_REQUIRED_CODE,
          reason: ent.reason ?? "Prep the Week is a Premium feature",
        });
      }

      // 2. Load the plan + meals payload AND read revisionId, both from
      //    one query in the loader.
      let loadResult;
      try {
        loadResult = await loadPrepWeekInput({
          planId,
          userId,
          prisma,
          mealIds: subsetMealIds,
        });
      } catch (err) {
        if (err instanceof PrepWeekNotFoundError) {
          return res.status(404).json({ error: "plan not found" });
        }
        if (err instanceof PrepWeekEmptyPlanError) {
          return res.status(400).json({ error: EMPTY_PLAN_COPY });
        }
        // WS9 — a named meal that isn't in this plan. 400, and it says WHICH.
        if (err instanceof PrepWeekUnknownMealError) {
          return res.status(400).json({
            error: "Those meals aren't in this plan.",
            reason: "unknown_meal_ids",
            unknownMealIds: err.unknownMealIds,
          });
        }
        logger.error(
          { event: "prep_week_load_failed", userId, planId, err },
          "Prep the Week loader failed unexpectedly",
        );
        return res.status(500).json({ error: "internal server error" });
      }
      const { input, planRevisionId, cookDays, identity } = loadResult;

      // ── PREP-1 (D-WS9-314) — "PREP THE FEAST" ─────────────────────────────
      //
      // The feast's own session: the same engine, the same screen, scoped to the
      // feast and keyed `feast#…`. Cached in the SAME row as the week, inside its
      // JSON (`feastSession`), gated by its own fingerprint and prompt version;
      // one narration per regeneration. The week's columns are left alone, so the
      // two sessions miss and hit independently.
      if (parsedBody.data.session === "feast") {
        const build = buildFeastSession({ input, cookDays, identity });
        if (!build) {
          return res.status(400).json({ error: "This plan has no feast to prep.", reason: "no_feast" });
        }
        const envelope = {
          subset: false,
          session: "feast" as const,
          // "Label the session Wednesday" — the day before the feast. KEPT for the
          // shipped clients, whose notice reads "For <sessionDay>, the day before the
          // feast": a new value there would print a false sentence.
          sessionDay: feastSessionDay({ input, cookDays }),
          // THX-3 (D-WS9-316) — the session holds the make-ahead dishes' shelf-stable
          // mixes, so it is done BEFORE the first day one of them is used ("Monday").
          // Additive and optional; the client lane words the notice from it.
          ...(build.sessionBefore ? { sessionBefore: build.sessionBefore } : {}),
          planRevisionId,
        };
        // PREP-1 G — the feast's own inputs only: a weeknight swap keeps this cache.
        const fingerprint = feastSessionFingerprint(feastOnlyLoad({ input, cookDays, identity })!.input);
        const activeVersion = (await resolvePromptDescriptor("prep.narrate_steps", prisma)).version;
        const row = await prisma.prepWeekStructure.findUnique({ where: { planId } });
        const stored = row ? splitStructure(row.structureJson).feast : null;
        if (
          stored &&
          stored.fingerprint === fingerprint &&
          (activeVersion === null || stored.promptVersion === activeVersion)
        ) {
          return res.json({
            cacheHit: true,
            ...envelope,
            result: withFeastKeys(summarizePrepWeek(finishPrepWeek(stored.result, build))),
            generatedAt: stored.generatedAt,
            promptVersion: stored.promptVersion,
          });
        }
        if (build.stepPlan.steps.length === 0) {
          return res.status(400).json({ error: EMPTY_PLAN_COPY });
        }
        const narrated = await narrateStepPlan(build.stepPlan, input, { userId, planId });
        if (!narrated.ok) return sendFailure(res, narrated);
        const generatedAt = new Date().toISOString();
        const feastSession: FeastSessionBlob = {
          fingerprint,
          promptVersion: narrated.promptVersion,
          generatedAt,
          result: narrated.result,
        };
        try {
          // A row the week wrote keeps the week; a row the feast creates has a
          // NULL fingerprint, which the week's read gate treats as a miss.
          await prisma.prepWeekStructure.upsert({
            where: { planId },
            create: {
              planId,
              structureJson: { feastSession } as unknown as object,
              compositionFingerprint: null,
              lastGeneratedFromPlanRevisionId: planRevisionId,
              lastGeneratedAt: new Date(),
              promptVersion: narrated.promptVersion,
            },
            update: {
              structureJson: { ...((row?.structureJson as object | null) ?? {}), feastSession } as unknown as object,
            },
          });
          // The feast's own orphan-prune: only `feast#` keys, against the feast's
          // fresh set. The week's ticks are the week's regeneration to judge.
          await prisma.prepStepCompletion.deleteMany({
            where: {
              planId,
              stepKey: { startsWith: FEAST_KEY_PREFIX, notIn: wireStepKeys(build, FEAST_KEY_PREFIX) },
            },
          });
        } catch (err) {
          logger.warn({ event: "prep_feast_cache_write_failed", userId, planId, err }, "Prep the feast cache write failed");
        }
        return res.json({
          cacheHit: false,
          ...envelope,
          result: withFeastKeys(summarizePrepWeek(finishPrepWeek(narrated.result, build))),
          generatedAt,
          promptVersion: narrated.promptVersion,
          metadata: { latencyMs: narrated.latencyMs },
        });
      }

      // 3. Cache lookup. Hit + matching revisionId returns the stored
      //    structureJson without an AI call (no LLMCallLog row).
      //
      // 🔴 WS9 — A SUBSET RUN BYPASSES THIS CACHE IN BOTH DIRECTIONS.
      // `prepWeekStructure` is keyed on planId ALONE (`@@unique`/`@unique` on
      // planId — schema.prisma:1183), so it can hold exactly ONE structure per
      // plan and that slot means "the whole week".
      //   • No READ: a warm full-week row does not answer a subset question. It
      //     covers meals the caller excluded, so serving it would silently
      //     return the whole week under a two-meal request.
      //   • No WRITE (step 8): writing a two-meal structure into the plan's one
      //     slot would make the NEXT full-week open serve a partial week that
      //     looks entirely correct — right shape, right phases, right prose,
      //     just missing meals. Nothing downstream could detect it. It would
      //     also corrupt the prep-status rollup, which reads that same blob for
      //     the narrator's skipSuggested flags (prepStepSet.ts).
      // The bypass is a pair; neither half is safe alone. The cost is that
      // every subset run is a live AI call — see the `subset` response flag.
      //
      // 🔴 WS9 — THE GATE IS THE COMPOSITION FINGERPRINT, NOT `revisionId`.
      // `revisionId` bumps on ANY structural plan edit. `loadPrepWeekInput`
      // reads no date field at all, so a date-range edit or a day assignment
      // cannot change the prep structure — yet each one used to invalidate and
      // cost a full regeneration of a byte-identical payload. The fingerprint
      // hashes the loader's own output, so it moves only when the result would.
      // A NULL stored fingerprint (any row written before this shipped) is a
      // MISS: self-healing, one regeneration per plan, no backfill.
      // See prepWeekFingerprint.ts for why a hash and not a second counter.
      // ── WS9 D-WS9-298 — THE ENGINE RUNS BEFORE THE CACHE GATE ────────────
      //
      // It used to run only on a MISS. The storage overlay needs the step
      // plan's context — each step's phase, its ingredient names and its
      // `daysUntilCook` — on EVERY read, because a cached blob holds notes
      // that depend on the DAY while the day changes without the composition
      // changing. That is precisely the case D-WS9-298 made a cache HIT, so
      // the hit path is the one that must recompute them.
      //
      // The cost is pure CPU over data already in hand: no query, no AI call.
      // The alternative is putting the dates back in the fingerprint, and then
      // every day reassignment is a regeneration again.
      // 4. Cache miss or stale. BLENDED path: deterministic engine does ALL
      //    grouping / summing / scaling / attribution / phase placement; the
      //    AI is called only to narrate the computed step plan into prose.
      // Part J.0 — ONE builder, shared with the `isPrepped` derivation
      // (prepStepSet.ts), so the steps rendered here are the steps it waits for.
      // The lag is the LOADER's (BUG-338 / D-WS9-298), beside the input, so the
      // fingerprint never sees a date. A subset is built over the WHOLE plan and
      // then scoped (A3): same keys, same container names as the full week.
      // Part J.1 — everything that depends on TODAY (the one-session holds, the
      // cook-day list, the storage overlay) is applied by finishPrepWeek, on the
      // cache-hit path and the miss path alike.
      // PREP-1 (D-WS9-314) — the feast is never in this session, full week or
      // subset: it has its own ("Prep the feast"), keyed apart. A subset that
      // named only the feast, or a plan that is only the feast, has nothing here.
      const coreScope = coreScopeMealIds(input, subsetMealIds);
      if (coreScope !== undefined && coreScope.length === 0) {
        return res.status(400).json({ error: FEAST_OWN_PREP_COPY, reason: "feast_has_own_prep" });
      }
      const build = buildCoreWeek({ input, cookDays, identity }, subsetMealIds);
      const { stepPlan } = build;

      const cached = isSubset
        ? null
        : await prisma.prepWeekStructure.findUnique({ where: { planId } });
      const compositionFingerprint = prepCompositionFingerprint(input);
      // The second half of the gate: a prep.narrate_steps body change must not
      // keep serving prose the previous version wrote. Resolved here rather
      // than taken from the AI result because the READ gate needs it before any
      // call happens (60 s in-memory TTL cache, so it is a map lookup on all but
      // the first request per minute).
      //
      // ⚠️ FAILS OPEN. resolvePromptDescriptorFromDb swallows a DB error and
      // returns version null; null means "don't know", and an unknown version
      // must NOT invalidate. Comparing an unknown against the stored version
      // would miss on every request and regenerate forever — the exact silent
      // waste this whole change exists to remove. Composition still gates.
      const activePromptVersion = (
        await resolvePromptDescriptor("prep.narrate_steps", prisma)
      ).version;
      if (
        cached &&
        // `!= null` on purpose — catches BOTH the null Prisma returns for a
        // pre-fingerprint row and an undefined from any caller that omits the
        // column. `!== null` would let undefined through the guard.
        cached.compositionFingerprint != null &&
        cached.compositionFingerprint === compositionFingerprint &&
        (activePromptVersion === null ||
          cached.promptVersion === activePromptVersion)
      ) {
        return res.json({
          cacheHit: true,
          subset: false,
          // D-WS9-298 — THE DATE OVERLAY, ON THE HIT PATH TOO. The blob is what
          // the AI wrote; the storage notes, the protein demotions and the
          // Proteins phase line are recomputed from today's cook days.
          // D-WS9-301 ruling 4 — the header numbers are computed AFTER the
          // overlay, because the overlay can demote a protein step and a step
          // that no longer renders is not a container today.
          result: summarizePrepWeek(
            finishPrepWeek(splitStructure(cached.structureJson).week, build),
          ),
          planRevisionId,
          generatedAt: cached.lastGeneratedAt.toISOString(),
          promptVersion: cached.promptVersion,
        });
      }

      // 4. Cache miss or stale — the engine already ran above the gate.

      // Nothing in the plan is prep-worthy (all denylisted / buy-and-use) —
      // same 400 + copy as a structurally empty plan.
      if (stepPlan.steps.length === 0) {
        return res.status(400).json({ error: EMPTY_PLAN_COPY });
      }

      // 4b–7. Narrate, assemble, check the wire and the attribution — shared
      // with the feast session (narrateStepPlan above).
      const narrated = await narrateStepPlan(stepPlan, input, { userId, planId });
      if (!narrated.ok) return sendFailure(res, narrated);
      const { result } = narrated;

      // 8. Cache write. UPSERT keyed by planId — covers create (cache
      //    miss, no prior row) AND stale-update (revisionId moved) in
      //    one operation.
      //
      // 🔴 WS9 — SKIPPED ENTIRELY FOR A SUBSET (the write half of the step-3
      //    bypass). This guard also protects the ORPHAN-PRUNE below, which is
      //    the second, quieter data-loss path: the prune deletes every
      //    PrepStepCompletion whose key is absent from the freshly assembled
      //    step set. A subset's step set omits every meal the caller excluded,
      //    so pruning against it would delete the user's checked prep steps for
      //    the rest of the week. Prep-week completions are plan-scoped
      //    (@@unique([planId, stepKey])) with plan-composition-independent keys,
      //    so there is no subset-scoped prune to write instead — the correct
      //    action is not to prune at all.
      const { promptVersion } = narrated;
      // PREP-1 (D-WS9-314) — the row also holds the feast session (`feastSession`,
      // gated by its own fingerprint on read). Regenerating the week keeps it.
      const storedFeast = cached ? splitStructure(cached.structureJson).feast : null;
      const structureJson = { ...result, ...(storedFeast ? { feastSession: storedFeast } : {}) } as unknown as object;
      if (!isSubset) {
        try {
          // `promptVersion` here is the version that ACTUALLY narrated this
          // prose (aiResult.metadata), which is what the read gate above
          // compares against the then-active version. The fingerprint covers
          // composition only, so it needs no version input.
          await prisma.prepWeekStructure.upsert({
            where: { planId },
            create: {
              planId,
              structureJson,
              compositionFingerprint,
              lastGeneratedFromPlanRevisionId: planRevisionId,
              lastGeneratedAt: new Date(),
              promptVersion,
            },
            update: {
              structureJson,
              compositionFingerprint,
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
          // 🔴 PREP-1 (D-WS9-314) — AND THE FEAST SESSION'S KEYS. They are never in
          // the week's result, so without them every regeneration of the week
          // would wipe the ticks made in Prep the feast. Computed from the engine,
          // so they are kept whether or not the feast was ever narrated.
          const feastBuild = buildFeastSession({ input, cookDays, identity });
          const keepKeys = [
            ...stepKeysOfResult(result),
            ...(feastBuild ? wireStepKeys(feastBuild, FEAST_KEY_PREFIX) : []),
          ];
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
      }

      return res.json({
        cacheHit: false,
        // WS9 — `subset: true` marks a result that is NOT the canonical week and
        // was never cached (neither read nor written). A client must never file
        // it as the plan's prep structure. Always present on both branches so
        // `envelope.subset` is a straight boolean, never an absence to reason
        // about.
        subset: isSubset,
        // D-WS9-298 — the same overlay, from the same helper, so the two paths
        // cannot drift into showing different storage text for one plan.
        result: summarizePrepWeek(finishPrepWeek(result, build)),
        planRevisionId,
        generatedAt: new Date().toISOString(),
        promptVersion,
        metadata: {
          latencyMs: narrated.latencyMs,
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

  // ── Part J.1b — GET …/prep-week/structure: the step set, FREE ────────────
  //
  // Cook Mode's prepped view needs the plan's prep steps (the recap) and their
  // `coversCookSteps`, and fetching them from POST …/prep-week costs a live
  // narration whenever nothing is cached — a plan edit, a never-prepped plan, a
  // subset-only user. This is the engine's step set alone: no AI call, no cache
  // read or write, no completion prune. Same auth and ownership-as-404 as the prep
  // route; no Premium gate, because nothing here is generated.
  //
  // ⚠️ `title` is the ENGINE's (prepWeekAssembly.engineTitle) — the narrator writes
  // the titles the Prep the Week screen shows, so these read plainer ("Mince the
  // garlic") and can differ from that screen's wording. Keys, phases, containers,
  // meals, coverage, holds and the cook-day list are identical to the prep route's:
  // both go through `buildPrepWeekPlan` and `finishPrepWeek`.
  router.get(
    "/plans/:planId/prep-week/structure",
    requireAuth,
    completionLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "unauthenticated" });
      const planId = readPlanId(req);
      if (!planId) return res.status(400).json({ error: "invalid plan id" });

      let loaded;
      try {
        loaded = await loadPrepWeekInput({ planId, userId, prisma });
      } catch (err) {
        if (err instanceof PrepWeekNotFoundError) return res.status(404).json({ error: "plan not found" });
        if (err instanceof PrepWeekEmptyPlanError) return res.json({ planId, steps: [], heldForCookDay: [] });
        logger.error({ event: "prep_week_structure_failed", userId, planId, err }, "Prep structure load failed");
        return res.status(500).json({ error: "internal server error" });
      }
      // PREP-1 (D-WS9-314) — the week and, for a plan with a feast, the feast session
      // under its `feast#` keys: Cook Mode joins the feast's cook steps to the prep
      // steps that covered them, and those are the feast session's.
      const engineTitled = (build: ReturnType<typeof buildCoreWeek>) => {
        const titled = {
          steps: build.stepPlan.narrationInput.steps.map((s) => {
            const planned = build.stepPlan.steps.find((p) => p.stepId === s.stepId)!;
            return { stepId: s.stepId, title: engineTitle(planned), instructions: "-" };
          }),
        };
        return finishPrepWeek(assemblePrepWeekResult(build.stepPlan, titled), build);
      };
      const week = engineTitled(buildCoreWeek(loaded));
      const feastBuild = buildFeastSession(loaded);
      const results = feastBuild ? [week, withFeastKeys(engineTitled(feastBuild))] : [week];
      const held = (r: PrepWeekResult) => r.phases.find((p) => p.phase === "proteins")?.heldForCookDay ?? [];
      return res.json({
        planId,
        steps: results.flatMap((result) => result.phases.flatMap((ph) =>
          ph.steps.map((s) => ({
            stepKey: s.stepKey,
            title: s.title,
            phase: ph.phase,
            containerNames: s.containerNames ?? [],
            contributesToMealIds: s.contributesToMealIds,
            coversCookSteps: s.coversCookSteps ?? [],
            skipSuggested: s.skipSuggested === true,
          })),
        )),
        heldForCookDay: [...new Set(results.flatMap(held))].slice(0, 20),
      });
    },
  );

  return router;
}

const router = createCookingRouter();
export default router;
