// POST /api/wizard/build-plans — Set Preferences wizard plan generation.
// Per kiwi_ws6_plan.md §3 6a-3 + PRD §5.7 + §5.8.
//
// Auth: requireAuth (JWT). Rate-limit: per-user token-bucket (8 burst,
// ~1/7.5s) — same pattern as the legacy plans/generate route, keyed by
// userId so authenticated users don't collide on a shared IP.
//
// Request body shape: WizardInput minus hiddenContext (server injects).
// Response shape: WizardPlanCandidatesResultSchema (validated by tool_use).
//
// Factory pattern: createWizardRouter(deps?) lets tests inject stubs for
// runAICall / prisma / subscriptionService without standing up the full
// stack. Default export wires the production singletons.

import { Router, type IRouter, type Request } from "express";
import type { PrismaClient } from "@prisma/client";

import { runAICall as productionRunAICall } from "../lib/ai/runAICall";
import {
  WizardInputSchema,
  WizardPlanCandidatesResultSchema,
  type WizardInput,
} from "../lib/ai/schemas/wizard";
import {
  DirectedInputSchema,
  ParsedIntentSchema,
  type ParsedIntent,
} from "../lib/ai/schemas/tellKiwi";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import {
  subscriptionService as productionSubscriptionService,
  type SubscriptionService,
} from "../lib/subscriptionService";
import { requireAuth } from "../middleware/auth";

export interface WizardRouterDeps {
  runAICall: typeof productionRunAICall;
  prisma: PrismaClient;
  subscriptionService: SubscriptionService;
  // Override the rate limiter for tests that want to exercise burst behavior
  // or skip throttling entirely.
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

export function createWizardRouter(
  deps: Partial<WizardRouterDeps> = {},
): IRouter {
  const runAICall = deps.runAICall ?? productionRunAICall;
  const prisma = deps.prisma ?? productionPrisma;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
  const limiterOpts = deps.rateLimiterOpts ?? {
    capacity: 8,
    refillPerSec: 8 / 60,
  };

  // ── system settings cache (per-router instance) ──────────────────────

  interface CachedSetting<T> {
    value: T;
    expiresAt: number;
  }
  const settingsCacheMs = 60_000;
  let candidateCountCache: CachedSetting<number> | null = null;
  let maxRefreshesCache: CachedSetting<number> | null = null;

  async function readNumberSetting(
    key: string,
    fallback: number,
  ): Promise<number> {
    try {
      const row = await prisma.systemSetting.findUnique({ where: { key } });
      if (row && typeof row.value === "number" && Number.isFinite(row.value)) {
        return row.value;
      }
      if (row && typeof row.value === "string") {
        const n = Number(row.value);
        if (Number.isFinite(n)) return n;
      }
      return fallback;
    } catch (err) {
      logger.warn(
        { event: "system_setting_read", key, err },
        "Falling back to default",
      );
      return fallback;
    }
  }

  async function getCandidateCount(): Promise<number> {
    if (candidateCountCache && candidateCountCache.expiresAt > Date.now()) {
      return candidateCountCache.value;
    }
    const value = await readNumberSetting("wizard.candidate_count", 3);
    candidateCountCache = { value, expiresAt: Date.now() + settingsCacheMs };
    return value;
  }

  async function getMaxRefreshes(): Promise<number> {
    if (maxRefreshesCache && maxRefreshesCache.expiresAt > Date.now()) {
      return maxRefreshesCache.value;
    }
    const value = await readNumberSetting(
      "wizard.max_refreshes_per_session",
      3,
    );
    maxRefreshesCache = { value, expiresAt: Date.now() + settingsCacheMs };
    return value;
  }

  // ── activity events (PRD §5.10) ──────────────────────────────────────

  async function emitActivity(
    userId: string,
    eventType: "wizard_complete" | "wizard_start" | "wizard_failure",
    entityId?: string,
  ): Promise<void> {
    try {
      await prisma.userActivity.create({
        data: {
          userId,
          eventType,
          entityId: entityId ?? null,
          platform: "api",
        },
      });
    } catch (err) {
      logger.warn(
        { event: "activity_emit", userId, eventType, err },
        "Failed to emit activity",
      );
    }
  }

  // ── server-injected hidden context ───────────────────────────────────

  async function buildHiddenContext(
    userId: string,
  ): Promise<WizardInput["hiddenContext"]> {
    const [preferences, pantryStaples, recentMeals] = await Promise.all([
      prisma.userPreferences.findUnique({
        where: { userId },
        select: {
          equipment: true,
          spiceTolerance: true,
          dailyCalorieTarget: true,
          budgetLevel: true,
          pickyAvoidances: true,
          recurringItems: true,
        },
      }),
      prisma.pantryStaple.findMany({
        where: { userId, isActive: true },
        select: { ingredientName: true },
      }),
      prisma.userActivity.findMany({
        where: { userId, eventType: "cook_meal", entityType: "meal" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { entityId: true },
      }),
    ]);

    return {
      equipment: preferences?.equipment ?? [],
      spiceTolerance: preferences?.spiceTolerance ?? undefined,
      dailyCalorieTarget: preferences?.dailyCalorieTarget ?? undefined,
      budgetLevel: preferences?.budgetLevel ?? undefined,
      pickyAvoidances: preferences?.pickyAvoidances ?? [],
      recurringItems: preferences?.recurringItems ?? [],
      pantryStaples: pantryStaples.map((p) => p.ingredientName),
      recentMealIds: recentMeals
        .map((a) => a.entityId)
        .filter((id): id is string => !!id),
    };
  }

  // ── route ────────────────────────────────────────────────────────────

  const router: IRouter = Router();

  const wizardLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => req.userId ?? "anonymous",
  });

