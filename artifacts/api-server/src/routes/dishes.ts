// GET /api/dishes/:id — dish detail (WS7-3 A2).
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts so unit
// tests can inject a stubbed prisma without standing up the full stack.
//
// Returns the full dish: meta + per-dish ingredients (via dishIngredients)
// + dish-owned instruction steps (RecipeInstructionStep, ownerType="dish").
//
// Read scope (SEC-2 #11): the caller's own dish, or a dish inside a meal the
// caller may read — lib/mealVisibility.ts isDishReadableByUser, the same three
// clauses GET /meals/:id applies. Until SEC-2 any non-archived dish was
// readable by id (WS7-3 A2 §8 F-A2-2 reasoned there was no isPublic to gate
// on; the meal links are the gate). Anything else is a 404, never a 403: a 403
// would confirm the id exists.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { createRequireAuth } from "../middleware/auth";
import { isDishReadableByUser } from "../lib/mealVisibility";
import { toStepShape } from "./meals";
import { selectDefaultPathSteps } from "../lib/cookingScheduler";

export interface DishesRouterDeps {
  prisma: PrismaClient;
}

export function createDishesRouter(
  deps: Partial<DishesRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  // WS9A BUG-234 — the session guard now reads User.tokensValidFrom, so it
  // needs a Prisma client. Building it from the injected one (rather than
  // importing the singleton) is what keeps this router's tests hermetic.
  // Shadows the module import: every requireAuth call site below is unchanged.
  const requireAuth = createRequireAuth({ prisma });
  const router: IRouter = Router();

  // GET /dishes/:id — full dish detail.
  router.get("/dishes/:id", requireAuth, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 100) {
      return res.status(400).json({ error: "invalid dish id" });
    }

    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    try {
      if (!(await isDishReadableByUser(prisma, id, userId))) {
        return res.status(404).json({ error: "dish not found" });
      }

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
          // SEC-2 #11 — never another member's id. The key stays (shipped
          // clients' schema requires it, nullable); it carries the caller's
          // own id when the dish is theirs, and null otherwise.
          userId: dish.userId === userId ? userId : null,
          ingredients: dish.dishIngredients.map((di) => ({
            name: di.ingredient.displayName,
            quantity: di.quantity,
            unit: di.unit,
            preparationNote: di.preparationNote,
            category: di.ingredient.category,
            isOptional: di.isOptional,
            // [grocery] B3 (D-WS9-277 Rule 3) — same two tags as the meal shape.
            componentKey: di.componentKey ?? null,
            pathKey: di.pathKey ?? null,
          })),
          // [grocery] B3 (D-WS9-277 Rule 3) — one path, not both. Same predicate
          // as composeMealDetail and as the scheduler; a dish read on its own is
          // no less swappable than the same dish read through its meal.
          steps: selectDefaultPathSteps(steps).map(toStepShape),
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
