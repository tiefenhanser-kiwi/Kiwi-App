// POST /api/plans/:id/generate-grocery-list — Smart grocery list AI generation.
// GET  /api/grocery-lists/:id — Read a generated grocery list with its items.
// Per kiwi_ws6_plan.md §3 6c-4 Block C + PRD §12.
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts / plans.ts so
// unit tests can inject stubbed consolidator/AI helpers + prisma without
// standing up the full stack.
//
// Locked decisions (Phase 1):
//   • Case 1 only: no existing list → generate fresh → route to grocery-list/[id].
//     If a list already exists for the plan (status != archived), return 409
//     with existingListId. Mobile routes the user to the existing list
//     regardless of staleness; sync is WS7 (D-WS7 placeholder).
//   • Persist lastGeneratedFromPlanRevisionId + lastGeneratedAt at create time.
//   • Activity log: generate_grocery (already in ActivityEventType enum).
//   • Best-effort Ingredient lookup by canonicalName, normalized via Block A
//     normalizeIngredientName before the equals match.

import { Router, type IRouter } from "express";
import type { PrismaClient, Prisma, StoreSection } from "@prisma/client";

import {
  consolidatePlanIngredients as productionConsolidatePlanIngredients,
  GroceryConsolidationForbiddenError,
  GroceryConsolidationNotFoundError,
} from "../lib/groceryList";
import {
  fillPurchaseSizesWithWriteBack as productionFillPurchaseSizesWithWriteBack,
  generateFinalGroceryList as productionGenerateFinalGroceryList,
  GroceryListAIError,
} from "../lib/groceryListAI";
import { normalizeIngredientName } from "../lib/groceryNormalization";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export interface GroceryListsRouterDeps {
  consolidatePlanIngredients: typeof productionConsolidatePlanIngredients;
  fillPurchaseSizesWithWriteBack: typeof productionFillPurchaseSizesWithWriteBack;
  generateFinalGroceryList: typeof productionGenerateFinalGroceryList;
  prisma: PrismaClient;
}

const KNOWN_SECTIONS: StoreSection[] = [
  "produce",
  "meat_seafood",
  "dairy_eggs",
  "bakery_bread",
  "pantry",
  "canned",
  "frozen",
  "snacks",
  "household",
  "extras",
];

// Best-effort canonical-name → Ingredient.id lookup. Returns null on miss
// (synthetic recurring items from Block A have no Ingredient row). The
// canonicalName is unique in the schema and all seeded rows are lowercase
// (see prisma/seed.ts + seeds/devData.ts canonicalize). We normalize the
// AI's output through the same Block A helper before the equals lookup, so
// casing/whitespace/leading-article drift from AI output still hits the row.
async function lookupIngredientIdByCanonicalName(
  tx: Prisma.TransactionClient,
  canonicalName: string,
): Promise<string | null> {
  const normalized = normalizeIngredientName(canonicalName);
  const row = await tx.ingredient.findFirst({
    where: { canonicalName: normalized },
    select: { id: true },
  });
  return row?.id ?? null;
}

