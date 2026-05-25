// WS6 6b-3 — POST /api/plans/:id/recalc-macros tests.
// Mirrors the meals.test.ts harness pattern — real Express + JWT, but
// computePlanMacros is stubbed at the deps boundary so the tests don't
// need a DB.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import {
  PlanMacrosForbiddenError,
  PlanMacrosNotFoundError,
  type PlanMacrosResult,
} from "../../lib/planMacros";
import { createPlansRouter } from "../plans";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(deps: Parameters<typeof createPlansRouter>[0]): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createPlansRouter(deps));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const TEST_USER_ID = "test-user-plans-route";

const HAPPY_RESULT: PlanMacrosResult = {
  dailyAverages: {
    caloriesPerDay: 538,
    proteinGPerDay: 27,
    carbsGPerDay: 51.8,
    fatGPerDay: 22.5,
  },
  perDay: [
    { day: "Monday", totals: { calories: 520, proteinG: 28, carbsG: 38, fatG: 26 }, mealCount: 1 },
    { day: "Tuesday", totals: { calories: 640, proteinG: 26, carbsG: 65, fatG: 28 }, mealCount: 1 },
  ],
  perMeal: [],
  computedAt: new Date().toISOString(),
  hasEstimatedMacros: true,
  estimationCaveats: [],
};

