// POST /api/plans/:id/recalc-macros — AI macro recalc on plan edit.
// Per kiwi_ws6_plan.md §3 6b-3 + D-WS5-007.
//
// Auth: requireAuth (JWT). Same DI factory pattern as meals.ts /
// wizard.ts so unit tests can inject a stubbed compute function +
// stubbed prisma without standing up the full stack.
//
// Trigger: WS6 ships the endpoint as callable (debug screen, smoke).
// WS7 wires the real auto-fire on plan add/remove/edit (D-WS5-007).
//
// No request body. The path param `:id` is the MealPlanInstance ID.
// Server walks the plan, runs the 6b-2 dish macro estimator on any
// dish without stored macros (or with per-instance ingredient
// overrides), persists fresh canonical macros to Dish, and returns
// per-day + per-meal totals plus a daily-average rollup for Plan
// Review.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import {
  computePlanMacros as productionComputePlanMacros,
  PlanMacrosForbiddenError,
  PlanMacrosNotFoundError,
} from "../lib/planMacros";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/auth";

export interface PlansRouterDeps {
  computePlanMacros: typeof productionComputePlanMacros;
  prisma: PrismaClient;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

export function createPlansRouter(
  deps: Partial<PlansRouterDeps> = {},
): IRouter {
  const computePlanMacros = deps.computePlanMacros ?? productionComputePlanMacros;
  const prisma = deps.prisma ?? productionPrisma;
  // Same per-user token-bucket pattern + ceiling as meals.ts. Recalc
  // CAN fan out to N AI calls in the worst case, but real Plan Review
  // editing flows (remove an ingredient, re-trigger; tweak servings,
  // re-trigger) will burst tighter than that — 12/min matches the
  // editing-cadence the meals route was tuned for. Cost ceiling is
  // tracked separately via D-WS6-030 (per-user daily AI cost cap).
  const limiterOpts = deps.rateLimiterOpts ?? {
    capacity: 12,
    refillPerSec: 12 / 60,
  };

  const router: IRouter = Router();

  const recalcLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req) => `planrecalc:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/plans/:id/recalc-macros",
    requireAuth,
    recalcLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const planIdRaw = req.params.id;
      const planId = Array.isArray(planIdRaw) ? planIdRaw[0] : planIdRaw;
      if (!planId) {
        return res.status(400).json({ error: "missing plan id" });
      }

      try {
        const result = await computePlanMacros({
          prisma,
          userId,
          planId,
        });
        return res.json(result);
      } catch (err) {
        if (err instanceof PlanMacrosNotFoundError) {
          return res.status(404).json({ error: "plan not found" });
        }
        if (err instanceof PlanMacrosForbiddenError) {
          return res.status(404).json({ error: "plan not found" });
        }
        logger.error(
          { event: "plan_recalc_macros_failed", userId, planId, err },
          "Plan macro recalc failed",
        );
        return res.status(500).json({ error: "internal server error" });
      }
    },
  );

  return router;
}

const router = createPlansRouter();
export default router;
