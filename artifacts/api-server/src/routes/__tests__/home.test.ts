// WS7-3 A2 — GET /home composite-payload tests.
//
// Covers active-plan resolution, today's-meal resolution, and the discovery-
// card filter resolution (saved filters vs the saved-plan-count default).
//
// node:test + real signed JWT + prisma stubbed at the factory deps boundary.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createHomeRouter } from "../home";

const USER_ID = "test-user-home";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

// ── fixtures ───────────────────────────────────────────────────────────

function mealSelectRow(id: string, title: string) {
  return {
    id,
    title,
    cuisineType: "American",
    estimatedTimeMinutes: 35,
    servingsDefault: 4,
    caloriesPerServing: 600,
    proteinGPerServing: 35,
    carbsGPerServing: 45,
    fatGPerServing: 25,
    tags: ["dinner"],
    imageUrl: null as string | null,
  };
}

function planItem(
  id: string,
  positionIndex: number,
  mealId: string,
  mealTitle: string,
  assignedDate: Date | null,
  assignedDayOfWeek: string | null,
) {
  return {
    id,
    positionIndex,
    assignedDate,
    assignedDayOfWeek,
    meal: mealSelectRow(mealId, mealTitle),
  };
}

function activeInstanceRow(opts: {
  startDate: Date | null;
  items: ReturnType<typeof planItem>[];
  activatedAt?: Date | null;
}) {
  return {
    id: "plan-active",
    titleOverride: "My Active Week",
    status: "this_week",
    startDate: opts.startDate,
    endDate: opts.startDate
      ? new Date(opts.startDate.getTime() + 6 * MS_PER_DAY)
      : null,
    // WS7-6 (E) Block 1 REWORK — resolver tiebreak fields. activatedAt
    // default null exercises the auto-roll path (sole covering plan with
    // null activatedAt still wins).
    activatedAt: opts.activatedAt ?? null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    isWizardDraft: false,
    revisionId: 3,
    template: { title: "Weeknight Dinners" },
    items: opts.items,
  };
}

// A MealPlanInstance row in the GET /home discovery (my_plans) shape.
function discoveryInstance(id: string, name: string) {
  return {
    id,
    titleOverride: name,
    status: "upcoming",
    startDate: null as Date | null,
    endDate: null as Date | null,
    isActiveThisWeek: false,
    revisionId: 1,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    template: {
      title: name,
      description: "desc",
      imageUrl: null as string | null,
      tags: ["dev"],
    },
  };
}

// A public MealPlanTemplate row in the discovery shape.
function discoveryTemplate(id: string, title: string) {
  return {
    id,
    title,
    description: "a public plan",
    imageUrl: null as string | null,
    tags: ["featured"],
  };
}

const TOP_RATED_SETTINGS = [
  { key: "top_rated.save_weight", value: 1 },
  { key: "top_rated.use_weight", value: 2 },
  { key: "top_rated.decay_half_life_days", value: 30 },
  { key: "top_rated.refresh_interval_hours", value: 6 },
  { key: "top_rated.display_count", value: 20 },
];

// ── prisma stub ────────────────────────────────────────────────────────

interface StubOpts {
  activeInstance?: ReturnType<typeof activeInstanceRow> | null;
  lastPlanDiscoveryFilters?: string[];
  savedPlanCount?: number;
  myPlans?: ReturnType<typeof discoveryInstance>[];
  featured?: ReturnType<typeof discoveryTemplate>[];
  hosting?: ReturnType<typeof discoveryTemplate>[];
  topRated?: ReturnType<typeof discoveryTemplate>[];
  // WS9 3a — R4 active-plan grocery-list pointer + D-WS9-026 first-plan stamp.
  existingGroceryListId?: string | null;
  firstPlanCreatedAt?: Date | null;
}

