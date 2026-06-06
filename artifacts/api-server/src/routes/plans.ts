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
import {
  createMealWithDishes,
  IngredientResolutionError,
} from "../lib/mealCreate";
import { bumpPlanRevision } from "../lib/planRevision";
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
  toYmd,
  type InstanceRow,
  type PlanListItem,
} from "../lib/planQueries";
import {
  currentWeekRange,
  didNewlyCoverNow,
  isInstanceActiveThisWeek,
  resolveThisWeekWinnerId,
} from "../lib/planDates";
import { sortPlanItemsCanonical } from "../lib/planItemSort";
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

// WS7-5b-mobile FIX — defensive coerce on optimizationNotes.
// Pre-fix wizard plans persisted the raw WizardExpandedPlan JSON object into
// MealPlanInstance.optimizationNotes instead of the PRD §8.3.4 [{type,text}]
// shape that mobile PlanSchema expects. Those rows live in the DB
// unmigrated; this safe-parse heals them on read so Plan Review stops
// failing the mobile Zod parse with "Couldn't load this plan." Keeping the
// coerce in place is cheap and forward-safe against future shape drift.
const OPTIMIZATION_NOTE_SHAPE = z.array(
  z.object({
    type: z.enum(["prep", "cost"]),
    text: z.string(),
  }),
);
function coerceOptimizationNotes(
  raw: unknown,
): Array<{ type: "prep" | "cost"; text: string }> {
  if (raw == null) return [];
  const parsed = OPTIMIZATION_NOTE_SHAPE.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// macroDailyAverage — fresh per request. MealPlanInstance has no
// lastMacroCalcRevisionId column, so the WS7-3 A2 §1.8 cache path does not
// exist; this is a plain arithmetic rollup of each item meal's per-serving
// macros divided by the number of distinct assigned days. See WS7-3 A2
// Phase 3 report §8 (F-A2-4).
//
// WS7-6 Fix-Block 2 (D, closes D-WS7-060). Hans's ruling for PRD §8.3.5:
// per-day average = sum of ASSIGNED meals ÷ count of ASSIGNED days. Both
// numerator and denominator gate on the SAME per-item assignment check
// (`assignedDate ?? assignedDayOfWeek`). Pre-fix divisor switched to
// assigned-day count while the numerator summed ALL items unconditionally
// — N items + 1 assigned → per-day = sum-of-all (user read it as "macros
// stopped calculating"). Empty state (no items assigned) → null per
// field; UI renders "—". PRD §8.3.5 redline queued for WS7-CLOSE.
function computeMacroDailyAverage(items: PlanReviewItem[]): {
  caloriesPerDay: number | null;
  proteinGPerDay: number | null;
  carbsGPerDay: number | null;
  fatGPerDay: number | null;
} {
  let cal = 0;
  let pro = 0;
  let carb = 0;
  let fat = 0;
  const days = new Set<string>();
  for (const it of items) {
    const dayKey = it.assignedDate ?? it.assignedDayOfWeek;
    if (!dayKey) continue;
    days.add(dayKey);
    if (it.meal) {
      cal += it.meal.calories;
      pro += it.meal.protein;
      carb += it.meal.carbs;
      fat += it.meal.fat;
    }
  }
  if (days.size === 0) {
    return {
      caloriesPerDay: null,
      proteinGPerDay: null,
      carbsGPerDay: null,
      fatGPerDay: null,
    };
  }
  const dayCount = days.size;
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
      // WS7-6 (E) Block 1 REWORK — compute the resolver winnerId ONCE per
      // request. Threaded into resolvePlansForFilter so the my_plans
      // projection derives isActiveThisWeek by id-compare against this
      // pre-resolved id (no per-row secondary read; no per-filter
      // recompute even when the multi-select filter list has several
      // keys). Template-only filters ignore the id (templates are never
      // "this week").
      const winnerId = await resolveThisWeekWinnerId(prisma, userId, now);

      const blocks: PlanListItem[][] = [];
      for (const key of parsed.keys) {
        blocks.push(
          await resolvePlansForFilter(
            prisma,
            key,
            userId,
            now,
            PLAN_FETCH_CAP,
            winnerId,
          ),
        );
      }
      const merged = mergeById(blocks);
      const { page, nextCursor } = paginateById(merged, cursor, limit);

      // activeThisWeek — the pinned This-Week callout the Plans tab consumes
      // (PRD §9.2.1). WS7-6 (E) Block 1 REWORK: "active" is the resolver
      // winner under Model 2 — newest activatedAt among covering rows
      // (nulls last → newest createdAt). winnerId resolved above; one
      // findUnique hydrates the summary fields. Null winnerId → null
      // callout (no plan covers now).
      const activeRow = winnerId
        ? await prisma.mealPlanInstance.findUnique({
            where: { id: winnerId },
            include: INSTANCE_TEMPLATE_INCLUDE,
          })
        : null;
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

      // WS7-6 (E) Block 1 REWORK — resolve "is THIS plan the user's This
      // Week winner?" against the user's covering subset, not the row in
      // isolation. The single-row predicate can't tell whether another
      // covering plan with a fresher activatedAt exists for the same
      // user. resolveThisWeekWinnerId issues ONE narrow indexed findMany
      // selecting {id, startDate, endDate, activatedAt, createdAt} — not
      // full hydration.
      const winnerId = await resolveThisWeekWinnerId(prisma, userId);

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
      // WS7-4-D c15 — apply the server-canonical Sun→Sat sort. The Prisma
      // include above still uses positionIndex ASC so the stable sort below
      // has a predictable starting order; this comparator then reorders by
      // day with unscheduled items pinned at the bottom.
      const sortedItems = sortPlanItemsCanonical(items);

      return res.json({
        plan: {
          id: instance.id,
          name: instance.titleOverride ?? instance.template?.title ?? "",
          status: instance.status,
          // WS7-4-D c16 — user-facing plan dates cross the wire as YYYY-MM-DD,
          // symmetric with the write shape mobile emits via PlanDateRangeEditor
          // (see toYmd JSDoc in lib/planQueries.ts).
          startDate: toYmd(instance.startDate),
          endDate: toYmd(instance.endDate),
          revisionId: instance.revisionId,
          isActiveThisWeek: winnerId !== null && winnerId === instance.id,
          userId: instance.userId,
          // sourceType lives on the template, not the instance.
          sourceType: instance.template?.sourceType ?? "manual",
          prepStatus: instance.prepStatus,
          optimizationNotes: coerceOptimizationNotes(instance.optimizationNotes),
          breakfastOverrides: instance.breakfastOverrides ?? "",
          lunchOverrides: instance.lunchOverrides ?? "",
          items: sortedItems,
          macroDailyAverage: computeMacroDailyAverage(sortedItems),
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
      // WS7-4-D c15 — same Sun→Sat canonical sort applies to templates.
      // Templates carry assignedDayOfWeek (the slot's intended day) so the
      // preview overlay's ordering matches what the user will see in Plan
      // Review after Use Plan.
      const sortedItems = sortPlanItemsCanonical(items);

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
          items: sortedItems,
        },
      });
    } catch (err) {
      logger.error({ err, userId, id }, "GET /plans/templates/:id failed");
      return res.status(500).json({ error: "failed to fetch template" });
    }
  });

  // WS7-4-C c2 — POST /plans — create a new empty MealPlanInstance for
  // the requester. No template; Q-P1-1 (a) ruling lets mealPlanTemplateId
  // be null. WS7-6 (E): the stored isActiveThisWeek column is gone —
  // "active" is now derived from [startDate, endDate]. The body field is
  // accepted for backwards compat with mobile clients still emitting it
  // (decision #2 — the wire shape stays a boolean while mobile transitions
  // in Block 2) but is treated as advisory: it is NOT stored, and only
  // triggers a currentWeekRange() auto-date when the body otherwise has
  // no dates. The DB-side EXCLUDE constraint enforces "at most one
  // current plan per user" — no app-level demote-prior is needed.
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

    // Backwards-compat auto-date: if the client said "active" without
    // supplying dates, fill currentWeekRange() so the plan actually
    // becomes current under the date-range predicate. Body-supplied dates
    // always win.
    let createStartDate: Date | null = body.startDate ? new Date(body.startDate) : null;
    let createEndDate: Date | null = body.endDate ? new Date(body.endDate) : null;
    if (
      body.isActiveThisWeek === true
      && body.startDate === undefined
      && body.endDate === undefined
    ) {
      const week = currentWeekRange();
      createStartDate = new Date(week.startDate);
      createEndDate = new Date(week.endDate);
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const instance = await tx.mealPlanInstance.create({
          data: {
            userId,
            mealPlanTemplateId: null,
            titleOverride: body.name ?? null,
            status: "draft",
            startDate: createStartDate,
            endDate: createEndDate,
            optimizationNotes: Prisma.DbNull,
            breakfastOverrides: null,
            lunchOverrides: null,
          },
        });

        const isActiveThisWeek = isInstanceActiveThisWeek(instance);
        await emitActivity({
          tx,
          userId,
          eventType: "plan_created",
          entityType: "MealPlanInstance",
          entityId: instance.id,
          metadata: { isActiveThisWeek },
        });

        // WS7-6 (E) Block 1 c2 — re-pointed plan_activated_this_week.
        // Fires on the not-current → current transition; for create the
        // prior state is the absence of a row (treated as not-current),
        // so a create with dates that cover `now` emits the event.
        if (didNewlyCoverNow({ startDate: null, endDate: null }, instance)) {
          await emitActivity({
            tx,
            userId,
            eventType: "plan_activated_this_week",
            entityType: "MealPlanInstance",
            entityId: instance.id,
            metadata: { source: "plans_create" },
          });
        }

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
  // Q-P1-5 (a) ruling: deleting an active plan automatically removes it
  // from the current-week surface. WS7-6 (E) — "active" is now derived
  // from [startDate, endDate], so the activity-event "wasActive" flag is
  // computed at delete time from the row's dates; the row itself stays
  // (status flips to "past", compostedAt set, isArchived true, revisionId
  // bumps).
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
            select: {
              userId: true,
              revisionId: true,
              startDate: true,
              endDate: true,
            },
          });
          if (!row || row.userId !== userId) {
            return { kind: "not_found" as const };
          }

          const wasActive = isInstanceActiveThisWeek(row);

          const updated = await tx.mealPlanInstance.update({
            where: { id },
            data: {
              status: "past",
              compostedAt: new Date(),
              isArchived: true,
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
            metadata: { wasActive },
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
  // WS7-4-D c11 — accept either a full ISO 8601 datetime ("2026-06-03T00:00:00.000Z")
  // or a calendar-date string ("2026-06-03"). Mobile PlanDateRangeEditor emits
  // YYYY-MM-DD using local-time formatting to avoid TZ-shift bugs (one day off
  // in negative offsets); the server stores DateTime? at UTC midnight either
  // way (new Date("2026-06-03") and new Date("2026-06-03T00:00:00.000Z") both
  // produce the same UTC instant).
  const planDateString = z
    .string()
    .refine(
      (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)),
      "expected YYYY-MM-DD or ISO 8601 datetime",
    );
  const PatchPlanBody = z
    .object({
      name: z.string().min(1).max(120).optional(),
      startDate: planDateString.nullable().optional(),
      endDate: planDateString.nullable().optional(),
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
        let nextStartDate = toNullableDate(body.startDate);
        if (
          nextStartDate !== undefined &&
          isoOrNull(nextStartDate) !== isoOrNull(row.startDate)
        ) {
          changedFields.add("startDate");
          data.startDate = nextStartDate;
        }
        let nextEndDate = toNullableDate(body.endDate);
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
        // WS7-6 (E) — isActiveThisWeek is no longer stored. The body field
        // is still accepted (decision #2 — wire shape stays a boolean
        // while Block 2 mobile transitions); when set true on an undated
        // plan with no body dates, it triggers the currentWeekRange()
        // auto-date envelope below. Otherwise it is advisory and not
        // persisted directly.
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

        // WS7-5b-mobile-PRE — auto-date envelope. Fires when the PATCH
        // body says "active this week" AND the plan is currently undated
        // AND the body did NOT supply its own dates. Body dates always
        // win; already-dated plans are never overridden; non-active and
        // unrelated PATCHes are never touched. Uses the shared Sun-Sat
        // currentWeekRange() — same definition as draft-activate. WS7-6
        // (E): this is now the ONLY way the stored "this week" semantic
        // is materialized via the boolean body field — Block 2 mobile
        // will eventually send explicit dates instead.
        if (
          body.isActiveThisWeek === true &&
          row.startDate === null &&
          body.startDate === undefined &&
          body.endDate === undefined
        ) {
          const week = currentWeekRange();
          const autoStart = new Date(week.startDate);
          const autoEnd = new Date(week.endDate);
          data.startDate = autoStart;
          data.endDate = autoEnd;
          changedFields.add("startDate");
          changedFields.add("endDate");
          nextStartDate = autoStart;
          nextEndDate = autoEnd;
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
        // WS7-6 (E) Block 1 c2 — re-pointed plan_activated_this_week.
        // Emit when this PATCH's date changes cause the plan to NEWLY
        // cover `now` (transition from not-current to current). Replaces
        // the legacy flag-flip trigger that died with the column drop.
        // Same-state writes do not emit. Wizard activate, use-template,
        // and other paths share the same predicate via didNewlyCoverNow.
        if (
          changedFields.has("startDate") ||
          changedFields.has("endDate")
        ) {
          const prevDates = {
            startDate: row.startDate,
            endDate: row.endDate,
          };
          const nextDates = {
            startDate: changedFields.has("startDate")
              ? (nextStartDate ?? null)
              : row.startDate,
            endDate: changedFields.has("endDate")
              ? (nextEndDate ?? null)
              : row.endDate,
          };
          if (didNewlyCoverNow(prevDates, nextDates)) {
            await emitActivity({
              tx,
              userId,
              eventType: "plan_activated_this_week",
              entityType: "MealPlanInstance",
              entityId: id,
              metadata: { source: "plans_patch" },
            });
          }
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
  //   1) create the new Instance with null dates (undated — user picks the
  //      week later via PATCH /plans/:id) and optimizationNotes copied from
  //      the Template (Ruling 3);
  //   2) createMany MealPlanItems mirroring the Template's items;
  //   3) increment Template.useCount + bump lastUsedAt;
  //   4) emit plan_used_from_browse activity via emitActivity({ tx, ... }).
  // WS7-6 (E): use-template no longer auto-activates the new plan. The
  // stored isActiveThisWeek column is gone; "active" is the date-range
  // predicate, and an undated plan is never current. The per-user
  // EXCLUDE constraint on [startDate, endDate] is null-exempt, so this
  // undated row will never collide with the user's existing this-week
  // plan. Mobile drives the activation explicitly via PATCH (post-WS7-6
  // mobile sends dates; pre-WS7-6 mobile sends { isActiveThisWeek: true }
  // and the PATCH auto-date envelope materializes the dates). Fresh
  // Instance starts at revisionId=1 from schema default (Phase 1 Finding
  // 1+8 — do NOT call bumpPlanRevision).
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

          // WS7-6 (E): no demote-prior — the stored isActiveThisWeek column
          // is gone. The new row is created undated; mobile dates it via a
          // follow-up PATCH /plans/:id, and the per-user EXCLUDE constraint
          // enforces single-current at that point.
          const instance = await tx.mealPlanInstance.create({
            data: {
              userId,
              mealPlanTemplateId: templateId,
              titleOverride: null,
              status: "draft",
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

  // WS7-4-D c1 — POST /plans/:id/items — add a meal to a plan.
  // Q-P0-5 ruling: body uses `slot: "breakfast"|"lunch"|"dinner"` (default
  // "dinner"); server maps to the 3 booleans on write. Q-P1-5 (a) ruling:
  // response carries the composed `item` (MealDetail-shaped) so future
  // skip-refetch UX work is free.
  const PostPlanItemBody = z
    .object({
      mealId: z.string().min(1).max(100),
      slot: z.enum(["breakfast", "lunch", "dinner"]).optional(),
      assignedDayOfWeek: z.string().nullable().optional(),
      servingsOverride: z.number().int().positive().nullable().optional(),
    })
    .strict();

  router.post(
    "/plans/:id/items",
    requireAuth,
    mutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const planId = req.params.id;
      if (
        typeof planId !== "string" ||
        planId.length === 0 ||
        planId.length > 100
      ) {
        return res.status(400).json({ error: "invalid plan id" });
      }

      const parsed = PostPlanItemBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid body", details: parsed.error.flatten() });
      }
      const body = parsed.data;
      const slot = body.slot ?? "dinner";

      try {
        const result = await prisma.$transaction(async (tx) => {
          const plan = await tx.mealPlanInstance.findUnique({
            where: { id: planId },
            select: { userId: true },
          });
          if (!plan || plan.userId !== userId) {
            return { kind: "not_found_plan" as const };
          }

          const meal = await tx.meal.findUnique({
            where: { id: body.mealId },
            select: { userId: true, isPublic: true, isArchived: true },
          });
          if (!meal || meal.isArchived) {
            return { kind: "not_found_meal" as const };
          }
          if (!meal.isPublic && meal.userId !== userId) {
            return { kind: "not_found_meal" as const };
          }

          // positionIndex = max(existing) + 1; 0 for empty plans.
          const agg = await tx.mealPlanItem.aggregate({
            where: { mealPlanInstanceId: planId },
            _max: { positionIndex: true },
          });
          const nextPosition =
            agg._max.positionIndex == null ? 0 : agg._max.positionIndex + 1;

          const created = await tx.mealPlanItem.create({
            data: {
              mealPlanInstanceId: planId,
              mealId: body.mealId,
              positionIndex: nextPosition,
              assignedDayOfWeek: body.assignedDayOfWeek ?? null,
              servingsOverride: body.servingsOverride ?? null,
              isBreakfast: slot === "breakfast",
              isLunch: slot === "lunch",
              isDinner: slot === "dinner",
            },
            select: {
              id: true,
              mealId: true,
              positionIndex: true,
              assignedDayOfWeek: true,
              assignedDate: true,
              servingsOverride: true,
              isBreakfast: true,
              isLunch: true,
              isDinner: true,
              notes: true,
            },
          });

          const revisionId = await bumpPlanRevision(planId, tx);

          await emitActivity({
            tx,
            userId,
            eventType: "plan_meal_added",
            entityType: "MealPlanItem",
            entityId: created.id,
            metadata: {
              mealId: body.mealId,
              assignedDayOfWeek: created.assignedDayOfWeek,
              slot,
            },
          });

          const macrosStale = await planNeedsMacroEstimation({
            tx,
            planId,
          });

          return {
            kind: "created" as const,
            item: created,
            revisionId,
            macrosStale,
          };
        });

        if (result.kind === "not_found_plan") {
          return res.status(404).json({ error: "plan not found" });
        }
        if (result.kind === "not_found_meal") {
          return res.status(404).json({ error: "meal not found" });
        }

        const composedMeal = await composeMealDetail(prisma, result.item.mealId);
        return res.status(201).json({
          item: {
            id: result.item.id,
            mealId: result.item.mealId,
            positionIndex: result.item.positionIndex,
            assignedDayOfWeek: result.item.assignedDayOfWeek,
            assignedDate: result.item.assignedDate
              ? result.item.assignedDate.toISOString()
              : null,
            servingsOverride: result.item.servingsOverride,
            isBreakfast: result.item.isBreakfast,
            isLunch: result.item.isLunch,
            isDinner: result.item.isDinner,
            notes: result.item.notes,
            meal: composedMeal,
          },
          planId,
          revisionId: result.revisionId,
          macrosStale: result.macrosStale,
        });
      } catch (err) {
        logger.error(
          { err, userId, planId },
          "POST /plans/:id/items failed",
        );
        return res.status(500).json({ error: "failed to add item" });
      }
    },
  );

  // WS7-4-D c3 — RecipeOverride Zod transcription (mirror of mobile
  // RecipeOverride in artifacts/kiwi/lib/types.ts:209-229). Defined here at
  // module-scope inside createPlansRouter so c3 + c4 (promote-override) share.
  // R5 (Phase 1 risk register): keep this in sync with the mobile type.
  const RecipeOverrideSchema = z
    .object({
      titleOverride: z.string().optional(),
      dishes: z.array(
        z
          .object({
            name: z.string().min(1),
            ingredients: z.array(
              z
                .object({
                  name: z.string().min(1),
                  quantity: z.number(),
                  unit: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
      steps: z.array(z.string()).optional(),
      createdAt: z.string().datetime(),
    })
    .strict();

  // WS7-4-D c2 — DELETE /plans/:id/items/:itemId — hard-delete an item.
  // Q-P0-2 (alpha) ruling: hard delete v1; analytics carried via the
  // plan_meal_composted activity row (Q-P0-7) with mealId+itemId metadata.
  router.delete(
    "/plans/:id/items/:itemId",
    requireAuth,
    mutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const planId = req.params.id;
      if (
        typeof planId !== "string" ||
        planId.length === 0 ||
        planId.length > 100
      ) {
        return res.status(400).json({ error: "invalid plan id" });
      }
      const itemId = req.params.itemId;
      if (
        typeof itemId !== "string" ||
        itemId.length === 0 ||
        itemId.length > 100
      ) {
        return res.status(400).json({ error: "invalid item id" });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const plan = await tx.mealPlanInstance.findUnique({
            where: { id: planId },
            select: { userId: true },
          });
          if (!plan || plan.userId !== userId) {
            return { kind: "not_found_plan" as const };
          }

          const item = await tx.mealPlanItem.findUnique({
            where: { id: itemId },
            select: {
              mealPlanInstanceId: true,
              mealId: true,
              assignedDayOfWeek: true,
              isBreakfast: true,
              isLunch: true,
              isDinner: true,
            },
          });
          if (!item || item.mealPlanInstanceId !== planId) {
            return { kind: "not_found_item" as const };
          }

          const slot = item.isBreakfast
            ? "breakfast"
            : item.isLunch
              ? "lunch"
              : "dinner";

          await tx.mealPlanItem.delete({ where: { id: itemId } });

          const revisionId = await bumpPlanRevision(planId, tx);

          await emitActivity({
            tx,
            userId,
            eventType: "plan_meal_composted",
            entityType: "MealPlanItem",
            entityId: itemId,
            metadata: {
              mealId: item.mealId,
              itemId,
              assignedDayOfWeek: item.assignedDayOfWeek,
              slot,
            },
          });

          const macrosStale = await planNeedsMacroEstimation({
            tx,
            planId,
          });

          return { kind: "deleted" as const, revisionId, macrosStale };
        });

        if (result.kind === "not_found_plan") {
          return res.status(404).json({ error: "plan not found" });
        }
        if (result.kind === "not_found_item") {
          return res.status(404).json({ error: "item not found" });
        }

        return res.json({
          planId,
          revisionId: result.revisionId,
          macrosStale: result.macrosStale,
        });
      } catch (err) {
        logger.error(
          { err, userId, planId, itemId },
          "DELETE /plans/:id/items/:itemId failed",
        );
        return res.status(500).json({ error: "failed to delete item" });
      }
    },
  );

  // WS7-4-D c3 — PATCH /plans/:id/items/:itemId — multi-field item edit.
  // Per-field activity emission per Q-P0-6 mapping. Q-P0-3 (alpha) atomic
  // mealId-swap: when body is { mealId } alone, internally DELETE + POST
  // preserving day/slot/notes/position (Q-P1-4) and resetting per-meal
  // fields (servingsOverride, ingredientOverrides, recipeOverrideJson,
  // lastCooked, timesCooked). Q-P1-4 v1 enforcement: mealId in body
  // excludes all other fields (Zod refine -> 400). Q-P1-1: ingredientOverrides
  // is z.unknown() pass-through.
  const PatchPlanItemBody = z
    .object({
      mealId: z.string().min(1).max(100).optional(),
      assignedDayOfWeek: z.string().nullable().optional(),
      slot: z.enum(["breakfast", "lunch", "dinner"]).optional(),
      servingsOverride: z.number().int().positive().nullable().optional(),
      ingredientOverrides: z.unknown().optional(),
      recipeOverrideJson: RecipeOverrideSchema.nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, "empty patch")
    .refine(
      (b) =>
        b.mealId === undefined ||
        Object.keys(b).filter((k) => k !== "mealId").length === 0,
      "mealId change must not be combined with other fields",
    );

  router.patch(
    "/plans/:id/items/:itemId",
    requireAuth,
    mutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const planId = req.params.id;
      if (
        typeof planId !== "string" ||
        planId.length === 0 ||
        planId.length > 100
      ) {
        return res.status(400).json({ error: "invalid plan id" });
      }
      const itemId = req.params.itemId;
      if (
        typeof itemId !== "string" ||
        itemId.length === 0 ||
        itemId.length > 100
      ) {
        return res.status(400).json({ error: "invalid item id" });
      }

      const parsed = PatchPlanItemBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "invalid body", details: parsed.error.flatten() });
      }
      const body = parsed.data;

      const currentSlot = (i: {
        isBreakfast: boolean;
        isLunch: boolean;
        isDinner: boolean;
      }): "breakfast" | "lunch" | "dinner" =>
        i.isBreakfast ? "breakfast" : i.isLunch ? "lunch" : "dinner";

      try {
        const result = await prisma.$transaction(async (tx) => {
          const plan = await tx.mealPlanInstance.findUnique({
            where: { id: planId },
            select: { userId: true },
          });
          if (!plan || plan.userId !== userId) {
            return { kind: "not_found_plan" as const };
          }

          const current = await tx.mealPlanItem.findUnique({
            where: { id: itemId },
            select: {
              mealPlanInstanceId: true,
              mealId: true,
              positionIndex: true,
              assignedDayOfWeek: true,
              assignedDate: true,
              servingsOverride: true,
              ingredientOverrides: true,
              recipeOverrideJson: true,
              isBreakfast: true,
              isLunch: true,
              isDinner: true,
              notes: true,
            },
          });
          if (!current || current.mealPlanInstanceId !== planId) {
            return { kind: "not_found_item" as const };
          }

          // ── Atomic mealId-swap path (Q-P0-3 + Q-P1-4) ─────────────────
          if (body.mealId !== undefined) {
            const newMeal = await tx.meal.findUnique({
              where: { id: body.mealId },
              select: { userId: true, isPublic: true, isArchived: true },
            });
            if (!newMeal || newMeal.isArchived) {
              return { kind: "not_found_meal" as const };
            }
            if (!newMeal.isPublic && newMeal.userId !== userId) {
              return { kind: "not_found_meal" as const };
            }

            if (body.mealId === current.mealId) {
              // No-op same-mealId swap. Mirror the standard noop branch:
              // return current state, no bump, no activity.
              return {
                kind: "noop" as const,
                item: current,
                itemId,
              };
            }

            const oldMealId = current.mealId;
            const oldItemId = itemId;

            // CRITICAL: validate newMeal BEFORE deleting old item (R3).
            await tx.mealPlanItem.delete({ where: { id: itemId } });
            const created = await tx.mealPlanItem.create({
              data: {
                mealPlanInstanceId: planId,
                mealId: body.mealId,
                positionIndex: current.positionIndex,
                assignedDayOfWeek: current.assignedDayOfWeek,
                assignedDate: current.assignedDate,
                servingsOverride: null, // Q-P1-4: reset
                ingredientOverrides: Prisma.DbNull, // Q-P1-4: reset
                recipeOverrideJson: Prisma.DbNull, // Q-P1-4: reset
                notes: current.notes, // Q-P1-4: preserve
                isBreakfast: current.isBreakfast,
                isLunch: current.isLunch,
                isDinner: current.isDinner,
                // lastCooked/timesCooked default to null/0 from schema.
              },
              select: {
                id: true,
                mealId: true,
                positionIndex: true,
                assignedDayOfWeek: true,
                assignedDate: true,
                servingsOverride: true,
                ingredientOverrides: true,
                recipeOverrideJson: true,
                isBreakfast: true,
                isLunch: true,
                isDinner: true,
                notes: true,
              },
            });

            const revisionId = await bumpPlanRevision(planId, tx);

            await emitActivity({
              tx,
              userId,
              eventType: "plan_meal_changed",
              entityType: "MealPlanItem",
              entityId: created.id,
              metadata: {
                oldItemId,
                newItemId: created.id,
                oldMealId,
                newMealId: body.mealId,
                dayPreserved: current.assignedDayOfWeek,
              },
            });

            const macrosStale = await planNeedsMacroEstimation({
              tx,
              planId,
            });

            return {
              kind: "mealId_swap" as const,
              item: created,
              revisionId,
              macrosStale,
            };
          }

          // ── Non-mealId path: diff body vs current, per-field emit ─────
          const changedFields = new Set<string>();
          const data: Record<string, unknown> = {};
          let slotFromTo: { from: string; to: string } | null = null;
          let dayFromTo: { from: string | null; to: string | null } | null = null;
          let servingsFromTo: { from: number | null; to: number | null } | null = null;

          if (
            body.assignedDayOfWeek !== undefined &&
            body.assignedDayOfWeek !== current.assignedDayOfWeek
          ) {
            changedFields.add("assignedDayOfWeek");
            data.assignedDayOfWeek = body.assignedDayOfWeek;
            dayFromTo = {
              from: current.assignedDayOfWeek,
              to: body.assignedDayOfWeek,
            };
          }

          if (body.slot !== undefined) {
            const curSlot = currentSlot(current);
            if (body.slot !== curSlot) {
              changedFields.add("slot");
              data.isBreakfast = body.slot === "breakfast";
              data.isLunch = body.slot === "lunch";
              data.isDinner = body.slot === "dinner";
              slotFromTo = { from: curSlot, to: body.slot };
            }
          }

          if (
            body.servingsOverride !== undefined &&
            body.servingsOverride !== current.servingsOverride
          ) {
            changedFields.add("servingsOverride");
            data.servingsOverride = body.servingsOverride;
            servingsFromTo = {
              from: current.servingsOverride,
              to: body.servingsOverride,
            };
          }

          if (body.ingredientOverrides !== undefined) {
            // Q-P1-1: z.unknown() pass-through; no shape diff (treat any
            // present value as a change). Caller pings PATCH again if they
            // want a clear/replace cycle.
            changedFields.add("ingredientOverrides");
            data.ingredientOverrides =
              (body.ingredientOverrides as Prisma.InputJsonValue | null) ??
              Prisma.DbNull;
          }

          if (body.recipeOverrideJson !== undefined) {
            const wasNull = current.recipeOverrideJson == null;
            const willBeNull = body.recipeOverrideJson === null;
            // Treat any explicit set as a change (parsed JSON deep-compare is
            // overkill for v1; same as ingredientOverrides).
            const same = wasNull && willBeNull;
            if (!same) {
              changedFields.add("recipeOverrideJson");
              data.recipeOverrideJson =
                body.recipeOverrideJson === null
                  ? Prisma.DbNull
                  : (body.recipeOverrideJson as Prisma.InputJsonValue);
            }
          }

          if (body.notes !== undefined && body.notes !== current.notes) {
            changedFields.add("notes");
            data.notes = body.notes;
          }

          // Noop branch — mirror WS7-4-C c4 J6: return current, no bump,
          // no activity, macrosStale: false.
          if (changedFields.size === 0) {
            return {
              kind: "noop" as const,
              item: current,
              itemId,
            };
          }

          const updated = await tx.mealPlanItem.update({
            where: { id: itemId },
            data,
            select: {
              id: true,
              mealId: true,
              positionIndex: true,
              assignedDayOfWeek: true,
              assignedDate: true,
              servingsOverride: true,
              ingredientOverrides: true,
              recipeOverrideJson: true,
              isBreakfast: true,
              isLunch: true,
              isDinner: true,
              notes: true,
            },
          });

          const revisionId = await bumpPlanRevision(planId, tx);

          // Per-field activity emissions per Q-P0-6 (verbatim).
          if (changedFields.has("assignedDayOfWeek") && dayFromTo) {
            if (dayFromTo.from === null && dayFromTo.to !== null) {
              await emitActivity({
                tx,
                userId,
                eventType: "plan_meal_assigned",
                entityType: "MealPlanItem",
                entityId: itemId,
                metadata: { day: dayFromTo.to },
              });
            } else if (dayFromTo.from !== null && dayFromTo.to === null) {
              await emitActivity({
                tx,
                userId,
                eventType: "plan_meal_unassigned",
                entityType: "MealPlanItem",
                entityId: itemId,
                metadata: { from: dayFromTo.from },
              });
            } else {
              await emitActivity({
                tx,
                userId,
                eventType: "plan_meal_assigned",
                entityType: "MealPlanItem",
                entityId: itemId,
                metadata: { from: dayFromTo.from, to: dayFromTo.to },
              });
            }
          }
          if (changedFields.has("slot") && slotFromTo) {
            await emitActivity({
              tx,
              userId,
              eventType: "plan_meal_edited",
              entityType: "MealPlanItem",
              entityId: itemId,
              metadata: {
                field: "slot",
                from: slotFromTo.from,
                to: slotFromTo.to,
              },
            });
          }
          if (changedFields.has("servingsOverride") && servingsFromTo) {
            await emitActivity({
              tx,
              userId,
              eventType: "plan_meal_edited",
              entityType: "MealPlanItem",
              entityId: itemId,
              metadata: {
                field: "servingsOverride",
                from: servingsFromTo.from,
                to: servingsFromTo.to,
              },
            });
          }
          if (changedFields.has("ingredientOverrides")) {
            // Q-P0-6: value omitted (JSON may be large).
            await emitActivity({
              tx,
              userId,
              eventType: "plan_meal_edited",
              entityType: "MealPlanItem",
              entityId: itemId,
              metadata: { field: "ingredientOverrides" },
            });
          }
          if (changedFields.has("recipeOverrideJson")) {
            const cleared = body.recipeOverrideJson === null;
            await emitActivity({
              tx,
              userId,
              eventType: "plan_recipe_changed",
              entityType: "MealPlanItem",
              entityId: itemId,
              metadata: { cleared },
            });
          }
          // notes intentionally emits no activity (PRD §8.5 has no event for
          // free-form notes, matches optimizationNotes precedent in PATCH /plans).

          const macrosStale = await planNeedsMacroEstimation({
            tx,
            planId,
          });

          return {
            kind: "updated" as const,
            item: updated,
            revisionId,
            macrosStale,
          };
        });

        if (result.kind === "not_found_plan") {
          return res.status(404).json({ error: "plan not found" });
        }
        if (result.kind === "not_found_item") {
          return res.status(404).json({ error: "item not found" });
        }
        if (result.kind === "not_found_meal") {
          return res.status(404).json({ error: "meal not found" });
        }

        // Noop or success — compose item for response (Q-P1-5 rich envelope).
        const composedMeal = await composeMealDetail(prisma, result.item.mealId);
        const itemPayload = {
          id: "id" in result.item ? result.item.id : result.itemId,
          mealId: result.item.mealId,
          positionIndex: result.item.positionIndex,
          assignedDayOfWeek: result.item.assignedDayOfWeek,
          assignedDate: result.item.assignedDate
            ? result.item.assignedDate.toISOString()
            : null,
          servingsOverride: result.item.servingsOverride,
          isBreakfast: result.item.isBreakfast,
          isLunch: result.item.isLunch,
          isDinner: result.item.isDinner,
          notes: result.item.notes,
          meal: composedMeal,
        };

        if (result.kind === "noop") {
          // Return current state; revisionId echoed from a fresh read so the
          // client can confirm cache parity. Skip the extra read by re-using
          // a 0-bump update — but cheaper: do a select. For simplicity, do a
          // small revision read.
          const planRow = await prisma.mealPlanInstance.findUnique({
            where: { id: planId },
            select: { revisionId: true },
          });
          return res.json({
            item: itemPayload,
            planId,
            revisionId: planRow?.revisionId ?? 0,
            macrosStale: false,
          });
        }

        return res.json({
          item: itemPayload,
          planId,
          revisionId: result.revisionId,
          macrosStale: result.macrosStale,
        });
      } catch (err) {
        logger.error(
          { err, userId, planId, itemId },
          "PATCH /plans/:id/items/:itemId failed",
        );
        return res.status(500).json({ error: "failed to update item" });
      }
    },
  );

  // WS7-4-D c4 — POST /plans/:id/items/:itemId/promote-override —
  // materialize an item's recipeOverrideJson into a new Meal owned by the
  // requester, then rebind the item to it (clearing the override JSON).
  // Q-P1-2: strict ingredient resolution (422 on first unresolved name).
  // Q-P1-3: stepTextTranslated = stepTextRaw.
  // Q-P0-4: emit plan_recipe_changed with metadata.promoted = true.
  // Q-P1-5: response carries composed item + newMealId.
  router.post(
    "/plans/:id/items/:itemId/promote-override",
    requireAuth,
    mutationLimiter,
    async (req, res) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const planId = req.params.id;
      if (
        typeof planId !== "string" ||
        planId.length === 0 ||
        planId.length > 100
      ) {
        return res.status(400).json({ error: "invalid plan id" });
      }
      const itemId = req.params.itemId;
      if (
        typeof itemId !== "string" ||
        itemId.length === 0 ||
        itemId.length > 100
      ) {
        return res.status(400).json({ error: "invalid item id" });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const plan = await tx.mealPlanInstance.findUnique({
            where: { id: planId },
            select: { userId: true },
          });
          if (!plan || plan.userId !== userId) {
            return { kind: "not_found_plan" as const };
          }

          const item = await tx.mealPlanItem.findUnique({
            where: { id: itemId },
            select: {
              mealPlanInstanceId: true,
              mealId: true,
              recipeOverrideJson: true,
            },
          });
          if (!item || item.mealPlanInstanceId !== planId) {
            return { kind: "not_found_item" as const };
          }

          if (item.recipeOverrideJson == null) {
            return { kind: "no_override" as const };
          }

          // Parse the stored JSON through the same shape the route validates
          // on write (defense in depth — DB writes were Zod-checked but the
          // column is still untyped at the DB layer).
          const overrideParsed = RecipeOverrideSchema.safeParse(
            item.recipeOverrideJson,
          );
          if (!overrideParsed.success) {
            return {
              kind: "invalid_override" as const,
              details: overrideParsed.error.flatten(),
            };
          }

          let newMealId: string;
          try {
            const created = await createMealWithDishes(tx, {
              userId,
              sourceMealId: item.mealId,
              override: overrideParsed.data,
            });
            newMealId = created.mealId;
          } catch (err) {
            if (err instanceof IngredientResolutionError) {
              return {
                kind: "ingredient_unresolved" as const,
                ingredientName: err.ingredientName,
              };
            }
            throw err;
          }

          const updatedItem = await tx.mealPlanItem.update({
            where: { id: itemId },
            data: {
              mealId: newMealId,
              recipeOverrideJson: Prisma.DbNull,
            },
            select: {
              id: true,
              mealId: true,
              positionIndex: true,
              assignedDayOfWeek: true,
              assignedDate: true,
              servingsOverride: true,
              isBreakfast: true,
              isLunch: true,
              isDinner: true,
              notes: true,
            },
          });

          const revisionId = await bumpPlanRevision(planId, tx);

          await emitActivity({
            tx,
            userId,
            eventType: "plan_recipe_changed",
            entityType: "MealPlanItem",
            entityId: itemId,
            metadata: {
              promoted: true,
              newMealId,
              oldMealId: item.mealId,
            },
          });

          const macrosStale = await planNeedsMacroEstimation({
            tx,
            planId,
          });

          return {
            kind: "promoted" as const,
            item: updatedItem,
            newMealId,
            revisionId,
            macrosStale,
          };
        });

        if (result.kind === "not_found_plan") {
          return res.status(404).json({ error: "plan not found" });
        }
        if (result.kind === "not_found_item") {
          return res.status(404).json({ error: "item not found" });
        }
        if (result.kind === "no_override") {
          return res
            .status(422)
            .json({ error: "no_override", message: "item has no recipeOverrideJson to promote" });
        }
        if (result.kind === "invalid_override") {
          return res
            .status(422)
            .json({ error: "invalid_override", details: result.details });
        }
        if (result.kind === "ingredient_unresolved") {
          return res.status(422).json({
            error: "unresolved_ingredient",
            ingredientName: result.ingredientName,
          });
        }

        const composedMeal = await composeMealDetail(prisma, result.newMealId);
        return res.json({
          item: {
            id: result.item.id,
            mealId: result.item.mealId,
            positionIndex: result.item.positionIndex,
            assignedDayOfWeek: result.item.assignedDayOfWeek,
            assignedDate: result.item.assignedDate
              ? result.item.assignedDate.toISOString()
              : null,
            servingsOverride: result.item.servingsOverride,
            isBreakfast: result.item.isBreakfast,
            isLunch: result.item.isLunch,
            isDinner: result.item.isDinner,
            notes: result.item.notes,
            meal: composedMeal,
          },
          planId,
          revisionId: result.revisionId,
          macrosStale: result.macrosStale,
          newMealId: result.newMealId,
        });
      } catch (err) {
        logger.error(
          { err, userId, planId, itemId },
          "POST /plans/:id/items/:itemId/promote-override failed",
        );
        return res.status(500).json({ error: "failed to promote override" });
      }
    },
  );

  return router;
}

const router = createPlansRouter();
export default router;