export function createGroceryListsRouter(
  deps: Partial<GroceryListsRouterDeps> = {},
): IRouter {
  const consolidatePlanIngredients =
    deps.consolidatePlanIngredients ?? productionConsolidatePlanIngredients;
  const fillPurchaseSizesWithWriteBack =
    deps.fillPurchaseSizesWithWriteBack ??
    productionFillPurchaseSizesWithWriteBack;
  const generateFinalGroceryList =
    deps.generateFinalGroceryList ?? productionGenerateFinalGroceryList;
  const prisma = deps.prisma ?? productionPrisma;

  const router: IRouter = Router();

  router.post(
    "/plans/:id/generate-grocery-list",
    requireAuth,
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
        // 1. Authorize + read plan revision in one go. 404 on miss OR
        //    cross-user (do NOT leak existence).
        const plan = await prisma.mealPlanInstance.findFirst({
          where: { id: planId, userId },
          select: {
            id: true,
            titleOverride: true,
            revisionId: true,
            template: { select: { title: true } },
          },
        });
        if (!plan) {
          return res.status(404).json({ error: "plan_not_found" });
        }

        // 2. Case 1 enforcement: bail with 409 if a non-archived list
        //    already exists for this plan. Mobile routes to existingListId
        //    regardless of staleness; sync flow is WS7.
        const existing = await prisma.groceryList.findFirst({
          where: {
            mealPlanInstanceId: planId,
            status: { not: "archived" },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (existing) {
          return res.status(409).json({
            error: "list_exists",
            existingListId: existing.id,
            message: "A grocery list already exists for this plan.",
          });
        }

        // 3. Block A: deterministic consolidation. May throw
        //    GroceryConsolidationNotFoundError if the plan vanished between
        //    the read above and the helper read (race) — surface as 404.
        const consolidated = await consolidatePlanIngredients({
          prisma,
          planId,
          userId,
        });

        // 4. Block B: gap-fill (Haiku, write-back) + final AI pass (Sonnet).
        //    Both throw GroceryListAIError on AI failure; caught below.
        const withSizes = await fillPurchaseSizesWithWriteBack(consolidated, {
          prisma,
          userId,
        });
        const planTitle = plan.titleOverride ?? plan.template.title;
        const final = await generateFinalGroceryList(
          planTitle,
          withSizes,
          KNOWN_SECTIONS,
          { prisma, userId },
        );

        // 5. Persist GroceryList + items in a single transaction.
        //    Ingredient lookup runs inside the tx so the lookup sees the
        //    same view as the createMany write (no torn read on a
        //    concurrent ingredient backfill).
        const list = await prisma.$transaction(async (tx) => {
          const grocery = await tx.groceryList.create({
            data: {
              userId,
              title: `Groceries: ${planTitle}`,
              mealPlanInstanceId: planId,
              sourceType: "plan",
              status: "active",
              lastGeneratedFromPlanRevisionId: plan.revisionId,
              lastGeneratedAt: new Date(),
            },
          });

          const items = await Promise.all(
            final.items.map(async (item) => ({
              groceryListId: grocery.id,
              ingredientId: await lookupIngredientIdByCanonicalName(
                tx,
                item.canonicalName,
              ),
              displayName: item.displayName,
              quantity: item.quantity,
              unit: item.unit,
              storeSection: item.sectionKey,
              isUniversalStaple: item.isUniversalStaple,
              isUserPantryStaple: item.isUserPantryStaple,
              isRecurringItem: item.isRecurringItem,
              wasAiInferred: true,
              notes: item.notes,
            })),
          );

          if (items.length > 0) {
            await tx.groceryListItem.createMany({ data: items });
          }
          return grocery;
        });

        // 6. Activity log — non-blocking. A duplicate-key or other write
        //    failure must not fail the user-facing generation.
        prisma.userActivity
          .create({
            data: {
              userId,
              eventType: "generate_grocery",
              entityType: "grocery_list",
              entityId: list.id,
              platform: "api",
              metadata: { planId, itemCount: final.items.length },
            },
          })
          .catch((err) => {
            logger.warn(
              {
                event: "generate_grocery_activity_failed",
                userId,
                planId,
                listId: list.id,
                err,
              },
              "Failed to emit generate_grocery activity",
            );
          });

        return res.status(200).json({ groceryListId: list.id });
      } catch (err) {
        if (
          err instanceof GroceryConsolidationNotFoundError ||
          err instanceof GroceryConsolidationForbiddenError
        ) {
          return res.status(404).json({ error: "plan_not_found" });
        }
        if (err instanceof GroceryListAIError) {
          return res.status(502).json({
            error: "ai_failed",
            message: err.message,
          });
        }
        logger.error(
          { event: "generate_grocery_failed", userId, planId, err },
          "Grocery list generation failed",
        );
        return res.status(500).json({ error: "internal server error" });
      }
    },
  );

  router.get("/grocery-lists/:id", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const listIdRaw = req.params.id;
    const listId = Array.isArray(listIdRaw) ? listIdRaw[0] : listIdRaw;
    if (!listId) {
      return res.status(400).json({ error: "missing list id" });
    }

    try {
      const list = await prisma.groceryList.findFirst({
        where: { id: listId, userId },
        include: {
          items: {
            orderBy: [
              { storeSection: "asc" },
              { displayName: "asc" },
            ],
          },
          planInstance: {
            select: {
              id: true,
              isActiveThisWeek: true,
            },
          },
        },
      });
      if (!list) {
        return res.status(404).json({ error: "list_not_found" });
      }
      return res.status(200).json({ list });
    } catch (err) {
      logger.error(
        { event: "get_grocery_list_failed", userId, listId, err },
        "GET grocery list failed",
      );
      return res.status(500).json({ error: "internal server error" });
    }
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createGroceryListsRouter();
export default router;
