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

import { randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import type { PrismaClient, Prisma, StoreSection } from "@prisma/client";

import {
  AddGroceryListItemInputSchema,
  UpdateGroceryListItemInputSchema,
  UpdateGroceryListStatusInputSchema,
  type CategorizeItemResponse,
  type LookupCandidate,
  type SectionKey,
} from "../lib/ai/schemas/grocery";
import {
  bucketKeyOf,
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
import { reconcileGroceryListIfStale } from "../lib/groceryReconcile";
import { normalizeIngredientName } from "../lib/groceryNormalization";
import { lookupIngredientByName } from "../lib/ingredientLookup";
import {
  searchIngredientsByPrefix as productionSearchIngredientsByPrefix,
} from "../lib/ingredientSearch";
// WS7-7-A Block 6 (D-WS7-143) — keyset cursor pagination for GET /grocery-lists,
// reusing the GET /me/dishes in-memory precedent verbatim (fetch-all + slice).
import {
  clampLimit,
  decodeKeysetCursor,
  paginateByKeyset,
} from "../lib/listQuery";
import { logger } from "../lib/logger";
import { resolveThisWeekWinnerId } from "../lib/planDates";
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
//
// WS9 BUG-096 — ALIAS-AWARE via the shared helper. A miss writes a null
// ingredientId, losing the pack size / conversion / store section for that row;
// the 81-pair merge deletes the loser rows, so an AI or user mention of a
// merged-away name would start missing without the alias fallback. The primary
// key stays `normalizeIngredientName` so nothing that resolves today stops.
async function lookupIngredientIdByCanonicalName(
  db: PrismaClient | Prisma.TransactionClient,
  canonicalName: string,
): Promise<string | null> {
  const normalized = normalizeIngredientName(canonicalName);
  const hit = await lookupIngredientByName(db, normalized, canonicalName);
  return hit?.id ?? null;
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

        // WS7-7-A Block 1: provenance join map, keyed by the consolidator's
        // bucket key.
        //
        // BUG-165 — the final pass now TELLS us which buckets each row stands
        // for (GenerateListOutputItem.sourceKeys), instead of this join having
        // to re-derive it from (canonicalName, unit). That inference was 1:1 and
        // correct for deterministic rows but lossy for an AI merge: a merged row
        // matches exactly ONE of its parts' buckets, so the other part's source
        // rows were dropped — the merged salt row kept 8 of its 9 sources, and
        // which 8 depended on which unit the model happened to emit.
        // `sourceKeys` is unioned below; the old key is kept as the fallback for
        // any row that somehow carries none.
        const sourcesByKey = new Map<string, typeof consolidated[number]["sources"]>();
        for (const c of consolidated) {
          sourcesByKey.set(bucketKeyOf(c.canonicalName, c.unit), c.sources);
        }

        // 6. Persist GroceryList + items (+ provenance) atomically. Item ids are
        //    generated here so the source rows can reference them in the same
        //    tx without a round-trip read between the two bulk writes.
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
            id: randomUUID(),
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
            // WS7-7-A Block 1: all generation rows are plan-derived.
            isUserAdded: false,
            notes: item.notes,
            // WS7-8b B2 commit 3 — persist the pack as DATA (was baked into
            // displayName). The client composes the two-part line at render;
            // reconcile regenerates these from fresh conversion data.
            purchaseUnit: item.purchaseUnit ?? null,
            purchaseQuantity: item.purchaseQuantity ?? null,
            purchaseDisplay: item.purchaseDisplay ?? null,
          }));

          // Build source rows by joining each final item back to its
          // consolidated source set via the bucket key. No match → no rows.
          const sourceRows = final.items.flatMap((item, idx) => {
            const keys =
              item.sourceKeys && item.sourceKeys.length > 0
                ? item.sourceKeys
                : [bucketKeyOf(item.canonicalName, item.unit)];
            // Union across every bucket the row absorbed, deduped on the
            // (mealId, dishId) pair — the same identity the consolidator uses.
            const seen = new Set<string>();
            const sources = keys
              .flatMap((k) => sourcesByKey.get(k) ?? [])
              .filter((s) => {
                const id = `${s.mealId}|${s.dishId}`;
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
              });
            return sources.map((s) => ({
              groceryListItemId: items[idx].id,
              mealId: s.mealId,
              dishId: s.dishId,
              // WS7-7-A Block 5 — persist the Q1 change-signature per source.
              servings: s.servings,
              ingredientSignature: s.ingredientSignature,
            }));
          });

          if (items.length > 0) {
            await tx.groceryListItem.createMany({ data: items });
          }
          if (sourceRows.length > 0) {
            await tx.groceryListItemSource.createMany({ data: sourceRows });
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
  // Optional ?filter=active|past splits on the ACTIVE_WINDOW_DAYS recency
  // window. WS7-7-A Block 6 (D-WS7-143): keyset-cursor paginated, mirroring
  // GET /me/dishes (in-memory slice). ?limit (default 20, [1,100]) + opaque
  // base64url ?cursor; the filter narrows the fetched set BEFORE the cursor
  // slice, so a cursor can't bypass the filter. The additive nextCursor is the
  // only wire change — every existing row field is preserved (§27).
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
    const limit = clampLimit(req.query.limit);
    // Forgiving decode: malformed/unknown cursor → null → first page.
    const cursor = decodeKeysetCursor(req.query.cursor);

    try {
      const cutoff = new Date(
        Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      // WS9 3d Part 3c-2 (BUG-055 sibling / A1 root cause) — EVERY branch
      // excludes archived rows. The compost cascade (plans.ts DELETE) sets a
      // grocery list's status to "archived" so it drops off the library with its
      // plan; the pre-existing default (no-filter) and "past" branches carried no
      // status filter, so a composted plan's list stayed visible in the mobile
      // Groceries index (which reads with no filter). Only the "active" branch
      // filtered archived before. `archived` is a server-internal status the
      // client PATCH validator never writes (see plans.ts cascade comment).
      let where: Prisma.GroceryListWhereInput = {
        userId,
        status: { not: "archived" },
      };
      if (filter === "active") {
        where = {
          userId,
          status: { not: "archived" },
          createdAt: { gt: cutoff },
        };
      } else if (filter === "past") {
        where = {
          userId,
          status: { not: "archived" },
          createdAt: { lte: cutoff },
        };
      }

      const lists = await prisma.groceryList.findMany({
        where,
        // WS7-7-A Block 6 — createdAt desc keeps most-recent-first; the id desc
        // tiebreaker makes same-createdAt rows slice stably under the keyset
        // cursor (id is the cursor's tiebreaker, mirroring GET /me/dishes).
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // WS7-7-A Block 2 — itemCount excludes soft-deleted rows so the
        // library badge matches what GET detail renders.
        include: {
          _count: { select: { items: { where: { deletedAt: null } } } },
        },
      });

      // WS7-6 (E) Block 2 — single This-Week winner per request. ONE narrow
      // resolver call (covering-subset findMany; not full hydration), then
      // each list item derives isActiveThisWeek by id-compare. Mirrors the
      // R1/R2/R6/R7 + grocery-list detail GET pattern (§27 single source of
      // truth — no parallel computation).
      // WS7-7-A Block 6 — resolved over the FULL fetched set BEFORE the cursor
      // slice, so a winner row that falls on a later page still gets the flag.
      const winnerId = await resolveThisWeekWinnerId(prisma, userId);

      const rows = lists.map((l) => ({
        id: l.id,
        title: l.title,
        status: l.status,
        sourceType: l.sourceType,
        mealPlanInstanceId: l.mealPlanInstanceId,
        isActiveThisWeek:
          l.mealPlanInstanceId !== null &&
          winnerId !== null &&
          l.mealPlanInstanceId === winnerId,
        itemCount: l._count.items,
        lastGeneratedAt: l.lastGeneratedAt
          ? l.lastGeneratedAt.toISOString()
          : null,
        createdAt: l.createdAt.toISOString(),
      }));

      // WS7-7-A Block 6 — in-memory keyset slice over the pre-sorted, already-
      // filtered rows (verbatim GET /me/dishes precedent). Fixed sort key
      // "date_created" + createdAt value reuse the shared helper unchanged; the
      // cross-sort guard is moot (this list has a single fixed ordering).
      const { page, nextCursor } = paginateByKeyset(
        rows,
        cursor,
        limit,
        "date_created",
        (r) => r.createdAt,
      );

      return res.status(200).json({ groceryLists: page, nextCursor });
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
      // WS7-7-A Block 4 (D-WS7-079) — incremental reconcile-on-read. If the
      // source plan has advanced past lastGeneratedFromPlanRevisionId, this
      // re-resolves the changed/added/removed-meal subset and stamps the
      // pointer; revision-equal lists pay nothing. Reconcile is best-effort:
      // a GroceryListAIError (or any failure) aborts before its single write
      // transaction, so the list is unchanged and un-stamped — we log and
      // serve the prior persisted state rather than 5xx the read (the next
      // GET retries). All consolidation + AI work happens inside the service
      // before any DB write, so a failure never leaves a half-reconciled list.
      // WS7-7-A Block 5 — surface whether this read reconciled the list to plan
      // changes, so the client can show the "updating to match plan changes"
      // banner (data-driven, not a timer). False on the revision-equal fast
      // path and on a reconcile failure (we served prior state).
      let reconciled = false;
      try {
        const result = await reconcileGroceryListIfStale(listId, userId, {
          prisma,
          consolidatePlanIngredients,
          fillPurchaseSizesWithWriteBack,
          generateFinalGroceryList,
        });
        reconciled = result.reconciled;
      } catch (reconcileErr) {
        logger.warn(
          {
            event: "grocery_reconcile_failed",
            userId,
            listId,
            err: reconcileErr,
          },
          "Grocery list reconcile failed; serving prior state un-stamped",
        );
      }

      const list = await prisma.groceryList.findFirst({
        where: { id: listId, userId },
        include: {
          items: {
            // WS7-7-A Block 2 — soft-deleted rows are hidden from the list
            // view until restored (§12.9 undo window).
            where: { deletedAt: null },
            orderBy: [
              { storeSection: "asc" },
              { displayName: "asc" },
            ],
            // WS9 3e Part 2.2 — per-item meal provenance ("from which meal").
            // GroceryListItemSource carries mealId (a bare String, no Meal
            // relation), so we pull the ids here and title-join below. An item
            // is 1-to-many across sources; merged/renamed AI-tail rows join to
            // ZERO sources (measured ~89.5% coverage) and render no label —
            // graceful absence, not a placeholder.
            include: { sources: { select: { mealId: true } } },
          },
          planInstance: {
            select: { id: true },
          },
        },
      });
      if (!list) {
        return res.status(404).json({ error: "list_not_found" });
      }

      // WS9 3e Part 2.2 — resolve source mealIds → distinct meal titles in ONE
      // query, then attach `mealNames` (deduped, order-stable) to each item.
      const sourceMealIds = [
        ...new Set(
          list.items.flatMap((i) => i.sources.map((sr) => sr.mealId)),
        ),
      ];
      const mealTitleById = new Map<string, string>();
      if (sourceMealIds.length > 0) {
        const meals = await prisma.meal.findMany({
          where: { id: { in: sourceMealIds } },
          select: { id: true, title: true },
        });
        for (const m of meals) mealTitleById.set(m.id, m.title);
      }
      const itemsWithProvenance = list.items.map((i) => {
        const { sources, ...rest } = i;
        const names: string[] = [];
        for (const sr of sources) {
          const t = mealTitleById.get(sr.mealId);
          if (t && !names.includes(t)) names.push(t);
        }
        return { ...rest, mealNames: names };
      });
      const listWithProvenance = { ...list, items: itemsWithProvenance };
      // WS7-6 (E) Block 1 REWORK — resolve "is the linked plan THIS WEEK's
      // plan?" against the list owner's covering subset, not the linked
      // row in isolation. Only fires when planInstance is present (lists
      // for null-plan source types like recurring stock skip this read).
      const listWithComputedActive = listWithProvenance.planInstance
        ? {
            ...listWithProvenance,
            planInstance: await (async () => {
              const winnerId = await resolveThisWeekWinnerId(prisma, userId);
              return {
                id: listWithProvenance.planInstance!.id,
                isActiveThisWeek:
                  winnerId !== null &&
                  winnerId === listWithProvenance.planInstance!.id,
              };
            })(),
          }
        : listWithProvenance;
      return res
        .status(200)
        .json({ list: listWithComputedActive, reconciled });
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
          // WS7-7-A Block 1: user "Extras" — owned by the user, no plan source.
          // Reconcile never touches these; no GroceryListItemSource rows.
          isUserAdded: true,
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

  // ── WS7-7-A Block 2 — grocery item mutations ────────────────────────
  // Ownership gate convention (mirrors POST /:id/items above): a missing
  // list AND a cross-user list both return 404, never leaking existence.
  // No literal 403 on any of these routes by design.

  // PATCH /api/grocery-lists/:id — §12.6.3 mark-shopping-done. Bidirectional
  // active⇄completed; the Zod enum rejects every other target value.
  router.patch("/grocery-lists/:id", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const listIdRaw = req.params.id;
    const listId = Array.isArray(listIdRaw) ? listIdRaw[0] : listIdRaw;
    if (!listId || !UUID_RE.test(listId)) {
      return res.status(400).json({ error: "invalid_list_id" });
    }

    const parsed = UpdateGroceryListStatusInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_body",
        details: parsed.error.flatten(),
      });
    }

    try {
      const list = await prisma.groceryList.findFirst({
        where: { id: listId, userId },
        select: { id: true },
      });
      if (!list) {
        return res.status(404).json({ error: "list_not_found" });
      }

      const updated = await prisma.groceryList.update({
        where: { id: listId },
        data: { status: parsed.data.status },
      });
      return res.status(200).json({ list: updated });
    } catch (err) {
      logger.error(
        { event: "grocery_update_list_status_failed", userId, listId, err },
        "PATCH /grocery-lists/:id failed",
      );
      return res.status(500).json({ error: "internal server error" });
    }
  });

  // PATCH /api/grocery-lists/:id/items/:itemId — partial item update.
  // §12.9 inline edits (qty/unit/displayName/section/check), §12.7 staple
  // opt-in, §12.5 ambiguity resolution. All persist immediately, no save.
  router.patch(
    "/grocery-lists/:id/items/:itemId",
    requireAuth,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const listIdRaw = req.params.id;
      const listId = Array.isArray(listIdRaw) ? listIdRaw[0] : listIdRaw;
      const itemIdRaw = req.params.itemId;
      const itemId = Array.isArray(itemIdRaw) ? itemIdRaw[0] : itemIdRaw;
      if (!listId || !UUID_RE.test(listId)) {
        return res.status(400).json({ error: "invalid_list_id" });
      }
      if (!itemId || !UUID_RE.test(itemId)) {
        return res.status(400).json({ error: "invalid_item_id" });
      }

      const parsed = UpdateGroceryListItemInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid_body",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      try {
        // Item + list ownership in one read: the item must belong to a list
        // owned by this user. Missing item, cross-user list, or mismatched
        // (listId, itemId) pair all 404.
        const item = await prisma.groceryListItem.findFirst({
          where: {
            id: itemId,
            groceryListId: listId,
            groceryList: { userId },
          },
          select: { id: true },
        });
        if (!item) {
          return res.status(404).json({ error: "item_not_found" });
        }

        // Build the update from only the provided fields. userResolvedTo
        // carries §12.5 coherence: a non-null resolution flips isAmbiguous
        // to false (item is now resolved) while keeping ambiguityOptions as
        // an audit trail; clearing to null leaves isAmbiguous untouched.
        const data: Prisma.GroceryListItemUpdateInput = {};
        if (body.isChecked !== undefined) data.isChecked = body.isChecked;
        if (body.quantity !== undefined) data.quantity = body.quantity;
        if (body.unit !== undefined) data.unit = body.unit;
        if (body.stapleOptedIn !== undefined)
          data.stapleOptedIn = body.stapleOptedIn;
        if (body.storeSection !== undefined)
          data.storeSection = body.storeSection;
        if (body.displayName !== undefined)
          data.displayName = body.displayName;
        if (body.userResolvedTo !== undefined) {
          data.userResolvedTo = body.userResolvedTo;
          if (body.userResolvedTo !== null) {
            data.isAmbiguous = false;
          }
        }
        // WS7-7-A Block 5 "leave-as-is" — clear the ambiguous flag without a
        // resolution value. Permanent (won't re-surface on view/reconcile);
        // userResolvedTo stays null so the row renders its own displayName, not
        // a projection. Distinct from userResolvedTo:null (which leaves the flag
        // untouched). Ignored if the same request also resolves to a value.
        if (body.acknowledgeAmbiguity === true && body.userResolvedTo == null) {
          data.isAmbiguous = false;
        }

        const updated = await prisma.groceryListItem.update({
          where: { id: itemId },
          data,
        });
        return res.status(200).json({ item: updated });
      } catch (err) {
        logger.error(
          { event: "grocery_update_item_failed", userId, listId, itemId, err },
          "PATCH /grocery-lists/:id/items/:itemId failed",
        );
        return res.status(500).json({ error: "internal server error" });
      }
    },
  );

  // DELETE /api/grocery-lists/:id/items/:itemId — §12.9 soft-delete with a
  // restore window. Sets deletedAt; the row id is preserved (D-WS6-082:
  // restore must reuse the same id) and its GroceryListItemSource rows stay
  // intact (cascade fires on hard delete only). Returns the deleted item so
  // the mobile undo toast has the shape to restore. Idempotent: deleting an
  // already-deleted item returns it unchanged.
  router.delete(
    "/grocery-lists/:id/items/:itemId",
    requireAuth,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const listIdRaw = req.params.id;
      const listId = Array.isArray(listIdRaw) ? listIdRaw[0] : listIdRaw;
      const itemIdRaw = req.params.itemId;
      const itemId = Array.isArray(itemIdRaw) ? itemIdRaw[0] : itemIdRaw;
      if (!listId || !UUID_RE.test(listId)) {
        return res.status(400).json({ error: "invalid_list_id" });
      }
      if (!itemId || !UUID_RE.test(itemId)) {
        return res.status(400).json({ error: "invalid_item_id" });
      }

      try {
        const item = await prisma.groceryListItem.findFirst({
          where: {
            id: itemId,
            groceryListId: listId,
            groceryList: { userId },
          },
          select: { id: true, deletedAt: true },
        });
        if (!item) {
          return res.status(404).json({ error: "item_not_found" });
        }

        // Already soft-deleted → return as-is (idempotent), don't re-stamp
        // deletedAt and shorten the undo window on a double-tap.
        const deleted = item.deletedAt
          ? await prisma.groceryListItem.findUniqueOrThrow({
              where: { id: itemId },
            })
          : await prisma.groceryListItem.update({
              where: { id: itemId },
              data: { deletedAt: new Date() },
            });
        return res.status(200).json({ item: deleted });
      } catch (err) {
        logger.error(
          { event: "grocery_delete_item_failed", userId, listId, itemId, err },
          "DELETE /grocery-lists/:id/items/:itemId failed",
        );
        return res.status(500).json({ error: "internal server error" });
      }
    },
  );

  // POST /api/grocery-lists/:id/items/:itemId/restore — undo the soft-delete.
  // Clears deletedAt on the SAME row (id preserved); provenance survived the
  // soft-delete so no source rows need rebuilding. Idempotent: restoring a
  // live item returns it unchanged.
  router.post(
    "/grocery-lists/:id/items/:itemId/restore",
    requireAuth,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const listIdRaw = req.params.id;
      const listId = Array.isArray(listIdRaw) ? listIdRaw[0] : listIdRaw;
      const itemIdRaw = req.params.itemId;
      const itemId = Array.isArray(itemIdRaw) ? itemIdRaw[0] : itemIdRaw;
      if (!listId || !UUID_RE.test(listId)) {
        return res.status(400).json({ error: "invalid_list_id" });
      }
      if (!itemId || !UUID_RE.test(itemId)) {
        return res.status(400).json({ error: "invalid_item_id" });
      }

      try {
        // Soft-deleted rows are excluded from the GET reads but MUST still be
        // findable here — restore explicitly targets them, so no deletedAt
        // filter on the ownership lookup.
        const item = await prisma.groceryListItem.findFirst({
          where: {
            id: itemId,
            groceryListId: listId,
            groceryList: { userId },
          },
          select: { id: true },
        });
        if (!item) {
          return res.status(404).json({ error: "item_not_found" });
        }

        const restored = await prisma.groceryListItem.update({
          where: { id: itemId },
          data: { deletedAt: null },
        });
        return res.status(200).json({ item: restored });
      } catch (err) {
        logger.error(
          { event: "grocery_restore_item_failed", userId, listId, itemId, err },
          "POST /grocery-lists/:id/items/:itemId/restore failed",
        );
        return res.status(500).json({ error: "internal server error" });
      }
    },
  );

  return router;
}

// Default export — production wiring with real deps.
const router = createGroceryListsRouter();
export default router;