function makeStubPrisma(opts: StubOpts) {
  return {
    mealPlanInstance: {
      // WS7-6 (E) Block 1 REWORK — R6 active plan is the resolver winner.
      // findUnique hydrates by winnerId; the narrow findMany below feeds
      // resolveThisWeekWinnerId.
      findUnique: async (args: { where: { id: string } }) => {
        if (
          opts.activeInstance &&
          opts.activeInstance.id === args.where.id
        ) {
          return opts.activeInstance;
        }
        return null;
      },
      count: async () => opts.savedPlanCount ?? 0,
      findMany: async (args: {
        where: {
          userId?: string;
          isWizardDraft?: boolean;
          isArchived?: boolean;
          startDate?: { lte: Date; not?: null };
          endDate?: { gte: Date; not?: null };
        };
        select?: { activatedAt?: boolean };
      }) => {
        // Narrow covering-subset query for resolveThisWeekWinnerId: the
        // SELECT carries activatedAt. Return the active instance only if
        // its dates actually cover `now` (mirrors the real Prisma
        // semantics: WHERE startDate.lte ≤ now ≤ endDate.gte).
        if (args.select?.activatedAt && opts.activeInstance) {
          const inst = opts.activeInstance;
          if (inst.startDate === null || inst.endDate === null) return [];
          if (args.where.startDate?.lte) {
            if (inst.startDate.getTime() > args.where.startDate.lte.getTime()) return [];
          }
          if (args.where.endDate?.gte) {
            if (inst.endDate.getTime() < args.where.endDate.gte.getTime()) return [];
          }
          if (args.where.isWizardDraft !== undefined && inst.isWizardDraft !== args.where.isWizardDraft) {
            return [];
          }
          return [
            {
              id: inst.id,
              startDate: inst.startDate,
              endDate: inst.endDate,
              activatedAt: inst.activatedAt,
              createdAt: inst.createdAt,
            },
          ];
        }
        // Default branch — my_plans discovery list (full hydration).
        return opts.myPlans ?? [];
      },
    },
    mealPlanTemplate: {
      findMany: async (args: {
        where?: { isFeatured?: boolean; isHostingFeatured?: boolean };
      }) => {
        if (args.where?.isFeatured === true) return opts.featured ?? [];
        if (args.where?.isHostingFeatured === true) return opts.hosting ?? [];
        return opts.topRated ?? [];
      },
    },
    groceryList: {
      // WS9 3a / R4 — the active plan's non-archived list (null when none).
      findFirst: async () =>
        opts.existingGroceryListId
          ? { id: opts.existingGroceryListId }
          : null,
    },
    user: {
      findUnique: async () => ({
        lastPlanDiscoveryFilters: opts.lastPlanDiscoveryFilters ?? [],
        firstPlanCreatedAt: opts.firstPlanCreatedAt ?? null,
      }),
    },
    systemSetting: {
      findMany: async (args: { where: { key: { in: string[] } } }) =>
        TOP_RATED_SETTINGS.filter((s) => args.where.key.in.includes(s.key)),
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createHomeRouter({ prisma: prisma as never }));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

function authGet(harness: Harness, path: string, withAuth = true) {
  return fetch(`${harness.baseUrl}${path}`, {
    headers: withAuth ? { Authorization: `Bearer ${signToken(USER_ID)}` } : {},
  });
}

// ── tests ──────────────────────────────────────────────────────────────

describe("GET /home", () => {
  it("resolves the active plan summary", async () => {
    const startDate = startOfDay(new Date(Date.now() - 2 * MS_PER_DAY));
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: activeInstanceRow({ startDate, items: [] }),
        savedPlanCount: 1,
        myPlans: [discoveryInstance("p-1", "Saved Plan")],
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        activePlan: Record<string, unknown> | null;
      };
      assert.ok(body.activePlan);
      assert.equal(body.activePlan.id, "plan-active");
      assert.equal(body.activePlan.name, "My Active Week");
      assert.equal(body.activePlan.status, "this_week");
      assert.equal(body.activePlan.revisionId, 3);
    } finally {
      await harness.close();
    }
  });

  it("WS9 3a — exposes the active plan's grocery list id (R4) and firstPlanCreatedAt (D-WS9-026)", async () => {
    const startDate = startOfDay(new Date(Date.now() - 2 * MS_PER_DAY));
    const stamp = new Date("2026-07-01T12:00:00.000Z");
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: activeInstanceRow({ startDate, items: [] }),
        savedPlanCount: 1,
        existingGroceryListId: "gl-42",
        firstPlanCreatedAt: stamp,
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        activePlan: { groceryListId: string | null } | null;
        firstPlanCreatedAt: string | null;
      };
      assert.ok(body.activePlan);
      assert.equal(body.activePlan.groceryListId, "gl-42");
      assert.equal(body.firstPlanCreatedAt, stamp.toISOString());
    } finally {
      await harness.close();
    }
  });

  it("WS9 3a — null grocery list + null firstPlanCreatedAt (first-run) pass through", async () => {
    const startDate = startOfDay(new Date(Date.now() - 2 * MS_PER_DAY));
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: activeInstanceRow({ startDate, items: [] }),
        savedPlanCount: 1,
        // existingGroceryListId + firstPlanCreatedAt default to null.
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      const body = (await res.json()) as {
        activePlan: { groceryListId: string | null } | null;
        firstPlanCreatedAt: string | null;
      };
      assert.ok(body.activePlan);
      assert.equal(body.activePlan.groceryListId, null);
      assert.equal(body.firstPlanCreatedAt, null);
    } finally {
      await harness.close();
    }
  });

  it("resolves today's meal by assignedDate and computes dayOffset from plan start", async () => {
    const today = startOfDay(new Date());
    const startDate = startOfDay(new Date(Date.now() - 2 * MS_PER_DAY));
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: activeInstanceRow({
          startDate,
          items: [
            planItem("item-yesterday", 0, "m-y", "Yesterday Meal",
              new Date(today.getTime() - MS_PER_DAY), null),
            planItem("item-today", 1, "m-t", "Today Meal", today, null),
          ],
        }),
        savedPlanCount: 1,
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      const body = (await res.json()) as {
        todaysMeal: Record<string, unknown> | null;
      };
      assert.ok(body.todaysMeal);
      assert.equal(body.todaysMeal.mealPlanItemId, "item-today");
      assert.equal(body.todaysMeal.dayOffset, 2); // today is start + 2 days
      assert.equal(body.todaysMeal.planId, "plan-active");
      const meal = body.todaysMeal.meal as { id: string; minutes: number };
      assert.equal(meal.id, "m-t");
      assert.equal(meal.minutes, 35); // renamed flat shape
    } finally {
      await harness.close();
    }
  });

  it("returns null todaysMeal + activePlan when there is no active plan", async () => {
    const harness = await spinUp(
      makeStubPrisma({ activeInstance: null, savedPlanCount: 0 }),
    );
    try {
      const res = await authGet(harness, "/home");
      const body = (await res.json()) as {
        todaysMeal: unknown;
        activePlan: unknown;
      };
      assert.equal(body.todaysMeal, null);
      assert.equal(body.activePlan, null);
    } finally {
      await harness.close();
    }
  });

  it("honors saved lastPlanDiscoveryFilters for the discovery cards", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: null,
        lastPlanDiscoveryFilters: ["featured", "top_rated"],
        featured: [discoveryTemplate("t-feat", "Featured Plan")],
        topRated: [discoveryTemplate("t-top", "Top Plan")],
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      const body = (await res.json()) as {
        planDiscoveryCards: { badge: string; plans: { id: string }[] }[];
      };
      assert.deepEqual(
        body.planDiscoveryCards.map((c) => c.badge),
        ["featured", "top_rated"],
      );
      assert.equal(body.planDiscoveryCards[0].plans[0].id, "t-feat");
      assert.equal(body.planDiscoveryCards[1].plans[0].id, "t-top");
    } finally {
      await harness.close();
    }
  });

  it("defaults discovery to my_plans when filters are unset and the user has saved plans", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: null,
        lastPlanDiscoveryFilters: [],
        savedPlanCount: 3,
        myPlans: [discoveryInstance("p-a", "Plan A")],
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      const body = (await res.json()) as {
        planDiscoveryCards: { badge: string; plans: { id: string }[] }[];
      };
      assert.equal(body.planDiscoveryCards.length, 1);
      assert.equal(body.planDiscoveryCards[0].badge, "my_plans");
      assert.equal(body.planDiscoveryCards[0].plans[0].id, "p-a");
    } finally {
      await harness.close();
    }
  });

  it("defaults discovery to featured when filters are unset and the user has no saved plans", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        activeInstance: null,
        lastPlanDiscoveryFilters: [],
        savedPlanCount: 0,
        featured: [discoveryTemplate("t-feat", "Featured Plan")],
      }),
    );
    try {
      const res = await authGet(harness, "/home");
      const body = (await res.json()) as {
        planDiscoveryCards: { badge: string }[];
      };
      assert.equal(body.planDiscoveryCards.length, 1);
      assert.equal(body.planDiscoveryCards[0].badge, "featured");
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await spinUp(makeStubPrisma({ activeInstance: null }));
    try {
      const res = await authGet(harness, "/home", false);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});
