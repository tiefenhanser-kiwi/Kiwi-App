// POST /api/meals/find-similar — Find Similar AI semantic similarity ranking.
// Per kiwi_ws6_plan.md §3 6b-1 + PRD §8.4 + D-WS5-006.
//
// Auth: requireAuth (JWT). Same factory + DI pattern as wizard.ts so unit
// tests can inject runAICall / prisma / subscriptionService stubs without
// standing up the full stack.
//
// Contract: client-sends-full-payload. Server does NOT query the DB for the
// candidate pool — the mobile client unions saved + featured + top rated +
// hosting catalogs and posts the full set with each request. WS6 stub data
// makes the server-side query path impossible today; WS7 flips the client
// to fetch real data first while leaving this server contract stable.
//
// Premium-deny path: returns the cuisine-only fallback in the same response
// shape (no AI call, no LLMCallLog row, no activity event). This mirrors the
// free-tier behavior of the existing client-side findSimilarMealsByCuisine
// helper so the sheet can render either response without branching.

import { Router, type IRouter, type Request } from "express";
import type { PrismaClient } from "@prisma/client";

import { runAICall as productionRunAICall } from "../lib/ai/runAICall";
import {
  FindSimilarRequestSchema,
  FindSimilarResultSchema,
  type FindSimilarRequest,
  type FindSimilarResult,
  type MealCandidate,
} from "../lib/ai/schemas/findSimilar";
import { normalizeIngredientName } from "../lib/groceryNormalization";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { hasUnmatchedAmount, type AmountRef } from "../lib/stepAmountRefs";
import {
  subscriptionService as productionSubscriptionService,
  type SubscriptionService,
} from "../lib/subscriptionService";
import { requireAuth } from "../middleware/auth";

export interface MealsRouterDeps {
  runAICall: typeof productionRunAICall;
  prisma: PrismaClient;
  subscriptionService: SubscriptionService;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}

const DEFAULT_LIMIT = 10;

// PRD §8.4 cuisine-only fallback. Used both server-side on the premium-deny
// path AND mirrored on the mobile client for offline/error-recovery UX.
// Returns matches in title-A-Z order with similarityScore=0 and a fixed reason.
function cuisineOnlyFallback(
  source: MealCandidate,
  candidates: MealCandidate[],
  limit: number,
): FindSimilarResult {
  const sourceCuisine = source.cuisine;
  if (!sourceCuisine) return { matches: [] };
  const sameCuisine = candidates
    .filter((c) => c.cuisine === sourceCuisine && c.id !== source.id)
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, limit);
  return {
    matches: sameCuisine.map((c) => ({
      mealId: c.id,
      similarityScore: 0,
      reason: "Same cuisine",
    })),
  };
}

// D-WS6-003 override-resolution stub. WS7 will inject any per-meal recipe
// overrides into the candidate payload (so the AI ranks the user's customized
// meal, not the canonical recipe). Pass-through for MVP.
function applyOverrides(
  source: MealCandidate,
  candidates: MealCandidate[],
): { source: MealCandidate; candidates: MealCandidate[] } {
  // TODO(WS7 / D-WS6-003): hydrate any per-user RecipeOverride rows for
  // source.id and each candidate id, and use the override's title /
  // ingredients / mealType in the AI input. For now this is a pass-through.
  return { source, candidates };
}

// ─────────────────────────────────────────────────────────────────
// Catalog read helpers (WS7-3 A1 — moved from recipes.ts)
// ─────────────────────────────────────────────────────────────────

export interface MealListItem {
  id: string;
  title: string;
  cuisine: string;
  minutes: number;
  servings: number;
  // WS7-8 BUG-003 — immutable authored-servings anchor (== servings until a
  // future canonical promote). Render denominator; null anchor degrades to
  // servings via the ?? fallback below, so this is always a number on the wire.
  authoredServingsDefault: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  tags: string[];
  image: string | null;
}

