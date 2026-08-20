// GET /api/home — composite Home-tab payload (WS7-3 A2).
//
// Folds /plans/today + /plans/current (per WS7-3 §1.3 locked decision) into one
// read: today's meal, the active plan summary, and the first-plan stamp. Flat
// shape — NOT enveloped under a `home:` key.
//
// WS9-2 2c Commit 6 — the badged `planDiscoveryCards` block was removed; it was
// built on every request and read by nothing.
//
// Also serves GET /api/home/rail (WS9-2 2c, D-WS9-154).
//
// Auth: requireAuth (JWT). Same factory + DI pattern as meals.ts.

import { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { MEAL_LIST_SELECT, toListShape } from "./meals";
import { resolveRailPlans, toYmd } from "../lib/planQueries";
import { resolveThisWeekWinnerId } from "../lib/planDates";

export interface HomeRouterDeps {
  prisma: PrismaClient;
}

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

// Find the plan item assigned to today, BY WEEKDAY NAME.
//
// BUG-114 — this used to try `assignedDate` (same calendar day) first and only
// fall back to `assignedDayOfWeek`. Nothing writes assignedDate: two
// differently-shaped searches found 27 occurrences in src/, every one a select,
// a projection, a type or a read. The single `data:` appearance copies
// `current.assignedDate` forward during a mealId swap, and PatchPlanItemBody /
// PostPlanItemBody do not accept the field — so a client can neither set it nor
// clear it. Measured 9 of 371 items non-null (2.4259%), all of them seed rows,
// all agreeing with their assignedDayOfWeek, so removing the branch changes
// nothing today. What it removes is the trap: a day-change PATCH moves
// assignedDayOfWeek and leaves the stale assignedDate winning here forever,
// unfixably from the client.
//
// It was also wrong on its own terms. The stored values are UTC midnight but
// startOfDay() truncates in LOCAL time, so on any server west of UTC
// `startOfDay(2026-07-13T00:00:00Z)` is July 12 local and the branch matched
// the wrong day.
//
// The column and every projection STAY — dropping a column is a migration and
// a separate ruling. This only stops reading it.
//
// Returns the item + a dayOffset measured from the plan start (or derived from
// the weekday when there is no startDate). null when nothing is assigned today.
function resolveTodaysItem(
  items: PlanItemLite[],
  startDate: Date | null,
  now: Date,
): { item: PlanItemLite; dayOffset: number } | null {
  const today = startOfDay(now);
  const todayName = DAY_NAMES[now.getDay()];

  let match: PlanItemLite | null = null;
  for (const item of items) {
    if (item.assignedDayOfWeek === todayName) {
      match = item;
      break;
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

      // WS9-2 2c Commit 6 — `planDiscoveryCards` REMOVED. It was built on every
      // /home request and parsed by the mobile Zod schema, and NOTHING on the
      // client ever read it: useHomePayload has exactly one consumer, and that
      // screen reads only todaysMeal, activePlan and firstPlanCreatedAt.
      //
      // Removing it also deletes the filter-resolution block that fed it — the
      // savedFilters narrowing, the default-by-plan-count branch, and with it
      // ONE `mealPlanInstance.count()` per Home load.
      //
      // ⚠️ Consequence for `user.lastPlanDiscoveryFilters`: /home no longer
      // reads it. The column is NOT dropped and is NOT orphaned — GET /plans
      // still persists and reads it for the Plans-tab chip selection. Its
      // meaning simply narrows from "the filters Home AND Plans remember" to
      // "the filters the Plans tab remembers", which is the only place a user
      // can actually set them. (The Plans tab additionally has its own
      // `lastPlansFilters`; reconciling the two is not 2c's.)
      const user = await prisma.user.findUnique({
        where: { id: userId },
        // D-WS9-026 — firstPlanCreatedAt drives the Home teaching-arc collapse
        // (null → first-run, show the arc; non-null → collapsed forever).
        select: { firstPlanCreatedAt: true },
      });

      return res.json({
        todaysMeal,
        activePlan,
        // D-WS9-026 — ISO timestamp (full precision preserves the
        // time-to-first-plan metric); client only needs null-vs-not.
        firstPlanCreatedAt: user?.firstPlanCreatedAt?.toISOString() ?? null,
      });
    } catch (err) {
      logger.error({ err, userId }, "GET /home failed");
      return res.status(500).json({ error: "failed to load home" });
    }
  });

  // GET /api/home/rail — the Home "Featured plans" rail (WS9-2 2c, D-WS9-154).
  //
  // A dedicated read rather than a fifth PLAN_FILTER_KEY: that constant is a
  // wire contract shared with GET /plans, mirrored on mobile, rendered as the
  // Plans-tab filter chips, and PERSISTED per user in lastPlanDiscoveryFilters.
  // Adding "rail" to it would leak a Home-only concept into all four of those.
  //
  // Also NOT folded into GET /home: the rail is public catalog content with no
  // per-user component, so it caches independently of the user's own payload
  // and does not need to be re-fetched when their plan state changes.
  //
  // Auth-gated for consistency with the rest of the surface — the content is
  // public, but every other Home read requires a session and an unauthenticated
  // client has no Home to render it on.
  router.get("/home/rail", requireAuth, async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    try {
      const plans = await resolveRailPlans(prisma);
      return res.json({ plans });
    } catch (err) {
      logger.error({ err, userId: req.userId }, "GET /home/rail failed");
      return res.status(500).json({ error: "failed to load rail" });
    }
  });

  return router;
}

// Default export — production wiring with real deps.
const router = createHomeRouter();
export default router;
