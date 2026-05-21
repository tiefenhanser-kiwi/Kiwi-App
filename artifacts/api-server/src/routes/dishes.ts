// GET /api/dishes/:id — dish detail (WS7-3 A2).
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts so unit
// tests can inject a stubbed prisma without standing up the full stack.
//
// Returns the full dish: meta + per-dish ingredients (via dishIngredients)
// + dish-owned instruction steps (RecipeInstructionStep, ownerType="dish").
//
// Read scope: any non-archived dish is readable. The WS7-3 A2 prompt §1.5
// specced an owner-OR-public gate, but the Dish schema has no isPublic
// column — and dishes surface in mobile featured/top-rated catalogs that may
// be owned by other users — so a broad read is correct for MVP. See WS7-3 A2
// Phase 3 report §8 (F-A2-2).

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { toStepShape } from "./meals";

export interface DishesRouterDeps {
  prisma: PrismaClient;
}

export function createDishesRouter(
  deps: Partial<DishesRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const router: IRouter = Router();

  // GET /dishes/:id — full dish detail.
  router.get("/dishes/:id", requireAuth, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 100) {
      return res.status(400).json({ error: "invalid dish id" });
    }

    try {
      const dish = await prisma.dish.findUnique({
        where: { id },
        include: {
          dishIngredients: {
            orderBy: { positionIndex: "asc" },
            include: { ingredient: true },
          },
        },
      });

      if (!dish || dish.isArchived) {
        return res.status(404).json({ error: "dish not found" });
      }

      const steps = await prisma.recipeInstructionStep.findMany({
        where: { ownerType: "dish", ownerId: id },
        orderBy: { stepIndex: "asc" },
      });

      return res.json({
        dish: {
          // Shared meta fields use the GET /meals renamed-flat names
          // (minutes / servings / bare macros / image). Detail-only and
          // dish-shaped fields keep their DB names.
          id: dish.id,
          title: dish.title,
          description: dish.description,
          image: dish.imageUrl,
          difficulty: dish.difficulty,
          minutes: dish.estimatedTimeMinutes,
          servings: dish.servingsDefault,
          calories: dish.caloriesPerServing,
          protein: dish.proteinGPerServing,
          carbs: dish.carbsGPerServing,
          fat: dish.fatGPerServing,
          tags: dish.tags,
          sourceType: dish.sourceType,
          userId: dish.userId,
          ingredients: dish.dishIngredients.map((di) => ({
            name: di.ingredient.displayName,
            quantity: di.quantity,
            unit: di.unit,
            preparationNote: di.preparationNote,
            category: di.ingredient.category,
            isOptional: di.isOptional,
          })),
          steps: steps.map(toStepShape),
        },
      });
    } catch (err) {
      logger.error({ err, id }, "GET /dishes/:id failed");
      return res.status(500).json({ error: "failed to fetch dish" });
    }
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createDishesRouter();
export default router;
