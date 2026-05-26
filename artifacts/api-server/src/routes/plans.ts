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
import {
  clampLimit,
  mergeById,
  paginateById,
  parseFilterParam,
} from "../lib/listQuery";
import {
  instanceToSummary,
  INSTANCE_TEMPLATE_INCLUDE,
  PLAN_FILTER_KEYS,
  resolvePlansForFilter,
  type InstanceRow,
  type PlanListItem,
} from "../lib/planQueries";
import { composeMealDetail, type MealDetail } from "./meals";

export interface PlansRouterDeps {
  computePlanMacros: typeof productionComputePlanMacros;
  prisma: PrismaClient;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
  mutationLimiterOpts?: { capacity: number; refillPerSec: number };
}

// Per-filter fetch cap for GET /plans. Each filter is resolved up to this
// many rows; the merged union is then cursor-paginated down to the page
// `limit`. 100 (the max page size) keeps page 2+ reachable across the union.
const PLAN_FETCH_CAP = 100;

interface PlanReviewItem {
  assignedDayOfWeek: string | null;
  assignedDate: string | null;
  meal: MealDetail | null;
}

// macroDailyAverage — fresh per request. MealPlanInstance has no
// lastMacroCalcRevisionId column, so the WS7-3 A2 §1.8 cache path does not
// exist; this is a plain arithmetic rollup of each item meal's per-serving
// macros divided by the number of distinct assigned days. See WS7-3 A2
// Phase 3 report §8 (F-A2-4).
function computeMacroDailyAverage(items: PlanReviewItem[]): {
  caloriesPerDay: number;
  proteinGPerDay: number;
  carbsGPerDay: number;
  fatGPerDay: number;
} {
  let cal = 0;
  let pro = 0;
  let carb = 0;
  let fat = 0;
  const days = new Set<string>();
  for (const it of items) {
    if (it.meal) {
      cal += it.meal.calories;
      pro += it.meal.protein;
      carb += it.meal.carbs;
      fat += it.meal.fat;
    }
    const dayKey = it.assignedDate ?? it.assignedDayOfWeek;
    if (dayKey) days.add(dayKey);
  }
  const dayCount =
    days.size > 0 ? days.size : items.length > 0 ? items.length : 1;
  const round1 = (n: number): number => Math.round((n / dayCount) * 10) / 10;
  return {
    caloriesPerDay: round1(cal),
    proteinGPerDay: round1(pro),
    carbsGPerDay: round1(carb),
    fatGPerDay: round1(fat),
  };
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

  // WS7-4-A — mutation rate limiter (Ruling 12). 60/min per user. Mutations
  // burst during a focused edit session (drag-reorder, add 3-4 meals,
  // swap-recipe) more than recalc fires; the 12/min recalc bucket would be
  // too tight. Registered now; consumed by the mutation routes that land
  // in WS7-4-C / WS7-4-D.
  const mutationLimiterDefaults = deps.mutationLimiterOpts ?? {
    capacity: 60,
    refillPerSec: 60 / 60,
  };
  const mutationLimiter = rateLimit({
    ...mutationLimiterDefaults,
    keyFn: (req) => `planmutation:${req.userId ?? "anonymous"}`,
  });
  // Intentionally unused in WS7-4-A — consumers land in WS7-4-C / D.
  // Reference once to silence the noUnusedLocals lint:
  void mutationLimiter;

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

  // ── WS7-3 A2: composite plan reads ────────────────────────────────────

  // GET /plans?filter=my_plans,featured,top_rated,hosting_events
  // Multi-select OR over the four Plan Discovery facets. Returns the union
  // (cursor-paginated) plus the user's current This-Week plan summary.
  router.get("/plans", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const parsed = parseFilterParam(req.query.filter, PLAN_FILTER_KEYS, [
      "my_plans",
    ]);
    if ("unknownValues" in parsed) {
      return res.status(400).json({
        error: "invalid filter value(s)",
        unknown: parsed.unknownValues,
        allowed: PLAN_FILTER_KEYS,
      });
    }
    const limit = clampLimit(req.query.limit);
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.length > 0
        ? req.query.cursor
        : undefined;
    const now = new Date();

    try {
      const blocks: PlanListItem[][] = [];
      for (const key of parsed.keys) {
        blocks.push(
          await resolvePlansForFilter(
            prisma,
            key,
            userId,
            now,
            PLAN_FETCH_CAP,
          ),
        );
      }
      const merged = mergeById(blocks);
      const { page, nextCursor } = paginateById(merged, cursor, limit);

      // activeThisWeek — the pinned This-Week callout the Plans tab consumes
      // (PRD §9.2.1), folded in so the tab fetches one endpoint.
      const activeRow = await prisma.mealPlanInstance.findFirst({
        where: { userId, isActiveThisWeek: true },
        include: INSTANCE_TEMPLATE_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      const activeThisWeek = activeRow
        ? instanceToSummary(activeRow as unknown as InstanceRow)
        : null;

      return res.json({ plans: page, activeThisWeek, nextCursor });
    } catch (err) {
      logger.error({ err, userId }, "GET /plans failed");
      return res.status(500).json({ error: "failed to list plans" });
    }
  });

  // GET /plans/:id — composite Plan Review payload: instance meta + every
  // item with its full Meal expansion + a fresh macroDailyAverage rollup.
  router.get("/plans/:id", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 100) {
      return res.status(400).json({ error: "invalid plan id" });
    }

    try {
      const instance = await prisma.mealPlanInstance.findUnique({
        where: { id },
        include: {
          template: {
            select: {
              title: true,
              description: true,
              imageUrl: true,
              tags: true,
              sourceType: true,
            },
          },
          items: { orderBy: { positionIndex: "asc" } },
        },
      });

      // MealPlanInstance has no isPublic concept — instances are personal, so
      // a non-owner read is a 404 (no existence leak).
      if (!instance || instance.userId !== userId) {
        return res.status(404).json({ error: "plan not found" });
      }

      const items: (PlanReviewItem & {
        id: string;
        mealId: string;
        positionIndex: number;
        servingsOverride: number | null;
        isBreakfast: boolean;
        isLunch: boolean;
        isDinner: boolean;
        notes: string | null;
      })[] = [];
      for (const item of instance.items) {
        const meal = await composeMealDetail(prisma, item.mealId);
        items.push({
          id: item.id,
          mealId: item.mealId,
          positionIndex: item.positionIndex,
          assignedDayOfWeek: item.assignedDayOfWeek,
          assignedDate: item.assignedDate
            ? item.assignedDate.toISOString()
            : null,
          servingsOverride: item.servingsOverride,
          isBreakfast: item.isBreakfast,
          isLunch: item.isLunch,
          isDinner: item.isDinner,
          notes: item.notes,
          meal,
        });
      }

      return res.json({
        plan: {
          id: instance.id,
          name: instance.titleOverride ?? instance.template.title,
          status: instance.status,
          startDate: instance.startDate
            ? instance.startDate.toISOString()
            : null,
          endDate: instance.endDate ? instance.endDate.toISOString() : null,
          revisionId: instance.revisionId,
          isActiveThisWeek: instance.isActiveThisWeek,
          userId: instance.userId,
          // sourceType lives on the template, not the instance.
          sourceType: instance.template.sourceType,
          prepStatus: instance.prepStatus,
          optimizationNotes: instance.optimizationNotes ?? [],
          breakfastOverrides: instance.breakfastOverrides ?? "",
          lunchOverrides: instance.lunchOverrides ?? "",
          items,
          macroDailyAverage: computeMacroDailyAverage(items),
        },
      });
    } catch (err) {
      logger.error({ err, userId, id }, "GET /plans/:id failed");
      return res.status(500).json({ error: "failed to fetch plan" });
    }
  });

  // WS7-4-B c3 — GET /plans/templates/:id — public Template detail for the
  // Use Plan preview overlay. Any authenticated user can read isPublic
  // Templates; owner can also read their own non-public Templates. Non-public
  // + non-owner → 404 (no existence leak, mirror GET /plans/:id pattern).
  router.get("/plans/templates/:id", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 100) {
      return res.status(400).json({ error: "invalid template id" });
    }

    try {
      const template = await prisma.mealPlanTemplate.findUnique({
        where: { id },
        include: { items: { orderBy: { positionIndex: "asc" } } },
      });

      if (!template || (!template.isPublic && template.userId !== userId)) {
        return res.status(404).json({ error: "template not found" });
      }

      const items: {
        id: string;
        mealId: string;
        positionIndex: number;
        assignedDayOfWeek: string | null;
        isBreakfast: boolean;
        isLunch: boolean;
        isDinner: boolean;
        meal: MealDetail | null;
      }[] = [];
      for (const item of template.items) {
        const meal = await composeMealDetail(prisma, item.mealId);
        items.push({
          id: item.id,
          mealId: item.mealId,
          positionIndex: item.positionIndex,
          assignedDayOfWeek: item.assignedDayOfWeek,
          isBreakfast: item.isBreakfast,
          isLunch: item.isLunch,
          isDinner: item.isDinner,
          meal,
        });
      }

      return res.json({
        template: {
          id: template.id,
          userId: template.userId,
          title: template.title,
          description: template.description,
          image: template.imageUrl,
          tags: template.tags,
          sourceType: template.sourceType,
          defaultDaysCount: template.defaultDaysCount,
          optimizationNotes: template.optimizationNotes ?? [],
          items,
        },
      });
    } catch (err) {
      logger.error({ err, userId, id }, "GET /plans/templates/:id failed");
      return res.status(500).json({ error: "failed to fetch template" });
    }
  });

  return router;
}

const router = createPlansRouter();
export default router;