  router.post(
    "/wizard/build-plans",
    requireAuth,
    wizardLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Validate the input.
      const parsed = WizardInputSchema.omit({ hiddenContext: true }).safeParse(
        req.body,
      );
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }

      // 2. Entitlement check.
      const ent = await subscriptionService.can(
        userId,
        "kitchen_wizard_set_preferences",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Kitchen Wizard is a premium feature.",
        });
      }

      // 3. Read SystemSetting tunables.
      const candidateCount = await getCandidateCount();

      // 4. Inject hidden context from the user's profile.
      const hiddenContext = await buildHiddenContext(userId);
      const wizardInput: WizardInput = { ...parsed.data, hiddenContext };

      // 5. Run the AI call.
      const result = await runAICall(
        "wizard.set_preferences.generate",
        { wizardInput },
        WizardPlanCandidatesResultSchema,
        { prisma, userId },
      );

      if (!result.success) {
        logger.warn(
          {
            event: "wizard_build_plans_failed",
            userId,
            reason: result.reason,
            promptKey: "wizard.set_preferences.generate",
          },
          "Wizard plan generation failed",
        );
        // PRD §5.10 — record the failure so cost/observability and admin
        // funnels can see real failure rates. Same fire-and-forget pattern
        // as wizard_complete: never let activity-write failures bubble up.
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: result.userFacingMessage,
          reason: result.reason,
        });
      }

      // 6. Trim candidates defensively to the configured count.
      const candidates = result.data.candidates.slice(0, candidateCount);
      const response = {
        candidates,
        cannotGenerateMore: result.data.cannotGenerateMore,
        reason: result.data.reason,
        metadata: {
          promptVersion: result.metadata.promptVersion,
          latencyMs: result.metadata.latencyMs,
        },
      };

      // 7. Activity event.
      await emitActivity(userId, "wizard_complete");

      return res.json(response);
    },
  );

  // ── POST /wizard/build-from-text — Tell Kiwi two-step pipeline ───────
  // Per kiwi_ws6_plan.md §3 6a-4 + PRD §6.5/§6.8.
  //
  // 1. Parse intent (Haiku, text+Zod, cheap).
  // 2. Branch on parsedIntent.scenario:
  //    - 'unclear' → return { candidates: [], parsedIntent } — no step 2 call,
  //      saves ~$0.01 per request and a few seconds of latency. Mobile shows
  //      the clarification UI from parsedIntent.needsClarification.
  //    - else → call step 2 (Sonnet, tool_use, expensive).
  // 3. Step 2 call gets parsedIntent + userInput + hiddenContext + plan
  //    parameters. AI returns 1-3 candidates per the prompt's scenario rules.
  // 4. Forward needsClarification through to mobile if present.
  //
  // Both AI calls write their own LLMCallLog rows via runAICall.
  // wizard_complete fires once per successful Tell Kiwi request (with metadata
  // distinguishing flow=tellkiwi); wizard_failure fires if EITHER call fails.

  // Same per-user token-bucket pattern as build-plans, but a separate bucket.
  // Tell Kiwi may be used more often than the full Set-Prefs wizard, so we
  // don't want a shared bucket to starve either flow.
  const tellKiwiLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `tellkiwi:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/wizard/build-from-text",
    requireAuth,
    tellKiwiLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Validate body. The DirectedInputSchema covers the user's
      //    free-text + soft prefs from the Tell Kiwi form. The route
      //    itself reads planDurationDays from the request body too,
      //    falling back to 5 (the wizard default) if not provided.
      const parsed = DirectedInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const directed = parsed.data;
      const planDurationDays =
        typeof req.body?.planDurationDays === "number" &&
        req.body.planDurationDays >= 1 &&
        req.body.planDurationDays <= 7
          ? (req.body.planDurationDays as number)
          : 5;

      // 2. Entitlement check (PRD §6.4 — Tell Kiwi is its own entitlement).
      const ent = await subscriptionService.can(
        userId,
        "kitchen_wizard_just_say",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason: ent.reason ?? "Tell Kiwi is a premium feature.",
        });
      }

      // 3. Read SystemSetting tunables (same dial as build-plans for
      //    candidate count; Tell Kiwi may return fewer per scenario).
      const candidateCount = await getCandidateCount();

      // 4. Inject hidden context from the user's profile.
      const hiddenContext = await buildHiddenContext(userId);

      // 5. Step 1 — parse intent.
      const parseInput = {
        userInput: directed.description,
        planDurationDays,
        householdSize: directed.householdSize,
        wantsLeftovers: directed.wantsLeftovers,
        eatingStyles: directed.eatingStyles,
        allergiesAndAvoidances: directed.allergiesAndAvoidances,
        dietaryNotes: directed.dietaryNotes ?? "",
        // Hidden context is informational at parse time too — helps the
        // parser apply unclear-clarifications that respect dietary state.
        hiddenContext,
      };

      const parseResult = await runAICall(
        "wizard.directed.parse_intent",
        { parseInput },
        ParsedIntentSchema,
        { prisma, userId },
      );

      if (!parseResult.success) {
        logger.warn(
          {
            event: "tellkiwi_parse_failed",
            userId,
            reason: parseResult.reason,
            promptKey: "wizard.directed.parse_intent",
          },
          "Tell Kiwi parse step failed",
        );
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: parseResult.userFacingMessage,
          reason: parseResult.reason,
        });
      }

      const parsedIntent: ParsedIntent = parseResult.data;

      // 6. Branch on scenario. `unclear` short-circuits without firing the
      //    expensive Sonnet call — mobile renders the clarification UI from
      //    parsedIntent.needsClarification.reason.
      if (parsedIntent.scenario === "unclear") {
        // wizard_complete still fires — the user got a useful response (a
        // clarifying question), even though no plan was generated. That keeps
        // the funnel metric consistent and matches the PRD §6.10 intent.
        await emitActivity(userId, "wizard_complete");
        return res.json({
          candidates: [],
          parsedIntent,
          needsClarification: parsedIntent.needsClarification,
          metadata: {
            promptVersion: parseResult.metadata.promptVersion,
            latencyMs: parseResult.metadata.latencyMs,
            flow: "tellkiwi",
          },
        });
      }

      // 7. Step 2 — generate plan(s). Reuses the wizard-shape result
      //    schema. The prompt is responsible for honoring scenario rules
      //    (1 candidate for fully_specified/overflow, 3 for vague/partial,
      //    explicitMeals locked into every candidate for partial).
      const generateInput = {
        parsedIntent,
        userInput: directed.description,
        planDurationDays,
        householdSize: directed.householdSize,
        wantsLeftovers: directed.wantsLeftovers,
        eatingStyles: directed.eatingStyles,
        allergiesAndAvoidances: directed.allergiesAndAvoidances,
        dietaryNotes: directed.dietaryNotes ?? "",
        hiddenContext,
      };

      const genResult = await runAICall(
        "wizard.directed.generate",
        { generateInput },
        WizardPlanCandidatesResultSchema,
        { prisma, userId },
      );

      if (!genResult.success) {
        logger.warn(
          {
            event: "tellkiwi_generate_failed",
            userId,
            reason: genResult.reason,
            promptKey: "wizard.directed.generate",
          },
          "Tell Kiwi generate step failed",
        );
        await emitActivity(userId, "wizard_failure");
        return res.status(502).json({
          error: genResult.userFacingMessage,
          reason: genResult.reason,
        });
      }

      // 8. Trim candidates defensively.
      //    fully_specified + overflow scenarios produce exactly 1 candidate
      //    by prompt design — but if the AI returns more, slice to 1 to
      //    keep the UI invariant clean. vague/partial honor candidateCount.
      const expected =
        parsedIntent.scenario === "fully_specified" ||
        parsedIntent.scenario === "overflow"
          ? 1
          : candidateCount;
      const candidates = genResult.data.candidates.slice(0, expected);

      // 9. Carry needsClarification through. For overflow the parser populates
      //    options with the dropped meals; mobile renders them as swap chips.
      const response = {
        candidates,
        parsedIntent,
        needsClarification:
          parsedIntent.needsClarification ?? undefined,
        cannotGenerateMore: genResult.data.cannotGenerateMore,
        reason: genResult.data.reason,
        metadata: {
          promptVersion: genResult.metadata.promptVersion,
          latencyMs:
            parseResult.metadata.latencyMs + genResult.metadata.latencyMs,
          flow: "tellkiwi",
        },
      };

      await emitActivity(userId, "wizard_complete");

      return res.json(response);
    },
  );

  router.get("/wizard/limits", requireAuth, async (_req, res) => {
    const [candidateCount, maxRefreshes] = await Promise.all([
      getCandidateCount(),
      getMaxRefreshes(),
    ]);
    return res.json({
      candidateCount,
      maxRefreshesPerSession: maxRefreshes,
    });
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createWizardRouter();
export default router;
