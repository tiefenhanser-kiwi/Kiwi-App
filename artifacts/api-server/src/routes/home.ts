// GET /api/home — composite Home-tab payload (WS7-3 A2).
//
// Folds /plans/today + /plans/current (per WS7-3 §1.3 locked decision) into
// one read: today's meal, the active plan summary, and the badged plan
// discovery cards. Flat shape — NOT enveloped under a `home:` key.
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { MEAL_LIST_SELECT, toListShape } from "./meals";
import {
  PLAN_FILTER_KEYS,
  resolvePlansForFilter,
  toYmd,
  type PlanFilterKey,
} from "../lib/planQueries";
import { resolveThisWeekWinnerId } from "../lib/planDates";

export interface HomeRouterDeps {
  prisma: PrismaClient;
}

// Up to 5 plans per discovery card (WS7-3 §1.6 Q9 ruling).
const DISCOVERY_CARD_LIMIT = 5;

// Sunday-indexed (Date.getDay()) → day name, matching MealPlanItem.assignedDayOfWeek.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Monday-based offset (Mon=0 .. Sun=6) for a day name — used to derive
// dayOffset when the plan has no startDate to measure from.
const MONDAY_OFFSET: Record<string, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

interface PlanItemLite {
  id: string;
  assignedDayOfWeek: string | null;
  assignedDate: Date | null;
  meal: {
    id: string;
    title: string;
    // WS9 3f-4d Part 1c (D-WS9-123/124) — in MEAL_LIST_SELECT.
    displayTitle: string | null;
    description: string | null;
    cuisineType: string | null;
    estimatedTimeMinutes: number;
    servingsDefault: number;
    // WS7-8 BUG-003 — authored-servings anchor (in MEAL_LIST_SELECT).
    authoredServingsDefault: number | null;
    caloriesPerServing: number;
    proteinGPerServing: number;
    carbsGPerServing: number;
    fatGPerServing: number;
    tags: string[];
    imageUrl: string | null;
  };
}

// Find the plan item assigned to today: by assignedDate (same calendar day)
// first, else by assignedDayOfWeek name. Returns the item + a dayOffset
// measured from the plan start (or derived from the weekday when there is no
// startDate). null when nothing is assigned to today.
function resolveTodaysItem(
  items: PlanItemLite[],
  startDate: Date | null,
  now: Date,
): { item: PlanItemLite; dayOffset: number } | null {
  const today = startOfDay(now);
  const todayName = DAY_NAMES[now.getDay()];

  let match: PlanItemLite | null = null;
  for (const item of items) {
    if (item.assignedDate && startOfDay(item.assignedDate).getTime() === today.getTime()) {
      match = item;
      break;
    }
  }
  if (!match) {
    for (const item of items) {
      if (item.assignedDayOfWeek === todayName) {
        match = item;
        break;
      }
    }
  }
  if (!match) return null;

  let dayOffset: number;
  if (startDate) {
    dayOffset = Math.round(
      (today.getTime() - startOfDay(startDate).getTime()) / MS_PER_DAY,
    );
  } else {
    dayOffset = MONDAY_OFFSET[match.assignedDayOfWeek ?? ""] ?? 0;
  }
  return { item: match, dayOffset };
}

export function createHomeRouter(
  deps: Partial<HomeRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const router: IRouter = Router();

  router.get("/home", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const now = new Date();

    try {
      // ── active plan + today's meal ──────────────────────────────────
      // WS7-6 (E) Block 1 REWORK — Model 2: "active" is the resolver
      // winner — newest activatedAt among covering rows (nulls last →
      // newest createdAt). resolveThisWeekWinnerId runs ONE narrow
      // indexed findMany scoped to (userId, isWizardDraft:false,
      // covering-now) selecting only {id, startDate, endDate,
      // activatedAt, createdAt} — not full hydration. The winnerId is
      // reused below by the discovery-card loop so the my_plans
      // projection's isActiveThisWeek does not re-query.
      const winnerId = await resolveThisWeekWinnerId(prisma, userId, now);
      const activeInstance = winnerId
        ? await prisma.mealPlanInstance.findUnique({
            where: { id: winnerId },
            include: {
              template: { select: { title: true } },
              items: {
                orderBy: { positionIndex: "asc" },
                include: { meal: { select: MEAL_LIST_SELECT } },
              },
            },
          })
        : null;

      let todaysMeal: unknown = null;
      let activePlan: unknown = null;

      if (activeInstance) {
        const planName =
          activeInstance.titleOverride ?? activeInstance.template?.title ?? "";
        // WS9 3a / R4 — the active plan's non-archived grocery list (null when
        // none). Powers the Home "Grocery List" smart route: has-list → open ·
        // no-list → generate. Same predicate the generate route's 409 guard
        // uses (status != "archived", groceryLists.ts).
        const existingList = await prisma.groceryList.findFirst({
          where: {
            mealPlanInstanceId: activeInstance.id,
            status: { not: "archived" },
          },
          select: { id: true },
        });
        activePlan = {
          id: activeInstance.id,
          name: planName,
          status: activeInstance.status,
          // WS7-4-D c16 — user-facing plan dates cross the wire as YYYY-MM-DD
          // (see toYmd JSDoc in lib/planQueries.ts).
          startDate: toYmd(activeInstance.startDate),
          endDate: toYmd(activeInstance.endDate),
          revisionId: activeInstance.revisionId,
          groceryListId: existingList?.id ?? null,
        };

        const today = resolveTodaysItem(
          activeInstance.items,
          activeInstance.startDate,
          now,
        );
        if (today) {
          todaysMeal = {
            mealPlanItemId: today.item.id,
            dayOffset: today.dayOffset,
            planId: activeInstance.id,
            planName,
            meal: toListShape(today.item.meal),
          };
        }
      }

      // ── plan discovery cards ────────────────────────────────────────
      const user = await prisma.user.findUnique({
        where: { id: userId },
        // D-WS9-026 — firstPlanCreatedAt drives the Home teaching-arc collapse
        // (null → first-run, show the arc; non-null → collapsed forever).
        select: { lastPlanDiscoveryFilters: true, firstPlanCreatedAt: true },
      });
      const savedFilters = (user?.lastPlanDiscoveryFilters ?? []).filter(
        (k): k is PlanFilterKey =>
          (PLAN_FILTER_KEYS as readonly string[]).includes(k),
      );

      let filterKeys: PlanFilterKey[];
      if (savedFilters.length > 0) {
        filterKeys = savedFilters;
      } else {
        // Default by saved-plan count (WS7-3 §1.6 Q9 ruling).
        const savedPlanCount = await prisma.mealPlanInstance.count({
          where: { userId },
        });
        filterKeys = savedPlanCount > 0 ? ["my_plans"] : ["featured"];
      }

      const planDiscoveryCards = [];
      for (const key of filterKeys) {
        const plans = await resolvePlansForFilter(
          prisma,
          key,
          userId,
          now,
          DISCOVERY_CARD_LIMIT,
          winnerId,
        );
        planDiscoveryCards.push({ badge: key, plans });
      }

      return res.json({
        todaysMeal,
        activePlan,
        planDiscoveryCards,
        // D-WS9-026 — ISO timestamp (full precision preserves the
        // time-to-first-plan metric); client only needs null-vs-not.
        firstPlanCreatedAt: user?.firstPlanCreatedAt?.toISOString() ?? null,
      });
    } catch (err) {
      logger.error({ err, userId }, "GET /home failed");
      return res.status(500).json({ error: "failed to load home" });
    }
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createHomeRouter();
export default router;