// Prisma `select` for the columns toListShape reads. Exported so other
// routers (WS7-3 A2 GET /me/meals) issue an identical projection.
export const MEAL_LIST_SELECT = {
  id: true,
  title: true,
  cuisineType: true,
  estimatedTimeMinutes: true,
  servingsDefault: true,
  authoredServingsDefault: true,
  caloriesPerServing: true,
  proteinGPerServing: true,
  carbsGPerServing: true,
  fatGPerServing: true,
  tags: true,
  imageUrl: true,
} as const;

// GET /meals list shape. Field names are renamed/flattened from the DB
// columns (cuisineType→cuisine, estimatedTimeMinutes→minutes, *PerServing→
// bare). Kept verbatim from recipes.ts — mobile adapts at WS7-3 B/C.
export function toListShape(m: {
  id: string;
  title: string;
  cuisineType: string | null;
  estimatedTimeMinutes: number;
  servingsDefault: number;
  authoredServingsDefault: number | null;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  tags: string[];
  imageUrl: string | null;
}): MealListItem {
  return {
    id: m.id,
    title: m.title,
    cuisine: m.cuisineType ?? "",
    minutes: m.estimatedTimeMinutes,
    servings: m.servingsDefault,
    // WS7-8 BUG-003 — null anchor (legacy/seed rows) degrades to servingsDefault.
    authoredServingsDefault: m.authoredServingsDefault ?? m.servingsDefault,
    calories: m.caloriesPerServing,
    protein: m.proteinGPerServing,
    carbs: m.carbsGPerServing,
    fat: m.fatGPerServing,
    tags: m.tags,
    image: m.imageUrl,
  };
}

// GET /meals/:id step shape — shared by per-dish steps and the top-level
// meal-owned steps array. Exported so GET /dishes/:id (WS7-3 A2) reuses it.
export function toStepShape(s: {
  stepIndex: number;
  stepTextTranslated: string;
  estimatedMinutes: number;
  phaseType: string;
  parallelGroup: string | null;
  requiresPreheat: boolean;
  requiresRest: boolean;
  requiresMarination: boolean;
  isTimingSensitive: boolean;
  // WS7-8b BUG-003 Block 1 — sidecar step→ingredient refs. The DB column is
  // Json?; null on legacy/unwired steps, an array (possibly []) on steps
  // derived by a Block-1 generation/create seam.
  amountRefs?: unknown;
}) {
  return {
    stepIndex: s.stepIndex,
    text: s.stepTextTranslated,
    estimatedMinutes: s.estimatedMinutes,
    phaseType: s.phaseType,
    parallelGroup: s.parallelGroup,
    requiresPreheat: s.requiresPreheat,
    requiresRest: s.requiresRest,
    requiresMarination: s.requiresMarination,
    isTimingSensitive: s.isTimingSensitive,
    // Pass the stored Json through verbatim — null stays null (legacy → plain
    // render), an array stays an array. Mobile MealStepSchema validates shape.
    amountRefs: (s.amountRefs ?? null) as AmountRef[] | null,
    // WS7-8b BUG-003 Block 1 — derived read-side (not stored); false on legacy.
    unmatchedAmount: hasUnmatchedAmount(s.stepTextTranslated, s.amountRefs ?? null),
  };
}

// GET /meals/:id detail shapes — exported so GET /plans/:id (WS7-3 A2) can
// type the per-item Meal expansion.
export type MealStepShape = ReturnType<typeof toStepShape>;

export interface MealDetailDish {
  dishId: string;
  title: string;
  roleLabel: string;
  positionIndex: number;
  minutes: number;
  difficulty: string;
  servings: number;
  // WS7-8 BUG-003 — per-dish authored-servings anchor (== servings until a
  // future canonical promote). Null anchor degrades to servings on the wire.
  authoredServingsDefault: number;
  ingredients: {
    name: string;
    quantity: number;
    unit: string;
    preparationNote: string | null;
    category: string;
    isOptional: boolean;
  }[];
  steps: MealStepShape[];
}

