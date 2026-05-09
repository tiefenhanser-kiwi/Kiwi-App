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
    eventType: "wizard_complete" | "wizard_start",
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
    const [pantryStaples, recentMeals] = await Promise.all([
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
      // PRD §3.5 fields (equipment, spiceTolerance) live in mobile state
      // today and will move to UserPreferences in a later sub-phase. For
      // 6a-3 we surface what's in DB and leave the rest unset.
      equipment: undefined,
      spiceTolerance: undefined,
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
