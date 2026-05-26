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
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { logger } from "../lib/logger";
import {
  computePlanMacros as productionComputePlanMacros,
  PlanMacrosForbiddenError,
  PlanMacrosNotFoundError,
  planNeedsMacroEstimation as productionPlanNeedsMacroEstimation,
} from "../lib/planMacros";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/auth";
import { emitActivity } from "../lib/userActivity";
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
  planNeedsMacroEstimation: typeof productionPlanNeedsMacroEstimation;
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
  const planNeedsMacroEstimation =
    deps.planNeedsMacroEstimation ?? productionPlanNeedsMacroEstimation;
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
  // too tight. First consumer (WS7-4-B c4): POST /plans/use-template/:id.
  const mutationLimiterDefaults = deps.mutationLimiterOpts ?? {
    capacity: 60,
    refillPerSec: 60 / 60,
  };
  const mutationLimiter = rateLimit({
    ...mutationLimiterDefaults,
    keyFn: (req) => `planmutation:${req.userId ?? "anonymous"}`,
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
          name: instance.titleOverride ?? instance.template?.title ?? "",
          status: instance.status,
          startDate: instance.startDate
            ? instance.startDate.toISOString()
            : null,
          endDate: instance.endDate ? instance.endDate.toISOString() : null,
          revisionId: instance.revisionId,
          isActiveThisWeek: instance.isActiveThisWeek,
          userId: instance.userId,
          // sourceType lives on the template, not the instance.
          sourceType: instance.template?.sourceType ?? "manual",
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
      // WS7-4-C c0: wrap findUnique + plan_preview_opened emission in a single
      // transaction. Emission fires AFTER the 404 gate and ONLY for non-owners
      // (PRD §9.7 "for non-owned plans" — owners viewing their own template
      // emit nothing).
      const template = await prisma.$transaction(async (tx) => {
        const t = await tx.mealPlanTemplate.findUnique({
          where: { id },
          include: { items: { orderBy: { positionIndex: "asc" } } },
        });
        if (!t || (!t.isPublic && t.userId !== userId)) {
          return null;
        }
        if (t.userId !== userId) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_preview_opened",
            entityType: "MealPlanTemplate",
            entityId: id,
            metadata: { isPublic: t.isPublic },
          });
        }
        return t;
      });

      if (!template) {
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

  // WS7-4-C c2 — POST /plans — create a new empty MealPlanInstance for
  // the requester. No template; Q-P1-1 (a) ruling lets mealPlanTemplateId
  // be null. Same-transaction work:
  //   1) (if body isActiveThisWeek === true) demote prior actives for user;
  //   2) create the Instance with the body fields applied;
  //   3) emit plan_created activity (existing enum value at schema.prisma:141).
  // Fresh Instance starts at revisionId=1 from schema default.
  const PostPlansBody = z
    .object({
      name: z.string().min(1).max(120).optional(),
      startDate: z.string().datetime().nullable().optional(),
      endDate: z.string().datetime().nullable().optional(),
      isActiveThisWeek: z.boolean().optional(),
    })
    .strict();

  router.post("/plans", requireAuth, mutationLimiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    const parsed = PostPlansBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid body", details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const activate = body.isActiveThisWeek === true;

    try {
      const result = await prisma.$transaction(async (tx) => {
        if (activate) {
          await tx.mealPlanInstance.updateMany({
            where: { userId, isActiveThisWeek: true },
            data: { isActiveThisWeek: false },
          });
        }

        const instance = await tx.mealPlanInstance.create({
          data: {
            userId,
            mealPlanTemplateId: null,
            titleOverride: body.name ?? null,
            status: "draft",
            isActiveThisWeek: activate,
            startDate: body.startDate ? new Date(body.startDate) : null,
            endDate: body.endDate ? new Date(body.endDate) : null,
            optimizationNotes: Prisma.DbNull,
            breakfastOverrides: null,
            lunchOverrides: null,
          },
        });

        await emitActivity({
          tx,
          userId,
          eventType: "plan_created",
          entityType: "MealPlanInstance",
          entityId: instance.id,
          metadata: { isActiveThisWeek: instance.isActiveThisWeek },
        });

        return instance;
      });

      return res.status(201).json({
        instance: { id: result.id, revisionId: result.revisionId },
      });
    } catch (err) {
      logger.error({ err, userId }, "POST /plans failed");
      return res.status(500).json({ error: "failed to create plan" });
    }
  });

  // WS7-4-C c3 — DELETE /plans/:id — soft-delete (compost) the plan.
  // Q-P1-5 (a) ruling: deleting an active plan auto-clears
  // isActiveThisWeek in the same statement. The row stays; status flips
  // to "past", compostedAt is set, isArchived is true, revisionId bumps.
  router.delete(
    "/plans/:id",
    requireAuth,
    mutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const id = req.params.id;
      if (typeof id !== "string" || id.length === 0 || id.length > 100) {
        return res.status(400).json({ error: "invalid plan id" });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const row = await tx.mealPlanInstance.findUnique({
            where: { id },
            select: { userId: true, revisionId: true, isActiveThisWeek: true },
          });
          if (!row || row.userId !== userId) {
            return { kind: "not_found" as const };
          }

          const updated = await tx.mealPlanInstance.update({
            where: { id },
            data: {
              status: "past",
              compostedAt: new Date(),
              isArchived: true,
              isActiveThisWeek: false,
              revisionId: { increment: 1 },
            },
            select: { id: true, revisionId: true },
          });

          await emitActivity({
            tx,
            userId,
            eventType: "plan_composted",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: { wasActive: row.isActiveThisWeek },
          });

          return { kind: "deleted" as const, instance: updated };
        });

        if (result.kind === "not_found") {
          return res.status(404).json({ error: "plan not found" });
        }
        return res.json({
          instance: { id: result.instance.id, revisionId: result.instance.revisionId },
        });
      } catch (err) {
        logger.error({ err, userId, id }, "DELETE /plans/:id failed");
        return res.status(500).json({ error: "failed to delete plan" });
      }
    },
  );

  // WS7-4-C c4 — PATCH /plans/:id — multi-field plan edit. Single endpoint
  // serves all of: name rename, date range, status, isActiveThisWeek,
  // breakfast/lunch overrides, prepStatus, optimizationNotes. Per-field
  // activity emissions (per Q-P0-2 mapping) fire only when a field
  // actually changed. Ruling 8 carve-out: a name-only edit skips the
  // revisionId bump (rename is metadata, not plan-content).
  //
  // Q-P1-6 ruling: PATCH isActiveThisWeek=true on a draft plan does NOT
  // touch status -- the two axes are orthogonal.
  //
  // Q-P1-7: PlanStatus enum read from schema at authoring time.
  const PatchPlanBody = z
    .object({
      name: z.string().min(1).max(120).optional(),
      startDate: z.string().datetime().nullable().optional(),
      endDate: z.string().datetime().nullable().optional(),
      status: z.enum(["draft", "this_week", "next_week", "upcoming", "past"]).optional(),
      isActiveThisWeek: z.boolean().optional(),
      breakfastOverrides: z.string().nullable().optional(),
      lunchOverrides: z.string().nullable().optional(),
      prepStatus: z.enum(["not_prepped", "partial", "prepped"]).optional(),
      optimizationNotes: z.unknown().optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, "empty patch");

  // Forward-only prepStatus transitions for emission gating (Phase 1 §2 c4).
  const PREP_RANK: Record<string, number> = {
    not_prepped: 0,
    partial: 1,
    prepped: 2,
  };
  const isForwardPrepTransition = (from: string, to: string): boolean =>
    (PREP_RANK[to] ?? -1) > (PREP_RANK[from] ?? -1);

  // Body-supplied ISO -> Date | null normalizer (Zod accepts string|null).
  const toNullableDate = (v: string | null | undefined): Date | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return new Date(v);
  };

  const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

  router.patch("/plans/:id", requireAuth, mutationLimiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const id = req.params.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 100) {
      return res.status(400).json({ error: "invalid plan id" });
    }

    const parsed = PatchPlanBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid body", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const row = await tx.mealPlanInstance.findUnique({
          where: { id },
          select: {
            userId: true,
            titleOverride: true,
            startDate: true,
            endDate: true,
            status: true,
            isActiveThisWeek: true,
            breakfastOverrides: true,
            lunchOverrides: true,
            prepStatus: true,
            revisionId: true,
          },
        });
        if (!row || row.userId !== userId) {
          return { kind: "not_found" as const };
        }

        // Diff body against current state; only fields that actually
        // changed go into changedFields. Used both for emission gating
        // and the Ruling 8 name-only revisionBump carve-out.
        const changedFields = new Set<string>();
        const data: Record<string, unknown> = {};

        if (body.name !== undefined && body.name !== row.titleOverride) {
          changedFields.add("name");
          data.titleOverride = body.name;
        }
        const nextStartDate = toNullableDate(body.startDate);
        if (
          nextStartDate !== undefined &&
          isoOrNull(nextStartDate) !== isoOrNull(row.startDate)
        ) {
          changedFields.add("startDate");
          data.startDate = nextStartDate;
        }
        const nextEndDate = toNullableDate(body.endDate);
        if (
          nextEndDate !== undefined &&
          isoOrNull(nextEndDate) !== isoOrNull(row.endDate)
        ) {
          changedFields.add("endDate");
          data.endDate = nextEndDate;
        }
        if (body.status !== undefined && body.status !== row.status) {
          changedFields.add("status");
          data.status = body.status;
        }
        if (
          body.isActiveThisWeek !== undefined &&
          body.isActiveThisWeek !== row.isActiveThisWeek
        ) {
          changedFields.add("isActiveThisWeek");
          data.isActiveThisWeek = body.isActiveThisWeek;
        }
        if (
          body.breakfastOverrides !== undefined &&
          body.breakfastOverrides !== row.breakfastOverrides
        ) {
          changedFields.add("breakfastOverrides");
          data.breakfastOverrides = body.breakfastOverrides;
        }
        if (
          body.lunchOverrides !== undefined &&
          body.lunchOverrides !== row.lunchOverrides
        ) {
          changedFields.add("lunchOverrides");
          data.lunchOverrides = body.lunchOverrides;
        }
        if (body.prepStatus !== undefined && body.prepStatus !== row.prepStatus) {
          changedFields.add("prepStatus");
          data.prepStatus = body.prepStatus;
        }
        if (body.optimizationNotes !== undefined) {
          changedFields.add("optimizationNotes");
          data.optimizationNotes =
            (body.optimizationNotes as Prisma.InputJsonValue | null) ??
            Prisma.DbNull;
        }

        // Nothing actually changed -- return current row as if it had.
        if (changedFields.size === 0) {
          return { kind: "noop" as const, row };
        }

        // Ruling 8 name-only carve-out: skip revisionBump iff the only
        // changed field is name.
        const isNameOnly =
          changedFields.size === 1 && changedFields.has("name");
        if (!isNameOnly) {
          data.revisionId = { increment: 1 };
        }

        // isActiveThisWeek false -> true: demote prior actives first
        // (same-tx invariant; mirrors POST /plans/use-template).
        if (
          changedFields.has("isActiveThisWeek") &&
          body.isActiveThisWeek === true
        ) {
          await tx.mealPlanInstance.updateMany({
            where: { userId, isActiveThisWeek: true, id: { not: id } },
            data: { isActiveThisWeek: false },
          });
        }

        const updated = await tx.mealPlanInstance.update({
          where: { id },
          data,
          select: { id: true, revisionId: true },
        });

        // Per-field activity emissions (Q-P0-2 mapping).
        if (changedFields.has("name")) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_name_edited",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: { from: row.titleOverride, to: body.name },
          });
        }
        if (changedFields.has("startDate") || changedFields.has("endDate")) {
          const fields: string[] = [];
          if (changedFields.has("startDate")) fields.push("startDate");
          if (changedFields.has("endDate")) fields.push("endDate");
          await emitActivity({
            tx,
            userId,
            eventType: "plan_date_range_edited",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: {
              fields,
              from: {
                startDate: isoOrNull(row.startDate),
                endDate: isoOrNull(row.endDate),
              },
              to: {
                startDate: changedFields.has("startDate")
                  ? isoOrNull(nextStartDate ?? null)
                  : isoOrNull(row.startDate),
                endDate: changedFields.has("endDate")
                  ? isoOrNull(nextEndDate ?? null)
                  : isoOrNull(row.endDate),
              },
            },
          });
        }
        if (changedFields.has("status")) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_status_changed",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: { from: row.status, to: body.status },
          });
        }
        if (
          changedFields.has("isActiveThisWeek") &&
          body.isActiveThisWeek === true
        ) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_activated_this_week",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: {},
          });
        }
        if (changedFields.has("breakfastOverrides")) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_breakfast_customized",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: {
              from: row.breakfastOverrides,
              to: body.breakfastOverrides,
            },
          });
        }
        if (changedFields.has("lunchOverrides")) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_lunch_customized",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: { from: row.lunchOverrides, to: body.lunchOverrides },
          });
        }
        if (
          changedFields.has("prepStatus") &&
          body.prepStatus !== undefined &&
          isForwardPrepTransition(row.prepStatus, body.prepStatus)
        ) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_prep_started",
            entityType: "MealPlanInstance",
            entityId: id,
            metadata: { from: row.prepStatus, to: body.prepStatus },
          });
        }
        // optimizationNotes: NO event by design.

        const macrosStale = await planNeedsMacroEstimation({ tx, planId: id });

        return { kind: "updated" as const, instance: updated, macrosStale };
      });

      if (result.kind === "not_found") {
        return res.status(404).json({ error: "plan not found" });
      }
      if (result.kind === "noop") {
        // Body was valid but every field matched the current row. Return
        // the current state and macrosStale = false (no DB read needed
        // since no item set changed).
        return res.json({
          instance: { id, revisionId: result.row.revisionId },
          macrosStale: false,
        });
      }
      return res.json({
        instance: { id: result.instance.id, revisionId: result.instance.revisionId },
        macrosStale: result.macrosStale,
      });
    } catch (err) {
      logger.error({ err, userId, id }, "PATCH /plans/:id failed");
      return res.status(500).json({ error: "failed to update plan" });
    }
  });

  // WS7-4-B c4 — POST /plans/use-template/:templateId — copy a public (or
  // owner's private) Template into a new MealPlanInstance for the requester.
  // Body is empty. Same-transaction work:
  //   1) demote any existing isActiveThisWeek instances for this user
  //      (Q-P1-4 ruling — preserves the "exactly one active" invariant);
  //   2) create the new Instance with isActiveThisWeek: true and
  //      optimizationNotes copied from the Template (Ruling 3);
  //   3) createMany MealPlanItems mirroring the Template's items;
  //   4) increment Template.useCount + bump lastUsedAt;
  //   5) emit plan_used_from_browse activity via emitActivity({ tx, ... }).
  // Fresh Instance starts at revisionId=1 from schema default
  // (Phase 1 Finding 1+8 — do NOT call bumpPlanRevision).
  router.post(
    "/plans/use-template/:templateId",
    requireAuth,
    mutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const templateId = req.params.templateId;
      if (
        typeof templateId !== "string" ||
        templateId.length === 0 ||
        templateId.length > 100
      ) {
        return res.status(400).json({ error: "invalid template id" });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const template = await tx.mealPlanTemplate.findUnique({
            where: { id: templateId },
            include: { items: { orderBy: { positionIndex: "asc" } } },
          });
          if (!template) {
            return { kind: "not_found" as const };
          }
          if (!template.isPublic && template.userId !== userId) {
            return { kind: "not_found" as const };
          }

          // Q-P1-4 ruling — demote any existing actives for this user before
          // creating a new active Instance.
          await tx.mealPlanInstance.updateMany({
            where: { userId, isActiveThisWeek: true },
            data: { isActiveThisWeek: false },
          });

          const instance = await tx.mealPlanInstance.create({
            data: {
              userId,
              mealPlanTemplateId: templateId,
              titleOverride: null,
              status: "draft",
              isActiveThisWeek: true,
              startDate: null,
              endDate: null,
              optimizationNotes:
                (template.optimizationNotes as Prisma.InputJsonValue | null) ??
                Prisma.DbNull,
              breakfastOverrides: null,
              lunchOverrides: null,
            },
          });

          if (template.items.length > 0) {
            await tx.mealPlanItem.createMany({
              data: template.items.map((it) => ({
                mealPlanInstanceId: instance.id,
                mealId: it.mealId,
                positionIndex: it.positionIndex,
                assignedDayOfWeek: it.assignedDayOfWeek,
                isBreakfast: it.isBreakfast,
                isLunch: it.isLunch,
                isDinner: it.isDinner,
              })),
            });
          }

          await tx.mealPlanTemplate.update({
            where: { id: templateId },
            data: {
              useCount: { increment: 1 },
              lastUsedAt: new Date(),
            },
          });

          await emitActivity({
            tx,
            userId,
            eventType: "plan_used_from_browse",
            entityType: "MealPlanInstance",
            entityId: instance.id,
            metadata: { templateId, itemCount: template.items.length },
          });

          return { kind: "created" as const, instance };
        });

        if (result.kind === "not_found") {
          return res.status(404).json({ error: "template not found" });
        }
        return res.status(201).json({
          instance: {
            id: result.instance.id,
            revisionId: result.instance.revisionId,
          },
        });
      } catch (err) {
        logger.error(
          { err, userId, templateId },
          "POST /plans/use-template/:templateId failed",
        );
        return res.status(500).json({ error: "failed to use template" });
      }
    },
  );

  return router;
}

const router = createPlansRouter();
export default router;