export interface MealDetail extends MealListItem {
  description: string | null;
  difficulty: string;
  mealType: string;
  sourceType: string;
  isPublic: boolean;
  userId: string | null;
  dishes: MealDetailDish[];
  steps: MealStepShape[];
  notes: null;
  // WS7-8b (D-WS7-169 keystone) — the plan-instance-resolved servings
  // (servingsOverride ?? servingsDefault). DISTINCT from the authored
  // `servings` (= servingsDefault), which stays the ingredient-scaling
  // denominator. No plan item / no override → effectiveServings === servings.
  effectiveServings: number;
}

// WS7-7-A B5 (D-WS7-090 read-side) — per-instance RecipeOverride applied to a
// composed meal detail. Mirrors the grocery consolidator's WHOLESALE-replace
// semantics (groceryList.ts:329-341): an override dish at a position replaces
// that base dish's ingredient list ENTIRELY, so a "just this time" removal
// stays absent on re-open instead of being merged back from the canonical
// recipe. Tolerant of malformed JSON (a null/garbage override → canonical
// recipe). Only `titleOverride` + `dishes[].ingredients[]` are read — the
// fields the meal-detail view needs.
interface ParsedOverrideDishForView {
  ingredients: { name: string; quantity: number; unit: string }[];
}
interface ParsedRecipeOverrideForView {
  titleOverride: string | null;
  dishes: ParsedOverrideDishForView[];
}

export function parseRecipeOverrideForView(
  json: unknown,
): ParsedRecipeOverrideForView | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as { titleOverride?: unknown; dishes?: unknown };
  if (!Array.isArray(obj.dishes)) return null;
  const dishes: ParsedOverrideDishForView[] = obj.dishes.map((d) => {
    const ings =
      d && typeof d === "object"
        ? (d as { ingredients?: unknown }).ingredients
        : undefined;
    const list: ParsedOverrideDishForView["ingredients"] = [];
    if (Array.isArray(ings)) {
      for (const ig of ings) {
        if (!ig || typeof ig !== "object") continue;
        const { name, quantity, unit } = ig as {
          name?: unknown;
          quantity?: unknown;
          unit?: unknown;
        };
        if (
          typeof name === "string" &&
          typeof quantity === "number" &&
          typeof unit === "string"
        ) {
          list.push({ name, quantity, unit });
        }
      }
    }
    return { ingredients: list };
  });
  return {
    titleOverride:
      typeof obj.titleOverride === "string" ? obj.titleOverride : null,
    dishes,
  };
}

// Apply a parsed override onto the composed dishes. Matched to base dishes by
// POSITION INDEX (same as the consolidator): an override dish at index i
// replaces base dish i's ingredient list wholesale. Base dishes with no
// override entry (override shorter than the meal, or a missing position) keep
// their canonical ingredients. Category / prep-note / isOptional are carried
// from the base ingredient by normalized name when the override keeps it;
// brand-new override ingredients default (category "" → the view's "other"
// grouping, no prep, not optional).
export function applyRecipeOverrideToDishes(
  dishes: MealDetailDish[],
  override: ParsedRecipeOverrideForView,
): MealDetailDish[] {
  return dishes.map((dish, index) => {
    const od = override.dishes[index];
    if (!od) return dish;
    const baseByName = new Map<string, MealDetailDish["ingredients"][number]>();
    for (const bi of dish.ingredients) {
      baseByName.set(normalizeIngredientName(bi.name), bi);
    }
    const ingredients = od.ingredients.map((oi) => {
      const base = baseByName.get(normalizeIngredientName(oi.name));
      return {
        name: oi.name,
        quantity: oi.quantity,
        unit: oi.unit,
        preparationNote: base?.preparationNote ?? null,
        category: base?.category ?? "",
        isOptional: base?.isOptional ?? false,
      };
    });
    return { ...dish, ingredients };
  });
}