describe("POST /api/plans/:id/recalc-macros — happy path", () => {
  let harness: Harness;
  let calls = 0;
  let lastPlanId: string | null = null;

  before(async () => {
    harness = await spinUp({
      computePlanMacros: (async ({ planId }: { planId: string }) => {
        calls++;
        lastPlanId = planId;
        return HAPPY_RESULT;
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  it("returns 200 with the PlanMacrosResult body", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/plans/plan-abc/recalc-macros`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlanMacrosResult;
    assert.equal(body.dailyAverages.caloriesPerDay, 538);
    assert.equal(calls, 1);
    assert.equal(lastPlanId, "plan-abc");
  });

  it("returns dailyAverages with the per-day-suffixed shape (D-WS6-029 contract)", async () => {
    const token = signToken(TEST_USER_ID + "-shape");
    const res = await fetch(`${harness.baseUrl}/plans/plan-shape/recalc-macros`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PlanMacrosResult;
    // Positive: the four *PerDay keys are present (matches mobile MacroDailyAverage).
    assert.ok("caloriesPerDay" in body.dailyAverages);
    assert.ok("proteinGPerDay" in body.dailyAverages);
    assert.ok("carbsGPerDay" in body.dailyAverages);
    assert.ok("fatGPerDay" in body.dailyAverages);
    // Negative: the bare per-meal MacroTotals names are NOT present at the
    // daily-averages level (we want a hard break on the old shape so any
    // mobile consumer that still expects them fails loudly).
    const bare = body.dailyAverages as unknown as Record<string, unknown>;
    assert.equal(bare.calories, undefined);
    assert.equal(bare.proteinG, undefined);
    assert.equal(bare.carbsG, undefined);
    assert.equal(bare.fatG, undefined);
  });
});

describe("POST /api/plans/:id/recalc-macros — auth", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      computePlanMacros: (async () => HAPPY_RESULT) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await fetch(`${harness.baseUrl}/plans/plan-abc/recalc-macros`, {
      method: "POST",
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/plans/:id/recalc-macros — not found / forbidden", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      computePlanMacros: (async ({ planId }: { planId: string }) => {
        if (planId === "missing") throw new PlanMacrosNotFoundError(planId);
        if (planId === "stranger") throw new PlanMacrosForbiddenError(planId);
        return HAPPY_RESULT;
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  it("returns 404 when the plan does not exist", async () => {
    const token = signToken(TEST_USER_ID + "-nf");
    const res = await fetch(`${harness.baseUrl}/plans/missing/recalc-macros`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  });

  it("returns 404 (not 403) when the plan belongs to another user — does not leak existence", async () => {
    const token = signToken(TEST_USER_ID + "-fb");
    const res = await fetch(`${harness.baseUrl}/plans/stranger/recalc-macros`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  });
});

describe("POST /api/plans/:id/recalc-macros — server errors", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      computePlanMacros: (async () => {
        throw new Error("boom");
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  it("returns 500 with a generic error envelope on unhandled failures", async () => {
    const token = signToken(TEST_USER_ID + "-500");
    const res = await fetch(`${harness.baseUrl}/plans/plan-x/recalc-macros`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "internal server error");
  });
});

// ── WS7-3 A2 — GET /plans (list+filter) + GET /plans/:id (composite) ──────

const A2_USER = "test-user-plans-a2";

function instanceFix(opts: {
  id: string;
  userId?: string;
  name: string;
  isActiveThisWeek?: boolean;
  createdAt?: Date;
  prepStatus?: "not_prepped" | "partial" | "prepped";
  optimizationNotes?: unknown;
  breakfastOverrides?: string | null;
  lunchOverrides?: string | null;
  items?: {
    id: string;
    mealId: string;
    positionIndex: number;
    assignedDayOfWeek: string | null;
  }[];
}) {
  return {
    id: opts.id,
    userId: opts.userId ?? A2_USER,
    titleOverride: opts.name,
    status: "this_week",
    startDate: null as Date | null,
    endDate: null as Date | null,
    isActiveThisWeek: opts.isActiveThisWeek ?? false,
    revisionId: 2,
    prepStatus: opts.prepStatus ?? "not_prepped",
    optimizationNotes: opts.optimizationNotes ?? null,
    breakfastOverrides: opts.breakfastOverrides ?? null,
    lunchOverrides: opts.lunchOverrides ?? null,
    createdAt: opts.createdAt ?? new Date("2026-05-01T00:00:00Z"),
    template: {
      title: opts.name,
      description: "instance template",
      imageUrl: null as string | null,
      tags: ["dev"],
      sourceType: "wizard",
    },
    items: (opts.items ?? []).map((it) => ({
      ...it,
      assignedDate: null as Date | null,
      servingsOverride: null as number | null,
      isBreakfast: false,
      isLunch: false,
      isDinner: true,
      notes: null as string | null,
    })),
  };
}

function templateFix(id: string, title: string) {
  return {
    id,
    title,
    description: "public template",
    imageUrl: null as string | null,
    tags: ["featured"],
  };
}

function mealFix(id: string, title: string, calories: number) {
  return {
    id,
    title,
    description: null as string | null,
    cuisineType: "American",
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "manual",
    estimatedTimeMinutes: 30,
    imageUrl: null as string | null,
    servingsDefault: 4,
    tags: ["t"],
    caloriesPerServing: calories,
    proteinGPerServing: 20,
    carbsGPerServing: 40,
    fatGPerServing: 15,
    isArchived: false,
    isPublic: true,
    userId: A2_USER,
    dishLinks: [] as unknown[],
  };
}

const A2_SETTINGS = [
  { key: "top_rated.save_weight", value: 1 },
  { key: "top_rated.use_weight", value: 2 },
  { key: "top_rated.decay_half_life_days", value: 30 },
  { key: "top_rated.refresh_interval_hours", value: 6 },
  { key: "top_rated.display_count", value: 20 },
];

function makeA2Stub(opts: {
  instances?: ReturnType<typeof instanceFix>[];
  featured?: ReturnType<typeof templateFix>[];
  topRated?: ReturnType<typeof templateFix>[];
  meals?: ReturnType<typeof mealFix>[];
}) {
  const instances = opts.instances ?? [];
  const meals = opts.meals ?? [];
  return {
    mealPlanInstance: {
      findMany: async (args: { where: { userId: string } }) =>
        instances
          .filter((i) => i.userId === args.where.userId)
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findFirst: async (args: {
        where: { userId: string; isActiveThisWeek?: boolean };
      }) =>
        instances.find(
          (i) =>
            i.userId === args.where.userId &&
            (args.where.isActiveThisWeek === undefined ||
              i.isActiveThisWeek === args.where.isActiveThisWeek),
        ) ?? null,
      findUnique: async (args: { where: { id: string } }) =>
        instances.find((i) => i.id === args.where.id) ?? null,
    },
    mealPlanTemplate: {
      findMany: async (args: {
        where?: { isFeatured?: boolean; isHostingFeatured?: boolean };
      }) => {
        if (args.where?.isFeatured === true) return opts.featured ?? [];
        if (args.where?.isHostingFeatured === true) return [];
        return opts.topRated ?? [];
      },
    },
    meal: {
      findUnique: async (args: { where: { id: string } }) =>
        meals.find((m) => m.id === args.where.id) ?? null,
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
    },
    systemSetting: {
      findMany: async (args: { where: { key: { in: string[] } } }) =>
        A2_SETTINGS.filter((s) => args.where.key.in.includes(s.key)),
    },
  };
}

function a2SpinUp(stub: unknown): Promise<Harness> {
  return spinUp({
    prisma: stub as never,
    computePlanMacros: (async () => HAPPY_RESULT) as never,
  });
}

describe("GET /plans — list + filter", () => {
  it("defaults to my_plans and returns the user's instances", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({ id: "p-1", name: "Plan One" }),
          instanceFix({ id: "p-2", name: "Plan Two", userId: "stranger" }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plans: { id: string; source: string }[];
        activeThisWeek: unknown;
        nextCursor: string | null;
      };
      assert.deepEqual(
        body.plans.map((p) => p.id),
        ["p-1"],
      );
      assert.equal(body.plans[0].source, "instance");
      assert.ok("nextCursor" in body);
    } finally {
      await harness.close();
    }
  });

  it("OR semantics: my_plans,featured merges both facets", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [instanceFix({ id: "p-own", name: "Owned" })],
        featured: [templateFix("t-feat", "Featured Plan")],
      }),
    );
    try {
      const res = await fetch(
        `${harness.baseUrl}/plans?filter=my_plans,featured`,
        { headers: { Authorization: `Bearer ${signToken(A2_USER)}` } },
      );
      const body = (await res.json()) as {
        plans: { id: string; source: string }[];
      };
      assert.deepEqual(
        body.plans.map((p) => p.id),
        ["p-own", "t-feat"],
      );
      assert.equal(body.plans[1].source, "template");
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown filter value with 400", async () => {
    const harness = await a2SpinUp(makeA2Stub({}));
    try {
      const res = await fetch(`${harness.baseUrl}/plans?filter=bogus`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { unknown: string[] };
      assert.deepEqual(body.unknown, ["bogus"]);
    } finally {
      await harness.close();
    }
  });

  it("includes the activeThisWeek summary", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({ id: "p-active", name: "Active Plan", isActiveThisWeek: true }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      const body = (await res.json()) as {
        activeThisWeek: { id: string; revisionId: number } | null;
      };
      assert.ok(body.activeThisWeek);
      assert.equal(body.activeThisWeek.id, "p-active");
      assert.equal(body.activeThisWeek.revisionId, 2);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await a2SpinUp(makeA2Stub({}));
    try {
      const res = await fetch(`${harness.baseUrl}/plans`);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

describe("GET /plans/:id — composite Plan Review", () => {
  it("returns the plan with expanded items and a fresh macroDailyAverage", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-detail",
            name: "Review Me",
            items: [
              { id: "it-1", mealId: "m-a", positionIndex: 0, assignedDayOfWeek: "Monday" },
              { id: "it-2", mealId: "m-b", positionIndex: 1, assignedDayOfWeek: "Tuesday" },
            ],
          }),
        ],
        meals: [mealFix("m-a", "Meal A", 600), mealFix("m-b", "Meal B", 400)],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-detail`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: {
          id: string;
          name: string;
          sourceType: string;
          items: { id: string; meal: { id: string; calories: number } | null }[];
          macroDailyAverage: { caloriesPerDay: number };
        };
      };
      assert.equal(body.plan.id, "p-detail");
      assert.equal(body.plan.sourceType, "wizard"); // from the template
      assert.equal(body.plan.items.length, 2);
      assert.equal(body.plan.items[0].meal?.id, "m-a");
      assert.equal(body.plan.items[0].meal?.calories, 600);
      // (600 + 400) / 2 distinct days = 500/day
      assert.equal(body.plan.macroDailyAverage.caloriesPerDay, 500);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the plan belongs to another user", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({ id: "p-stranger", name: "Not Yours", userId: "stranger" }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-stranger`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 for a non-existent plan id", async () => {
    const harness = await a2SpinUp(makeA2Stub({}));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/ghost-plan`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an over-length plan id", async () => {
    const harness = await a2SpinUp(makeA2Stub({}));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/${"x".repeat(101)}`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  // WS7-4-A c6 — widened response carries the new MealPlanInstance fields.
  it("returns prepStatus + optimizationNotes + breakfast/lunch overrides", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-widened",
            name: "Widened Fields",
            prepStatus: "partial",
            optimizationNotes: [{ type: "prep", text: "Batch-cook Sunday" }],
            breakfastOverrides: "yogurt + berries",
            lunchOverrides: "Sat: leftovers",
            items: [],
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-widened`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: {
          prepStatus: string;
          optimizationNotes: Array<{ type: string; text: string }>;
          breakfastOverrides: string;
          lunchOverrides: string;
        };
      };
      assert.equal(body.plan.prepStatus, "partial");
      assert.equal(body.plan.optimizationNotes.length, 1);
      assert.equal(body.plan.optimizationNotes[0].text, "Batch-cook Sunday");
      assert.equal(body.plan.breakfastOverrides, "yogurt + berries");
      assert.equal(body.plan.lunchOverrides, "Sat: leftovers");
    } finally {
      await harness.close();
    }
  });
});
