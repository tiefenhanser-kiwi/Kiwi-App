// WS6 6b-4 + 6b-5 — Dish / Meal Builder endpoints.
// Per kiwi_ws6_plan.md §3 6b-4 / 6b-5 + PRD §1.2.
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts / plans.ts
// so unit tests can inject runAICall / prisma stubs without standing up the
// full stack.
//
// Entitlements:
//   - /assist-ingredients + /assist-steps (Kiwi-assist, 6b-4) — FREE. PRD
//     §1.2 frames these as "AI enhancing what the user already typed" — no
//     premium gate.
//   - /parse-meal (Mode A, 6b-5) — PREMIUM. PRD §1.2 frames Mode A as
//     "Generate NEW content via AI" (entitlement key:
//     meal_builder_text_input). Today the gate is a passthrough because
//     SubscriptionService.can() returns allowed=true for everyone in trial
//     mode; matters once Stripe wires real entitlements in WS8.
//
// Rate limit: per-user token-bucket at 12/min for all three routes,
// matching meals.ts and plans.ts editing-cadence convention.

import { Router, type IRouter, type Request } from "express";
import type { PrismaClient } from "@prisma/client";

import {
  AssistIngredientsInputSchema,
  AssistStepsInputSchema,
  ParseMealInputSchema,
} from "../lib/ai/schemas/mealBuilder";
import {
  assistDishIngredients as productionAssistDishIngredients,
  assistDishSteps as productionAssistDishSteps,
} from "../lib/kiwiAssist";
import { parseMealFromText as productionParseMealFromText } from "../lib/mealBuilder";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { subscriptionService as productionSubscriptionService, type SubscriptionService } from "../lib/subscriptionService";
import { requireAuth } from "../middleware/auth";

export interface BuilderRouterDeps {
  assistDishIngredients: typeof productionAssistDishIngredients;
  assistDishSteps: typeof productionAssistDishSteps;
  parseMealFromText: typeof productionParseMealFromText;
  subscriptionService: SubscriptionService;
  prisma: PrismaClient;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

export function createBuilderRouter(
  deps: Partial<BuilderRouterDeps> = {},
): IRouter {
  const assistDishIngredients =
    deps.assistDishIngredients ?? productionAssistDishIngredients;
  const assistDishSteps = deps.assistDishSteps ?? productionAssistDishSteps;
  const parseMealFromText =
    deps.parseMealFromText ?? productionParseMealFromText;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
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

  router.post(
    "/builder/parse-meal",
    requireAuth,
    assistLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      const parsed = ParseMealInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }

      // Premium gate (PRD §1.2 / §14.5.1). Today a passthrough in trial
      // mode; once Stripe lands in WS8 this is the seam that locks Mode A
      // behind the paid SKU.
      const ent = await subscriptionService.can(
        userId,
        "meal_builder_text_input",
      );
      if (!ent.allowed) {
        return res.status(402).json({
          error: "upgrade required",
          reason:
            ent.reason ??
            "Parsing meals from free text is a premium feature.",
        });
      }

      const result = await parseMealFromText({
        prisma,
        userId,
        freeText: parsed.data.freeText,
        servings: parsed.data.servings,
        userHints: parsed.data.userHints,
      });

      if (result.status === "failed") {
        logger.warn(
          {
            event: "builder_parse_meal_failed",
            userId,
            error: result.error,
          },
          "Mode A parse-meal call failed",
        );
        return res.status(502).json({
          error: result.error,
          status: "failed",
        });
      }

      return res.json({
        status: "success",
        meal: result.meal,
        caveats: result.caveats,
      });
    },
  );

  return router;
}

const router = createBuilderRouter();
export default router;