// Compose the full meal-detail payload — meal meta + per-dish ingredients +
// dish-owned (or legacy meal-owned fallback) steps. Returns null when the
// meal is missing or archived. Shared by GET /meals/:id and the per-item
// Meal expansion in GET /plans/:id.
//
// WS7-7-A B5 (D-WS7-090 read-side): when `recipeOverrideJson` is supplied (the
// caller passes a plan item's per-instance override), the override is applied
// to the dishes + title so a "just this time" edit is visible here, not only on
// the grocery list. Omitted/null → the canonical meal (unchanged behavior).
export async function composeMealDetail(
  prisma: PrismaClient,
  id: string,
  recipeOverrideJson?: unknown,
  servingsOverride?: number | null,
): Promise<MealDetail | null> {
  const meal = await prisma.meal.findUnique({
    where: { id },
    include: {
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        include: {
          dish: {
            include: {
              dishIngredients: {
                orderBy: { positionIndex: "asc" },
                include: { ingredient: true },
              },
            },
          },
        },
      },
    },
  });

  if (!meal || meal.isArchived) return null;

  const dishIds = meal.dishLinks.map((l) => l.dish.id);

  // Steps use the polymorphic ownerType/ownerId pattern (no Prisma relation —
  // the FK is application-enforced). Meal-owned steps cover legacy/seed
  // single-dish meals; dish-owned steps cover multi-dish meals. Both are
  // queried; precedence is resolved per-dish below.
  const [mealSteps, dishSteps] = await Promise.all([
    prisma.recipeInstructionStep.findMany({
      where: { ownerType: "meal", ownerId: id },
      orderBy: { stepIndex: "asc" },
    }),
    dishIds.length > 0
      ? prisma.recipeInstructionStep.findMany({
          where: { ownerType: "dish", ownerId: { in: dishIds } },
          orderBy: { stepIndex: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const dishStepsByOwner = new Map<string, typeof dishSteps>();
  for (const s of dishSteps) {
    const arr = dishStepsByOwner.get(s.ownerId) ?? [];
    arr.push(s);
    dishStepsByOwner.set(s.ownerId, arr);
  }

  const dishes: MealDetailDish[] = meal.dishLinks.map((link) => {
    const d = link.dish;
    const ownSteps = dishStepsByOwner.get(d.id) ?? [];
    // Step ownership precedence: per-dish steps when this dish owns any, else
    // fall back to meal-owned steps grouped under the dish (legacy single-dish
    // meals seeded with ownerType: "meal").
    const steps = ownSteps.length > 0 ? ownSteps : mealSteps;
    return {
      dishId: d.id,
      title: d.title,
      roleLabel: link.roleLabel,
      positionIndex: link.positionIndex,
      // Shared meta fields use the list-style renamed names; dish-only fields
      // (dishId, roleLabel, positionIndex) keep DB names.
      minutes: d.estimatedTimeMinutes,
      difficulty: d.difficulty,
      servings: d.servingsDefault,
      // WS7-8 BUG-003 — null anchor (legacy/seed rows) degrades to servingsDefault.
      authoredServingsDefault: d.authoredServingsDefault ?? d.servingsDefault,
      ingredients: d.dishIngredients.map((di) => ({
        name: di.ingredient.displayName,
        quantity: di.quantity,
        unit: di.unit,
        preparationNote: di.preparationNote,
        category: di.ingredient.category,
        isOptional: di.isOptional,
      })),
      steps: steps.map(toStepShape),
    };
  });

  // WS7-7-A B5 — apply the per-instance override (when supplied) to the
  // canonical dishes + title. A null/garbage override parses to null → no-op.
  const override =
    recipeOverrideJson != null
      ? parseRecipeOverrideForView(recipeOverrideJson)
      : null;
  const effectiveDishes = override
    ? applyRecipeOverrideToDishes(dishes, override)
    : dishes;

  // WS7-8b (D-WS7-169 keystone) — resolve the per-instance servings override
  // into a DISTINCT field. The authored `servings` (from toListShape =
  // servingsDefault) is left untouched so the mobile ingredient scaler keeps
  // using it as the denominator; effectiveServings is the display target.
  const effectiveServings =
    typeof servingsOverride === "number"
      ? servingsOverride
      : meal.servingsDefault;

  return {
    // Shared meal-meta fields reuse the GET /meals list shape (toListShape):
    // id, title, cuisine, minutes, servings, calories/protein/carbs/fat,
    // tags, image. Detail-only fields keep their DB-style names.
    ...toListShape(meal),
    // A "just this time" rename rides on titleOverride; apply it over the
    // canonical title when present.
    ...(override?.titleOverride ? { title: override.titleOverride } : {}),
    description: meal.description,
    difficulty: meal.difficulty,
    mealType: meal.mealType,
    sourceType: meal.sourceType,
    isPublic: meal.isPublic,
    userId: meal.userId,
    dishes: effectiveDishes,
    // Top-level meal-owned steps — populated for legacy single-dish meals,
    // empty when dishes carry their own steps. Defensive shape: mobile reads
    // meal.dishes[].steps first.
    steps: mealSteps.map(toStepShape),
    notes: null,
    effectiveServings,
  };
}

export function createMealsRouter(
  deps: Partial<MealsRouterDeps> = {},
): IRouter {
  const runAICall = deps.runAICall ?? productionRunAICall;
  const prisma = deps.prisma ?? productionPrisma;
  const subscriptionService =
    deps.subscriptionService ?? productionSubscriptionService;
  // Same per-user token-bucket pattern as wizard routes. Find Similar is
  // cheap (Haiku) but we still want a per-user ceiling to discourage abuse
  // and to keep the cost-of-bug ceiling tight.
  const limiterOpts = deps.rateLimiterOpts ?? {
    capacity: 12,
    refillPerSec: 12 / 60,
  };

  async function emitActivity(
    userId: string,
    eventType: "meal_found_similar_used",
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

  const router: IRouter = Router();

  const findSimilarLimiter = rateLimit({
    ...limiterOpts,
    keyFn: (req: Request) => `findsim:${req.userId ?? "anonymous"}`,
  });

  // Catalog read limiter — 30 burst, ~1 every 2s. Created per-router so
  // unit-test harnesses each get their own bucket.
  const catalogLimiter = rateLimit({ capacity: 30, refillPerSec: 30 / 60 });

  router.post(
    "/meals/find-similar",
    requireAuth,
    findSimilarLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }

      // 1. Validate the input.
      const parsed = FindSimilarRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const request: FindSimilarRequest = parsed.data;
      const limit = request.limit ?? DEFAULT_LIMIT;

      // 2. Drop the source meal from candidates if the client accidentally
      //    included it. Defensive — a self-match would be confusing in the UI.
      const candidates = request.candidates.filter(
        (c) => c.id !== request.source.id,
      );

      // 3. Entitlement check. Premium-deny path returns the cuisine-only
      //    fallback in the same response shape — no AI call, no LLMCallLog,
      //    no activity event. Trial-mode (WS6) currently always allows.
      const ent = await subscriptionService.can(userId, "find_similar_ai");
      if (!ent.allowed) {
        const fallback = cuisineOnlyFallback(
          request.source,
          candidates,
          limit,
        );
        return res.json({
          ...fallback,
          metadata: {
            promptVersion: null,
            latencyMs: 0,
            mode: "fallback_cuisine",
          },
        });
      }

      // 4. Override-resolution pass-through (D-WS6-003 stub; WS7 wires real
      //    overrides). No-op for MVP; documented above the helper.
      const resolved = applyOverrides(request.source, candidates);

      // 5. AI call. Haiku, text+Zod, single retry — same pattern as the
      //    Tell Kiwi parse step.
      const result = await runAICall(
        "meals.find_similar",
        {
          findSimilarInput: {
            source: resolved.source,
            candidates: resolved.candidates,
            limit,
          },
        },
        FindSimilarResultSchema,
        { prisma, userId },
      );

      if (!result.success) {
        logger.warn(
          {
            event: "find_similar_failed",
            userId,
            reason: result.reason,
            promptKey: "meals.find_similar",
          },
          "Find Similar AI call failed",
        );
        return res.status(502).json({
          error: result.userFacingMessage,
          reason: result.reason,
        });
      }

      // 6. Defensive trim + drop any matches the AI invented (mealId not in
      //    the candidate set) before returning.
      const validIds = new Set(candidates.map((c) => c.id));
      const filtered = result.data.matches
        .filter((m) => validIds.has(m.mealId))
        .slice(0, limit);

      // 7. Activity event — only on the AI path.
      await emitActivity(userId, "meal_found_similar_used", request.source.id);

      return res.json({
        matches: filtered,
        metadata: {
          promptVersion: result.metadata.promptVersion,
          latencyMs: result.metadata.latencyMs,
          mode: "ai",
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // Catalog GET endpoints (WS7-3 A1 — moved from recipes.ts; the old
  // /recipes + /recipes/:id paths are a clean break, no alias).
  // ─────────────────────────────────────────────────────────────────

  // GET /meals — public meal catalog, keyset-paginated, title A-Z.
  router.get("/meals", requireAuth, catalogLimiter, async (req, res) => {
    // Explicit NaN/undefined check so ?limit=0 clamps to 1 rather than
    // falling through a falsy `|| 20` default. Missing/empty/non-numeric
    // still default to 20; negatives and 0 clamp to 1; >100 clamps to 100.
    const limitRaw = req.query.limit;
    const limitParsed =
      limitRaw === undefined ? 20 : parseInt(String(limitRaw), 10);
    const limit = Math.min(
      100,
      Math.max(1, Number.isNaN(limitParsed) ? 20 : limitParsed),
    );
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.length > 0
        ? req.query.cursor
        : undefined;

    try {
      const meals = await prisma.meal.findMany({
        where: { isArchived: false, isPublic: true },
        select: {
          id: true,
          title: true,
          cuisineType: true,
          estimatedTimeMinutes: true,
          servingsDefault: true,
          caloriesPerServing: true,
          proteinGPerServing: true,
          carbsGPerServing: true,
          fatGPerServing: true,
          tags: true,
          imageUrl: true,
        },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { title: "asc" },
      });

      const hasMore = meals.length > limit;
      const page = hasMore ? meals.slice(0, limit) : meals;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      return res.json({ meals: page.map(toListShape), nextCursor });
    } catch (err) {
      logger.error({ err }, "Failed to list meals");
      return res.status(500).json({ error: "failed to list meals" });
    }
  });

  // GET /meals/:id — meal detail with per-dish ingredients + steps.
  router.get("/meals/:id", requireAuth, catalogLimiter, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 100) {
      return res.status(400).json({ error: "invalid meal id" });
    }

    // WS7-7-A B5 (D-WS7-090 read-side) — optional plan context. When the caller
    // passes ?planItemId=, load that plan item's per-instance recipeOverrideJson
    // and apply it so a "just this time" edit (incl. a removed ingredient) is
    // visible here, not only on the grocery list. The item read is ownership-
    // scoped to the requester (via the parent plan) AND must reference THIS meal
    // — a missing / foreign / mismatched item leaves the override unset, so the
    // canonical recipe is served (no existence leak, no cross-user read).
    const planItemIdRaw = req.query.planItemId;
    const planItemId =
      typeof planItemIdRaw === "string" &&
      planItemIdRaw.length > 0 &&
      planItemIdRaw.length <= 100
        ? planItemIdRaw
        : null;

    try {
      let recipeOverrideJson: unknown = undefined;
      // WS7-8b (D-WS7-169 keystone) — also read the item's per-instance
      // servingsOverride so the composed detail resolves effectiveServings.
      let servingsOverride: number | null = null;
      if (planItemId) {
        const item = await prisma.mealPlanItem.findFirst({
          where: {
            id: planItemId,
            mealId: id,
            planInstance: { userId: req.userId! },
          },
          select: { recipeOverrideJson: true, servingsOverride: true },
        });
        recipeOverrideJson = item?.recipeOverrideJson ?? undefined;
        servingsOverride = item?.servingsOverride ?? null;
      }

      const meal = await composeMealDetail(
        prisma,
        id,
        recipeOverrideJson,
        servingsOverride,
      );
      if (!meal) {
        return res.status(404).json({ error: "meal not found" });
      }
      return res.json({ meal });
    } catch (err) {
      logger.error({ err, id }, "Failed to fetch meal detail");
      return res.status(500).json({ error: "failed to fetch meal" });
    }
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createMealsRouter();
export default router;
