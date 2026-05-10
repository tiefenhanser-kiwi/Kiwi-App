// WS6 6b-4 — Dish / Meal Builder Kiwi-assist endpoints.
// Per kiwi_ws6_plan.md §3 6b-4 + PRD §1.2.
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts / plans.ts
// so unit tests can inject runAICall / prisma stubs without standing up the
// full stack.
//
// Entitlement: FREE. PRD §1.2 frames Kiwi-assist as "AI enhancing what the
// user already typed" — no premium gate. Deliberately omitting any
// SubscriptionService check here so we don't accidentally lock it down later;
// if you reach for an entitlement key, re-read PRD §1.2 first.
//
// Rate limit: per-user token-bucket at 12/min, matching meals.ts and
// plans.ts editing-cadence convention. The assist flow can fire on every
// checkbox toggle, so the burst pattern needs to match interactive editing.
//
// Routes are registered under /api/builder/* in routes/index.ts. 6b-5 Mode A
// (POST /api/builder/parse-meal) will land alongside these.

import { Router, type IRouter, type Request } from "express";
import type { PrismaClient } from "@prisma/client";

import {
  AssistIngredientsInputSchema,
  AssistStepsInputSchema,
} from "../lib/ai/schemas/mealBuilder";
import {
  assistDishIngredients as productionAssistDishIngredients,
  assistDishSteps as productionAssistDishSteps,
} from "../lib/kiwiAssist";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/auth";

export interface BuilderRouterDeps {
  assistDishIngredients: typeof productionAssistDishIngredients;
  assistDishSteps: typeof productionAssistDishSteps;
  prisma: PrismaClient;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

export function createBuilderRouter(
  deps: Partial<BuilderRouterDeps> = {},
): IRouter {
  const assistDishIngredients =
    deps.assistDishIngredients ?? productionAssistDishIngredients;
  const assistDishSteps = deps.assistDishSteps ?? productionAssistDishSteps;
  const prisma = deps.prisma ?? productionPrisma;
  const limiterOpts = deps.rateLimiterOpts ?? {
    capacity: 12,
    refillPerSec: 12 / 60,
  };

  const router: IRouter = Router();

  const assistLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `builderassist:${req.userId ?? "anonymous"}`,
  });

  router.post(
    "/builder/assist-ingredients",
    requireAuth,
    assistLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      const parsed = AssistIngredientsInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }

      const result = await assistDishIngredients({
        prisma,
        userId,
        dishTitle: parsed.data.dishTitle,
        cuisine: parsed.data.cuisine,
        existingIngredients: parsed.data.existingIngredients,
        servings: parsed.data.servings,
        userHints: parsed.data.userHints,
      });

      if (result.status === "failed") {
        logger.warn(
          {
            event: "builder_assist_ingredients_failed",
            userId,
            error: result.error,
          },
          "Kiwi-assist ingredients call failed",
        );
        return res.status(502).json({
          error: result.error,
          status: "failed",
        });
      }

      return res.json({
        status: "success",
        ingredients: result.ingredients,
        caveats: result.caveats,
      });
    },
  );

  router.post(
    "/builder/assist-steps",
    requireAuth,
    assistLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      const parsed = AssistStepsInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }

      const result = await assistDishSteps({
        prisma,
        userId,
        dishTitle: parsed.data.dishTitle,
        cuisine: parsed.data.cuisine,
        ingredients: parsed.data.ingredients,
        servings: parsed.data.servings,
        prepTimeMinutes: parsed.data.prepTimeMinutes,
        cookTimeMinutes: parsed.data.cookTimeMinutes,
      });

      if (result.status === "failed") {
        logger.warn(
          {
            event: "builder_assist_steps_failed",
            userId,
            error: result.error,
          },
          "Kiwi-assist steps call failed",
        );
        return res.status(502).json({
          error: result.error,
          status: "failed",
        });
      }

      return res.json({
        status: "success",
        steps: result.steps,
        caveats: result.caveats,
      });
    },
  );

  return router;
}

const router = createBuilderRouter();
export default router;
