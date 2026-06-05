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
  AddGroceryListItemInputSchema,
  type CategorizeItemResponse,
  type LookupCandidate,
  type SectionKey,
} from "../lib/ai/schemas/grocery";
import {
  consolidatePlanIngredients as productionConsolidatePlanIngredients,
  GroceryConsolidationForbiddenError,
  GroceryConsolidationNotFoundError,
} from "../lib/groceryList";
import {
  categorizeGroceryItem as productionCategorizeGroceryItem,
  fillPurchaseSizesWithWriteBack as productionFillPurchaseSizesWithWriteBack,
  generateFinalGroceryList as productionGenerateFinalGroceryList,
  GroceryListAIError,
} from "../lib/groceryListAI";
import { normalizeIngredientName } from "../lib/groceryNormalization";
import {
  searchIngredientsByPrefix as productionSearchIngredientsByPrefix,
} from "../lib/ingredientSearch";
import { logger } from "../lib/logger";
import { isInstanceActiveThisWeek } from "../lib/planDates";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export interface GroceryListsRouterDeps {
  consolidatePlanIngredients: typeof productionConsolidatePlanIngredients;
  fillPurchaseSizesWithWriteBack: typeof productionFillPurchaseSizesWithWriteBack;
  generateFinalGroceryList: typeof productionGenerateFinalGroceryList;
  // 6c-6 Block B — test seams for the new /grocery-items/lookup +
  // /grocery-lists/:id/items routes. Production callers omit; tests inject
  // stubs to bypass DB + Anthropic.
  categorizeItem: typeof productionCategorizeGroceryItem;
  searchIngredients: typeof productionSearchIngredientsByPrefix;
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

// 6c-6 Block B — Ingredient.category → StoreSection. Mirrors the table in
// groceryList.ts (kept duplicated here to avoid widening that file's API
// surface; the two consumers will diverge as 6c-6+ adds more categories).
// WS7-5d Block 1 Fix B: kept in sync with the lib copy — both expanded to 9
// explicit categories so canned/snacks/household route deterministically.
const CATEGORY_TO_SECTION_LOOKUP: Record<string, SectionKey> = {
  Produce: "produce",
  Protein: "meat_seafood",
  Dairy: "dairy_eggs",
  Pantry: "pantry",
  Bakery: "bakery_bread",
  Canned: "canned",
  Frozen: "frozen",
  Snacks: "snacks",
  Household: "household",
};

function sectionForCategory(category: string | null | undefined): SectionKey {
  if (!category) return "extras";
  return CATEGORY_TO_SECTION_LOOKUP[category] ?? "extras";
}

// 6c-6 Block B — UUID v1-v5 validator. Used to 400 early on bad :id segments
// before any DB hit. Mirrors the AddGroceryListItemInputSchema uuid check.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// WS7-3 A2 — GET /grocery-lists ?filter= accept-list. `by-plan=<id>` defers
// to a future sub-phase. "active" = non-archived AND created within the last
// ACTIVE_WINDOW_DAYS; "past" = created before that window.
const GROCERY_LIST_FILTER_KEYS = ["active", "past"] as const;
const ACTIVE_WINDOW_DAYS = 7;

// Best-effort canonical-name → Ingredient.id lookup. Returns null on miss
// (synthetic recurring items from Block A have no Ingredient row). The
// canonicalName is unique in the schema and all seeded rows are lowercase
// (see prisma/seed.ts + seeds/devData.ts canonicalize). We normalize the
// AI's output through the same Block A helper before the equals lookup, so
// casing/whitespace/leading-article drift from AI output still hits the row.
//
// WS7-5d Block 4 Fix 2 — signature widened from Prisma.TransactionClient to
// PrismaClient | TransactionClient so the caller can hoist the lookups out
// of the interactive transaction (the per-item findFirst storm inside the
// tx blew the 5s budget on cold-cache generates: P2028, same shape as
// WS7-5b activate D-WS7-067). Lookups read immutable canonical rows
// (ingredients are upserted upstream during wizard activation); running
// them before the tx is race-free in practice.
async function lookupIngredientIdByCanonicalName(
  db: PrismaClient | Prisma.TransactionClient,
  canonicalName: string,
): Promise<string | null> {
  const normalized = normalizeIngredientName(canonicalName);
  const row = await db.ingredient.findFirst({
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
  const categorizeItem = deps.categorizeItem ?? productionCategorizeGroceryItem;
  const searchIngredients =
    deps.searchIngredients ?? productionSearchIngredientsByPrefix;
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
        const planTitle = plan.titleOverride ?? plan.template?.title ?? "";
        const final = await generateFinalGroceryList(
          planTitle,
          withSizes,
          KNOWN_SECTIONS,
          { prisma, userId },
        );

        // 5. Resolve canonical → ingredientId for every final-list item
        //    BEFORE opening the transaction. The previous shape ran one
        //    findFirst per item inside the interactive tx; on a cold DB
        //    cache the parallel reads serialized on the connection pool
        //    and blew the default 5s tx budget (P2028, observed live).
        //    Lookups read immutable canonical rows (ingredients are
        //    upserted upstream during wizard activation), so running them
        //    outside the tx is race-free.
        const resolvedIngredientIds = await Promise.all(
          final.items.map((item) =>
            lookupIngredientIdByCanonicalName(prisma, item.canonicalName),
          ),
        );

        // 6. Persist GroceryList + items atomically. Tx now contains only
        //    the two writes that must commit together.
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

          const items = final.items.map((item, idx) => ({
            groceryListId: grocery.id,
            ingredientId: resolvedIngredientIds[idx],
            displayName: item.displayName,
            quantity: item.quantity,
            unit: item.unit,
            storeSection: item.sectionKey,
            isUniversalStaple: item.isUniversalStaple,
            isUserPantryStaple: item.isUserPantryStaple,
            isRecurringItem: item.isRecurringItem,
            // 6c-5: AI-determined now, replacing the hardcoded `true`.
            wasAiInferred: item.wasAiInferred,
            isAmbiguous: item.isAmbiguous,
            ambiguityOptions: item.ambiguityOptions ?? [],
            notes: item.notes,
          }));

          if (items.length > 0) {
            await tx.groceryListItem.createMany({ data: items });
          }
          return grocery;
        });

        // 7. Activity log — non-blocking. A duplicate-key or other write
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

  // GET /api/grocery-lists — list the user's grocery lists (WS7-3 A2).
  // No pagination at MVP (per-user list count is small). Optional ?filter=
  // active|past splits on the ACTIVE_WINDOW_DAYS recency window.
  router.get("/grocery-lists", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const filterRaw = req.query.filter;
    let filter: "active" | "past" | null = null;
    if (filterRaw !== undefined && filterRaw !== "") {
      if (filterRaw === "active" || filterRaw === "past") {
        filter = filterRaw;
      } else {
        return res.status(400).json({
          error: "invalid filter value",
          allowed: GROCERY_LIST_FILTER_KEYS,
        });
      }
    }

    try {
      const cutoff = new Date(
        Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      let where: Prisma.GroceryListWhereInput = { userId };
      if (filter === "active") {
        where = {
          userId,
          status: { not: "archived" },
          createdAt: { gt: cutoff },
        };
      } else if (filter === "past") {
        where = { userId, createdAt: { lte: cutoff } };
      }

      const lists = await prisma.groceryList.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { items: true } } },
      });

      return res.status(200).json({
        groceryLists: lists.map((l) => ({
          id: l.id,
          title: l.title,
          status: l.status,
          sourceType: l.sourceType,
          mealPlanInstanceId: l.mealPlanInstanceId,
          itemCount: l._count.items,
          lastGeneratedAt: l.lastGeneratedAt
            ? l.lastGeneratedAt.toISOString()
            : null,
          createdAt: l.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error(
        { event: "list_grocery_lists_failed", userId, err },
        "GET /grocery-lists failed",
      );
      return res.status(500).json({ error: "internal server error" });
    }
  });

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
              // WS7-6 (E): the stored isActiveThisWeek column is gone.
              // Project startDate/endDate and compute the boolean below
              // so the wire shape mobile parses stays unchanged.
              startDate: true,
              endDate: true,
            },
          },
        },
      });
      if (!list) {
        return res.status(404).json({ error: "list_not_found" });
      }
      const listWithComputedActive = list.planInstance
        ? {
            ...list,
            planInstance: {
              id: list.planInstance.id,
              isActiveThisWeek: isInstanceActiveThisWeek(list.planInstance),
            },
          }
        : list;
      return res.status(200).json({ list: listWithComputedActive });
    } catch (err) {
      logger.error(
        { event: "get_grocery_list_failed", userId, listId, err },
        "GET grocery list failed",
      );
      return res.status(500).json({ error: "internal server error" });
    }
  });

  // ── 6c-6 Block B — predictive grocery-add typeahead ─────────────────
  //
  // GET /api/grocery-items/lookup?q=...
  // Lookup-first categorize. Prefix-matches against Ingredient.canonicalName
  // + aliases. Returns up to 5 candidates with source="lookup" when at least
  // one hit; falls through to a single Haiku categorization with source="ai"
  // on zero hits. Free per PRD §1.2 line 74.
  router.get("/grocery-items/lookup", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const qRaw = req.query.q;
    const q = typeof qRaw === "string" ? qRaw : "";
    if (!q || q.trim().length === 0 || q.length > 140) {
      return res.status(400).json({ error: "invalid_query" });
    }

    try {
      const hits = await searchIngredients(prisma, q, 5);
      if (hits.length > 0) {
        const candidates: LookupCandidate[] = hits.map((row) => ({
          ingredientId: row.ingredientId,
          canonicalName: row.canonicalName,
          displayName: row.displayName,
          storeSection: sectionForCategory(row.category),
          defaultUnit: row.defaultUnit,
        }));
        const payload: CategorizeItemResponse = {
          source: "lookup",
          candidates,
        };
        return res.status(200).json(payload);
      }

      // Zero hits → AI fallback. MVP passes nearMatches=undefined; the route
      // could relax prefix to substring in a future pass if telemetry shows
      // typo-heavy traffic is bypassing the AI's near-match reasoning.
      const ai = await categorizeItem(q, undefined, undefined, {
        prisma,
        userId,
      });
      const aiCandidate: LookupCandidate = {
        ingredientId: null,
        canonicalName: ai.itemName,
        displayName: ai.itemName,
        storeSection: ai.sectionKey,
        // suggestedQuantity (e.g. "1 jar") is shopper-friendly purchase
        // language, not a unit token. defaultUnit stays "each" as the
        // schema-safe fallback; mobile reads suggestedQuantity for the
        // typeahead chip + initial qty/unit parsing on select.
        defaultUnit: "each",
        suggestedQuantity: ai.suggestedQuantity ?? null,
      };
      const payload: CategorizeItemResponse = {
        source: "ai",
        candidates: [aiCandidate],
      };
      return res.status(200).json(payload);
    } catch (err) {
      if (err instanceof GroceryListAIError) {
        return res.status(502).json({
          error: "ai_failed",
          message: err.message,
        });
      }
      logger.error(
        { event: "grocery_item_lookup_failed", userId, q, err },
        "grocery-items/lookup failed",
      );
      return res.status(500).json({ error: "internal server error" });
    }
  });

  // POST /api/grocery-lists/:id/items
  // Append a single item to an existing grocery list. Replaces the mobile
  // local-${Date.now()} stub with a real DB round-trip.
  router.post("/grocery-lists/:id/items", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const listIdRaw = req.params.id;
    const listId = Array.isArray(listIdRaw) ? listIdRaw[0] : listIdRaw;
    if (!listId || !UUID_RE.test(listId)) {
      return res.status(400).json({ error: "invalid_list_id" });
    }

    const parsed = AddGroceryListItemInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_body",
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;

    try {
      // Ownership + existence — 404 without leaking whether the list
      // exists on another user.
      const list = await prisma.groceryList.findFirst({
        where: { id: listId, userId },
        select: { id: true },
      });
      if (!list) {
        return res.status(404).json({ error: "list_not_found" });
      }

      // Resolve ingredientId: prefer the client-supplied value (typeahead
      // selection already knows it); otherwise fall back to the same
      // normalized canonical-name lookup the generate route uses, so an
      // item named "salt" still links to the seeded "salt" row.
      let ingredientId: string | null = body.ingredientId ?? null;
      if (!ingredientId) {
        ingredientId = await lookupIngredientIdByCanonicalName(
          prisma,
          body.itemName,
        );
      }

      // Resolve unit default. If we have an ingredientId (client-passed
      // or just looked up), use its defaultUnit; otherwise "each".
      let defaultUnit = "each";
      if (ingredientId && !body.unit) {
        const ing = await prisma.ingredient.findUnique({
          where: { id: ingredientId },
          select: { defaultUnit: true },
        });
        if (ing?.defaultUnit) defaultUnit = ing.defaultUnit;
      }
      const quantity = body.quantity ?? 1;
      const unit = body.unit ?? defaultUnit;

      const item = await prisma.groceryListItem.create({
        data: {
          groceryListId: listId,
          displayName: body.itemName,
          quantity,
          unit,
          storeSection: body.storeSection,
          ingredientId,
          isUniversalStaple: false,
          isUserPantryStaple: false,
          isRecurringItem: false,
          wasAiInferred: false,
          isAmbiguous: false,
          ambiguityOptions: [],
          notes: null,
        },
      });

      // Activity log — fire-and-forget. Emits grocery_item_added with the
      // posted itemName so the feed shows which item was added.
      prisma.userActivity
        .create({
          data: {
            userId,
            eventType: "grocery_item_added",
            entityType: "grocery_list",
            entityId: listId,
            platform: "api",
            metadata: { itemName: body.itemName },
          },
        })
        .catch((err) => {
          logger.warn(
            {
              event: "grocery_add_item_activity_failed",
              userId,
              listId,
              err,
            },
            "Failed to emit add_item activity",
          );
        });

      return res.status(201).json({ item });
    } catch (err) {
      logger.error(
        { event: "grocery_add_item_failed", userId, listId, err },
        "POST /grocery-lists/:id/items failed",
      );
      return res.status(500).json({ error: "internal server error" });
    }
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createGroceryListsRouter();
export default router;
