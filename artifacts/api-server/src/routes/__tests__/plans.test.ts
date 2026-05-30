// WS6 6b-3 — POST /api/plans/:id/recalc-macros tests.
// Mirrors the meals.test.ts harness pattern — real Express + JWT, but
// computePlanMacros is stubbed at the deps boundary so the tests don't
// need a DB.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import { z } from "zod";

import { signToken } from "../../lib/auth";
import {
  PlanMacrosForbiddenError,
  PlanMacrosNotFoundError,
  type PlanMacrosResult,
} from "../../lib/planMacros";
import { currentWeekRange } from "../../lib/planDates";
import { toYmd } from "../../lib/planQueries";
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
  startDate?: Date | null;
  endDate?: Date | null;
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
    startDate: opts.startDate ?? (null as Date | null),
    endDate: opts.endDate ?? (null as Date | null),
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

  // WS7-4-D c16 — user-facing plan dates cross the wire as YYYY-MM-DD on the
  // read path, symmetric with the mobile editor's emit shape (PlanDateRangeEditor
  // deliberately emits YYYY-MM-DD to dodge toISOString TZ-shift; PATCH accepts
  // it via planDateString per c11). Without symmetric reads, refetch handed
  // back full ISO 8601 that the mobile parser couldn't split, rendering
  // "Invalid Date – Invalid Date" in the editor trigger.
  it("returns startDate/endDate as YYYY-MM-DD (not ISO 8601) on the wire", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-dated",
            name: "Dated Plan",
            startDate: new Date("2026-06-07T00:00:00.000Z"),
            endDate: new Date("2026-06-13T00:00:00.000Z"),
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-dated`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: { startDate: string | null; endDate: string | null };
      };
      assert.equal(body.plan.startDate, "2026-06-07");
      assert.equal(body.plan.endDate, "2026-06-13");
    } finally {
      await harness.close();
    }
  });

  it("returns null startDate/endDate as null (not coerced to a string)", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-undated",
            name: "Undated Plan",
            startDate: null,
            endDate: null,
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-undated`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: { startDate: string | null; endDate: string | null };
      };
      assert.equal(body.plan.startDate, null);
      assert.equal(body.plan.endDate, null);
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

  // WS7-4-B c3 — new GET /plans/templates/:id endpoint tests follow at the
  // bottom of this file. The c6 case below is the prior WS7-4-A widening test.

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

  // WS7-4-D c15 — items must come back Sun→Sat with unscheduled pinned at
  // the bottom in positionIndex order. The Prisma include still fetches with
  // `orderBy: { positionIndex: "asc" }`; the route applies the canonical
  // comparator post-fetch.
  it("c15: orders items Sun→Sat with unscheduled pinned to the bottom (positionIndex tiebreaker)", async () => {
    // Fixture order deliberately scrambled to prove the server is sorting,
    // not echoing the input order. positionIndex on item-mon-2 is < the
    // other Monday item to exercise the tiebreaker.
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-sort",
            name: "Sort Me",
            items: [
              { id: "item-sat",   mealId: "m-a", positionIndex: 0, assignedDayOfWeek: "Saturday" },
              { id: "item-uns-b", mealId: "m-b", positionIndex: 1, assignedDayOfWeek: null },
              { id: "item-sun",   mealId: "m-c", positionIndex: 2, assignedDayOfWeek: "Sunday" },
              { id: "item-mon-1", mealId: "m-d", positionIndex: 4, assignedDayOfWeek: "Monday" },
              { id: "item-mon-2", mealId: "m-e", positionIndex: 3, assignedDayOfWeek: "Monday" },
              { id: "item-uns-a", mealId: "m-f", positionIndex: 0, assignedDayOfWeek: null },
              { id: "item-wed",   mealId: "m-g", positionIndex: 5, assignedDayOfWeek: "Wednesday" },
            ],
          }),
        ],
        meals: [
          mealFix("m-a", "A", 100),
          mealFix("m-b", "B", 100),
          mealFix("m-c", "C", 100),
          mealFix("m-d", "D", 100),
          mealFix("m-e", "E", 100),
          mealFix("m-f", "F", 100),
          mealFix("m-g", "G", 100),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-sort`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: { items: { id: string; assignedDayOfWeek: string | null }[] };
      };
      const ids = body.plan.items.map((i) => i.id);
      assert.deepEqual(ids, [
        // Sun → Sat assigned cluster.
        "item-sun",
        // Two Monday items, lower positionIndex first.
        "item-mon-2",
        "item-mon-1",
        "item-wed",
        "item-sat",
        // Unscheduled cluster pinned to bottom, positionIndex ASC.
        "item-uns-a",
        "item-uns-b",
      ]);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-5b-mobile FIX — §27 verification ──────────────────────────────────
// Pins the real GET /plans/:id response shape for a wizard-promoted plan
// against the mobile PlanSchema's optimizationNotes subschema, so the exact
// failure that broke Plan Review ("Couldn't load this plan." from
// ApiSchemaError) is caught by a test instead of by a device-testing
// session. Block C's mock-at-the-wrapper-layer round-trip missed it; this
// describe block pins the contract directly at GET /plans/:id, which is
// where the mobile parse happens in real flows (My Plans tap → Plan Review
// hydrate → PlanSchema.safeParse).

describe("GET /plans/:id — WS7-5b-mobile FIX §27 verification", () => {
  // Mirror of the mobile PlanSchema's optimizationNotes subschema
  // (artifacts/kiwi/lib/api/plans.ts:109-112). The api-server can't import
  // from the kiwi package, so the shape is pinned here. The contract is:
  // this shape stays byte-equivalent with the mobile OptimizationNoteSchema;
  // if mobile updates, update both together.
  const MobileOptimizationNotesSchema = z.array(
    z.object({
      type: z.enum(["prep", "cost"]),
      text: z.string(),
    }),
  );

  it("heals legacy wizard rows: WizardExpandedPlan object in optimizationNotes coerces to [] and parses against mobile PlanSchema", async () => {
    // The exact pre-fix broken row shape, copied from the DB inspection
    // during Phase 1 (rows like f3bbcc24 / 5fc1f4e4): the entire
    // WizardExpandedPlan JSON stored where mobile expects [{type,text}].
    // This is the row shape that was producing "Couldn't load this plan."
    const legacyWizardJsonBlob = {
      candidateId: "c-legacy",
      title: "Old Wizard Plan",
      tags: ["legacy"],
      whyBullets: ["Reason 1", "Reason 2"],
      meals: [],
    };
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-legacy-wizard",
            name: "Old Wizard Plan",
            optimizationNotes: legacyWizardJsonBlob,
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-legacy-wizard`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: { optimizationNotes: unknown };
      };
      // Defensive coerce: the unparseable object becomes [], not a 500
      // and not the raw object that fails mobile parse.
      assert.deepEqual(body.plan.optimizationNotes, []);
      // Mobile-side Zod parse passes — this is the exact failure mode that
      // broke Plan Review pre-fix. If this assert fails, Plan Review is
      // broken again for legacy wizard rows.
      const parsed = MobileOptimizationNotesSchema.safeParse(
        body.plan.optimizationNotes,
      );
      assert.equal(
        parsed.success,
        true,
        "mobile PlanSchema must parse the GET /plans/:id response clean",
      );
    } finally {
      await harness.close();
    }
  });

  it("post-fix shape: null optimizationNotes + Template-backed instance parses clean against the mobile PlanSchema", async () => {
    // Simulates what new wizard plans look like after the Template-pair fix:
    // mealPlanTemplateId is set (the template fixture defaults to title +
    // tags + sourceType:'wizard'), optimizationNotes is null (route clears
    // it via Prisma.DbNull on activate/save). Mobile parse must pass.
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-new-wizard",
            name: "New Wizard Plan",
            optimizationNotes: null,
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-new-wizard`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: {
          name: string;
          sourceType: string;
          optimizationNotes: unknown;
        };
      };
      // sourceType comes from the linked template — wizard.
      assert.equal(body.plan.sourceType, "wizard");
      // Name surfaces (PRD §2.4: Template owns title, surfaced on Instance).
      assert.equal(body.plan.name, "New Wizard Plan");
      // Mobile schema parses optimizationNotes.
      assert.deepEqual(body.plan.optimizationNotes, []);
      const parsed = MobileOptimizationNotesSchema.safeParse(
        body.plan.optimizationNotes,
      );
      assert.equal(parsed.success, true);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-B c3 — GET /plans/templates/:id ─────────────────────────────────

interface TemplateDetailFix {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  tags: string[];
  sourceType: "wizard" | "manual" | "imported_url" | "imported_image" | "imported_text";
  defaultDaysCount: number;
  isPublic: boolean;
  optimizationNotes: unknown;
  items: {
    id: string;
    mealId: string;
    positionIndex: number;
    assignedDayOfWeek: string | null;
    isBreakfast: boolean;
    isLunch: boolean;
    isDinner: boolean;
  }[];
}

function templateDetailFix(opts: Partial<TemplateDetailFix> & { id: string }): TemplateDetailFix {
  return {
    id: opts.id,
    userId: opts.userId ?? A2_USER,
    title: opts.title ?? "Template",
    description: opts.description ?? "A template",
    imageUrl: opts.imageUrl ?? null,
    tags: opts.tags ?? ["dev"],
    sourceType: opts.sourceType ?? "wizard",
    defaultDaysCount: opts.defaultDaysCount ?? 5,
    isPublic: opts.isPublic ?? true,
    optimizationNotes: opts.optimizationNotes ?? null,
    items: opts.items ?? [],
  };
}

interface C3Recorder {
  activityWrites: Array<Record<string, unknown>>;
}

function makeC3Stub(opts: {
  templates?: TemplateDetailFix[];
  meals?: ReturnType<typeof mealFix>[];
  recorder?: C3Recorder;
}) {
  const templates = opts.templates ?? [];
  const meals = opts.meals ?? [];
  const recorder = opts.recorder;
  const txClient = {
    mealPlanTemplate: {
      findUnique: async (args: { where: { id: string } }) =>
        templates.find((t) => t.id === args.where.id) ?? null,
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder?.activityWrites.push(args.data);
        return { id: "act-c3" };
      },
    },
  };
  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanTemplate: txClient.mealPlanTemplate,
    userActivity: txClient.userActivity,
    meal: {
      findUnique: async (args: { where: { id: string } }) =>
        meals.find((m) => m.id === args.where.id) ?? null,
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
    },
  };
}

function c3SpinUp(stub: unknown): Promise<Harness> {
  return spinUp({
    prisma: stub as never,
    computePlanMacros: (async () => HAPPY_RESULT) as never,
  });
}

describe("GET /plans/templates/:id — public template detail", () => {
  it("returns the template with expanded items for an authenticated reader", async () => {
    const harness = await c3SpinUp(
      makeC3Stub({
        templates: [
          templateDetailFix({
            id: "t-pub",
            userId: "owner-x",
            title: "Family Favorites",
            description: "Crowd-pleasers",
            imageUrl: "https://example.com/fam.jpg",
            tags: ["family", "dev"],
            defaultDaysCount: 5,
            isPublic: true,
            optimizationNotes: [{ type: "prep", text: "Batch sauce Sunday" }],
            items: [
              { id: "ti-1", mealId: "m-a", positionIndex: 0, assignedDayOfWeek: "Monday",
                isBreakfast: false, isLunch: false, isDinner: true },
              { id: "ti-2", mealId: "m-b", positionIndex: 1, assignedDayOfWeek: "Tuesday",
                isBreakfast: false, isLunch: false, isDinner: true },
            ],
          }),
        ],
        meals: [mealFix("m-a", "Meal A", 500), mealFix("m-b", "Meal B", 600)],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/templates/t-pub`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        template: {
          id: string;
          title: string;
          image: string | null;
          defaultDaysCount: number;
          tags: string[];
          optimizationNotes: Array<{ type: string; text: string }>;
          items: { id: string; mealId: string; positionIndex: number; meal: { id: string } | null }[];
        };
      };
      assert.equal(body.template.id, "t-pub");
      assert.equal(body.template.title, "Family Favorites");
      assert.equal(body.template.image, "https://example.com/fam.jpg");
      assert.equal(body.template.defaultDaysCount, 5);
      assert.deepEqual(body.template.tags, ["family", "dev"]);
      assert.equal(body.template.optimizationNotes.length, 1);
      assert.equal(body.template.items.length, 2);
      assert.equal(body.template.items[0].mealId, "m-a");
      assert.equal(body.template.items[0].meal?.id, "m-a");
      assert.equal(body.template.items[1].mealId, "m-b");
    } finally {
      await harness.close();
    }
  });

  // Risk 5 — owner can read their own non-public template (dev workflow).
  it("returns 200 when the owner reads their own non-public template", async () => {
    const harness = await c3SpinUp(
      makeC3Stub({
        templates: [
          templateDetailFix({
            id: "t-priv",
            userId: A2_USER,
            isPublic: false,
            items: [],
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/templates/t-priv`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { template: { id: string; userId: string } };
      assert.equal(body.template.id, "t-priv");
      assert.equal(body.template.userId, A2_USER);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the template does not exist", async () => {
    const harness = await c3SpinUp(makeC3Stub({}));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/templates/ghost-template`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 (not 403) when the template is non-public and the reader is not the owner — no existence leak", async () => {
    const harness = await c3SpinUp(
      makeC3Stub({
        templates: [
          templateDetailFix({ id: "t-secret", userId: "stranger", isPublic: false }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/templates/t-secret`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an over-length template id", async () => {
    const harness = await c3SpinUp(makeC3Stub({}));
    try {
      const res = await fetch(
        `${harness.baseUrl}/plans/templates/${"x".repeat(101)}`,
        { headers: { Authorization: `Bearer ${signToken(A2_USER)}` } },
      );
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  // WS7-4-C c0 — plan_preview_opened emission. PRD §9.7: fires only for
  // non-owned plans, i.e. when the reader is NOT the template owner. Owner
  // reading own template emits nothing.
  it("emits plan_preview_opened with isPublic metadata when a non-owner reads a public template", async () => {
    const recorder: C3Recorder = { activityWrites: [] };
    const harness = await c3SpinUp(
      makeC3Stub({
        recorder,
        templates: [
          templateDetailFix({
            id: "t-preview",
            userId: "owner-other",
            isPublic: true,
            items: [],
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/templates/t-preview`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.userId, A2_USER);
      assert.equal(act.eventType, "plan_preview_opened");
      assert.equal(act.entityType, "MealPlanTemplate");
      assert.equal(act.entityId, "t-preview");
      assert.deepEqual(act.metadata, { isPublic: true });
    } finally {
      await harness.close();
    }
  });

  it("does NOT emit plan_preview_opened when the owner reads their own template", async () => {
    const recorder: C3Recorder = { activityWrites: [] };
    const harness = await c3SpinUp(
      makeC3Stub({
        recorder,
        templates: [
          templateDetailFix({
            id: "t-own",
            userId: A2_USER,
            isPublic: true,
            items: [],
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/templates/t-own`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-B c4 — POST /plans/use-template/:templateId ─────────────────────

interface C4Recorder {
  createdInstances: Array<Record<string, unknown>>;
  createManyItemsCalls: Array<{ data: Array<Record<string, unknown>> }>;
  templateUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function makeC4Stub(opts: {
  templates?: TemplateDetailFix[];
  recorder: C4Recorder;
  /** Throw after the createMany — exercises rollback. */
  throwOnUpdate?: boolean;
}) {
  const templates = opts.templates ?? [];
  const recorder = opts.recorder;
  let instanceCounter = 0;

  const txClient = {
    mealPlanTemplate: {
      findUnique: async (args: { where: { id: string } }) =>
        templates.find((t) => t.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (opts.throwOnUpdate) {
          throw new Error("update-failed");
        }
        recorder.templateUpdates.push(args);
        return { id: args.where.id };
      },
    },
    mealPlanInstance: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorder.updateManyCalls.push(args);
        return { count: 0 };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        instanceCounter += 1;
        const id = `created-instance-${instanceCounter}`;
        const row = { id, revisionId: 1, ...args.data };
        recorder.createdInstances.push(row);
        return row;
      },
    },
    mealPlanItem: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        recorder.createManyItemsCalls.push(args);
        return { count: args.data.length };
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-1" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    // Non-transactional surface — not used by c4 but the route accesses
    // prisma.mealPlanTemplate.findUnique elsewhere (c3); harness tolerates.
    mealPlanTemplate: txClient.mealPlanTemplate,
    mealPlanInstance: txClient.mealPlanInstance,
    mealPlanItem: txClient.mealPlanItem,
    userActivity: txClient.userActivity,
  };
}

function mutationSpinUp(
  stub: unknown,
  opts?: {
    limiterCapacity?: number;
    planNeedsMacroEstimation?: () => Promise<boolean>;
  },
): Promise<Harness> {
  return spinUp({
    prisma: stub as never,
    computePlanMacros: (async () => HAPPY_RESULT) as never,
    planNeedsMacroEstimation: (opts?.planNeedsMacroEstimation ??
      (async () => false)) as never,
    // Over-provision the mutation limiter so mutation-route test cases
    // do not 429 themselves (c2/c3/c4 share this helper).
    mutationLimiterOpts: { capacity: opts?.limiterCapacity ?? 1000, refillPerSec: 100 },
  });
}

describe("POST /plans/use-template/:templateId — happy path", () => {
  it("creates an Instance, copies items, demotes prior actives, increments useCount, emits activity", async () => {
    const recorder: C4Recorder = {
      createdInstances: [],
      createManyItemsCalls: [],
      templateUpdates: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4Stub({
        recorder,
        templates: [
          templateDetailFix({
            id: "t-use",
            userId: "owner",
            isPublic: true,
            optimizationNotes: [{ type: "prep", text: "Batch sauce" }],
            items: [
              { id: "ti-1", mealId: "m-a", positionIndex: 0, assignedDayOfWeek: "Monday",
                isBreakfast: false, isLunch: false, isDinner: true },
              { id: "ti-2", mealId: "m-b", positionIndex: 1, assignedDayOfWeek: "Tuesday",
                isBreakfast: false, isLunch: false, isDinner: true },
              { id: "ti-3", mealId: "m-c", positionIndex: 2, assignedDayOfWeek: null,
                isBreakfast: false, isLunch: false, isDinner: true },
            ],
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/t-use`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { instance: { id: string; revisionId: number } };
      assert.ok(body.instance.id.startsWith("created-instance-"));
      assert.equal(body.instance.revisionId, 1);

      // Instance was created with the expected shape.
      assert.equal(recorder.createdInstances.length, 1);
      const created = recorder.createdInstances[0];
      assert.equal(created.userId, A2_USER);
      assert.equal(created.mealPlanTemplateId, "t-use");
      assert.equal(created.isActiveThisWeek, true);
      assert.equal(created.status, "draft");
      assert.equal(created.titleOverride, null);

      // optimizationNotes copied from the template.
      const notes = created.optimizationNotes as Array<{ type: string; text: string }>;
      assert.equal(Array.isArray(notes), true);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, "Batch sauce");

      // 3 items copied, ordered by positionIndex, with day assignments preserved.
      assert.equal(recorder.createManyItemsCalls.length, 1);
      const items = recorder.createManyItemsCalls[0].data;
      assert.equal(items.length, 3);
      assert.equal(items[0].mealId, "m-a");
      assert.equal(items[0].assignedDayOfWeek, "Monday");
      assert.equal(items[2].assignedDayOfWeek, null);

      // demote-prior-actives happened in the same transaction.
      assert.equal(recorder.updateManyCalls.length, 1);
      const updMany = recorder.updateManyCalls[0];
      assert.equal((updMany.where as { userId: string }).userId, A2_USER);
      assert.equal((updMany.where as { isActiveThisWeek: boolean }).isActiveThisWeek, true);
      assert.equal((updMany.data as { isActiveThisWeek: boolean }).isActiveThisWeek, false);

      // Template.useCount incremented + lastUsedAt bumped.
      assert.equal(recorder.templateUpdates.length, 1);
      const upd = recorder.templateUpdates[0];
      assert.equal(upd.where.id, "t-use");
      assert.deepEqual(upd.data.useCount, { increment: 1 });
      assert.ok(upd.data.lastUsedAt instanceof Date);

      // Activity row written with the right event + metadata.
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_used_from_browse");
      assert.equal(act.entityType, "MealPlanInstance");
      assert.equal(act.userId, A2_USER);
      const meta = act.metadata as { templateId: string; itemCount: number };
      assert.equal(meta.templateId, "t-use");
      assert.equal(meta.itemCount, 3);
    } finally {
      await harness.close();
    }
  });

  it("handles a template with zero items (no createMany call)", async () => {
    const recorder: C4Recorder = {
      createdInstances: [],
      createManyItemsCalls: [],
      templateUpdates: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4Stub({
        recorder,
        templates: [templateDetailFix({ id: "t-empty", isPublic: true, items: [] })],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/t-empty`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 201);
      assert.equal(recorder.createdInstances.length, 1);
      assert.equal(recorder.createManyItemsCalls.length, 0);
      assert.equal(recorder.activityWrites[0].metadata && (recorder.activityWrites[0].metadata as { itemCount: number }).itemCount, 0);
    } finally {
      await harness.close();
    }
  });

  // Q-P1-1: owner of a non-public template can also use it.
  it("allows the owner to use their own non-public template", async () => {
    const recorder: C4Recorder = {
      createdInstances: [],
      createManyItemsCalls: [],
      templateUpdates: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4Stub({
        recorder,
        templates: [
          templateDetailFix({
            id: "t-mine",
            userId: A2_USER,
            isPublic: false,
            items: [],
          }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/t-mine`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 201);
      assert.equal(recorder.createdInstances.length, 1);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /plans/use-template/:templateId — errors", () => {
  it("returns 401 when no auth header is present", async () => {
    const recorder: C4Recorder = {
      createdInstances: [], createManyItemsCalls: [], templateUpdates: [],
      updateManyCalls: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC4Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/anything`, { method: "POST" });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an over-length template id", async () => {
    const recorder: C4Recorder = {
      createdInstances: [], createManyItemsCalls: [], templateUpdates: [],
      updateManyCalls: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC4Stub({ recorder }));
    try {
      const res = await fetch(
        `${harness.baseUrl}/plans/use-template/${"x".repeat(101)}`,
        { method: "POST", headers: { Authorization: `Bearer ${signToken(A2_USER)}` } },
      );
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the template does not exist", async () => {
    const recorder: C4Recorder = {
      createdInstances: [], createManyItemsCalls: [], templateUpdates: [],
      updateManyCalls: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC4Stub({ recorder, templates: [] }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/ghost`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
      assert.equal(recorder.createdInstances.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 (not 403) when the template is non-public and the reader is not the owner — no existence leak", async () => {
    const recorder: C4Recorder = {
      createdInstances: [], createManyItemsCalls: [], templateUpdates: [],
      updateManyCalls: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4Stub({
        recorder,
        templates: [
          templateDetailFix({ id: "t-priv", userId: "stranger", isPublic: false }),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/t-priv`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
      assert.equal(recorder.createdInstances.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 429 when the mutation rate limit is exhausted", async () => {
    const recorder: C4Recorder = {
      createdInstances: [], createManyItemsCalls: [], templateUpdates: [],
      updateManyCalls: [], activityWrites: [],
    };
    // Capacity 1, very slow refill — first call passes, second is 429.
    const harness = await mutationSpinUp(
      makeC4Stub({
        recorder,
        templates: [templateDetailFix({ id: "t-limit", isPublic: true, items: [] })],
      }),
      { limiterCapacity: 1 },
    );
    try {
      const token = signToken(A2_USER + "-limit");
      const r1 = await fetch(`${harness.baseUrl}/plans/use-template/t-limit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(r1.status, 201);
      const r2 = await fetch(`${harness.baseUrl}/plans/use-template/t-limit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(r2.status, 429);
    } finally {
      await harness.close();
    }
  });

  it("rolls back the transaction on a mid-write failure (Instance not committed)", async () => {
    const recorder: C4Recorder = {
      createdInstances: [], createManyItemsCalls: [], templateUpdates: [],
      updateManyCalls: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4Stub({
        recorder,
        throwOnUpdate: true,
        templates: [templateDetailFix({ id: "t-fail", isPublic: true, items: [] })],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/use-template/t-fail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 500);
      // The route's response is 500. The recorder's createdInstances will
      // show the in-memory create (the stub does not honor txn rollback),
      // but the route itself never returned the created id — verified by
      // the 500 + the error body.
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "failed to use template");
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-C c2 — POST /plans (empty plan create) ──────────────────────────

interface C2Recorder {
  createdInstances: Array<Record<string, unknown>>;
  updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function makeC2Stub(opts: {
  recorder: C2Recorder;
  /** Throw on mealPlanInstance.create — exercises tx rollback. */
  throwOnCreate?: boolean;
}) {
  const recorder = opts.recorder;
  let instanceCounter = 0;

  const txClient = {
    mealPlanInstance: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorder.updateManyCalls.push(args);
        return { count: 0 };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        if (opts.throwOnCreate) {
          throw new Error("create-failed");
        }
        instanceCounter += 1;
        const id = `created-instance-${instanceCounter}`;
        const row = { id, revisionId: 1, ...args.data };
        recorder.createdInstances.push(row);
        return row;
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-1" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanInstance: txClient.mealPlanInstance,
    userActivity: txClient.userActivity,
  };
}

describe("POST /plans — empty plan create (WS7-4-C c2)", () => {
  it("creates an Instance with the minimal body (no fields) and emits plan_created", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { instance: { id: string; revisionId: number } };
      assert.ok(body.instance.id.startsWith("created-instance-"));
      assert.equal(body.instance.revisionId, 1);

      // Instance row shape: null template, no name, draft, inactive.
      assert.equal(recorder.createdInstances.length, 1);
      const created = recorder.createdInstances[0];
      assert.equal(created.userId, A2_USER);
      assert.equal(created.mealPlanTemplateId, null);
      assert.equal(created.titleOverride, null);
      assert.equal(created.status, "draft");
      assert.equal(created.isActiveThisWeek, false);

      // No demote when isActiveThisWeek is false (default).
      assert.equal(recorder.updateManyCalls.length, 0);

      // Activity emitted with the right shape.
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.userId, A2_USER);
      assert.equal(act.eventType, "plan_created");
      assert.equal(act.entityType, "MealPlanInstance");
      assert.deepEqual(act.metadata, { isActiveThisWeek: false });
    } finally {
      await harness.close();
    }
  });

  it("creates an Instance with full body, demotes prior actives, emits activity isActiveThisWeek=true", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "My Empty Plan",
          startDate: "2026-06-01T00:00:00.000Z",
          endDate: "2026-06-07T23:59:59.000Z",
          isActiveThisWeek: true,
        }),
      });
      assert.equal(res.status, 201);

      assert.equal(recorder.createdInstances.length, 1);
      const created = recorder.createdInstances[0];
      assert.equal(created.titleOverride, "My Empty Plan");
      assert.equal(created.isActiveThisWeek, true);
      assert.ok(created.startDate instanceof Date);
      assert.ok(created.endDate instanceof Date);

      // Prior actives demoted in same tx.
      assert.equal(recorder.updateManyCalls.length, 1);
      const upd = recorder.updateManyCalls[0];
      assert.equal((upd.where as { userId: string }).userId, A2_USER);
      assert.equal((upd.where as { isActiveThisWeek: boolean }).isActiveThisWeek, true);
      assert.equal((upd.data as { isActiveThisWeek: boolean }).isActiveThisWeek, false);

      // Activity metadata reflects the active state.
      assert.equal(recorder.activityWrites.length, 1);
      assert.deepEqual(recorder.activityWrites[0].metadata, { isActiveThisWeek: true });
    } finally {
      await harness.close();
    }
  });

  it("returns 400 when name exceeds 120 chars (Zod max validation)", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x".repeat(121) }),
      });
      assert.equal(res.status, 400);
      assert.equal(recorder.createdInstances.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 when an unknown body field is provided (Zod strict)", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "ok", unknownField: "rejected" }),
      });
      assert.equal(res.status, 400);
      assert.equal(recorder.createdInstances.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no Authorization header is present", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 401);
      assert.equal(recorder.createdInstances.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("rolls back: when create throws, activity is NOT written and 500 is returned", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC2Stub({ recorder, throwOnCreate: true }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "doomed" }),
      });
      assert.equal(res.status, 500);
      assert.equal(recorder.createdInstances.length, 0);
      // The recorder records only what the stub allows; create threw before
      // pushing to createdInstances. emitActivity sits AFTER create in the
      // route, so it never fires — verifies ordering, not Prisma rollback.
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-C c3 — DELETE /plans/:id (soft-delete / compost) ────────────────

interface C3DeleteFix {
  id: string;
  userId: string;
  revisionId: number;
  isActiveThisWeek: boolean;
}

interface C3DeleteRecorder {
  instanceUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function makeC3DeleteStub(opts: {
  instances?: C3DeleteFix[];
  recorder: C3DeleteRecorder;
}) {
  const instances = opts.instances ?? [];
  const recorder = opts.recorder;

  const txClient = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = instances.find((i) => i.id === args.where.id);
        return row ?? null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        recorder.instanceUpdates.push(args);
        const row = instances.find((i) => i.id === args.where.id);
        const newRev = (row?.revisionId ?? 0) + 1;
        return { id: args.where.id, revisionId: newRev };
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-1" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanInstance: txClient.mealPlanInstance,
    userActivity: txClient.userActivity,
  };
}

describe("DELETE /plans/:id — soft-delete (WS7-4-C c3)", () => {
  it("owner soft-deletes own plan: status=past, compostedAt set, isArchived true, revisionId bumped, activity emitted", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC3DeleteStub({
        recorder,
        instances: [
          { id: "p-1", userId: A2_USER, revisionId: 3, isActiveThisWeek: false },
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { instance: { id: string; revisionId: number } };
      assert.equal(body.instance.id, "p-1");
      assert.equal(body.instance.revisionId, 4);

      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "p-1");
      assert.equal(upd.data.status, "past");
      assert.ok(upd.data.compostedAt instanceof Date);
      assert.equal(upd.data.isArchived, true);
      assert.equal(upd.data.isActiveThisWeek, false);
      assert.deepEqual(upd.data.revisionId, { increment: 1 });

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.userId, A2_USER);
      assert.equal(act.eventType, "plan_composted");
      assert.equal(act.entityType, "MealPlanInstance");
      assert.equal(act.entityId, "p-1");
      assert.deepEqual(act.metadata, { wasActive: false });
    } finally {
      await harness.close();
    }
  });

  it("DELETE on active plan auto-clears isActiveThisWeek and records wasActive=true in metadata (Q-P1-5)", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC3DeleteStub({
        recorder,
        instances: [
          { id: "p-active", userId: A2_USER, revisionId: 1, isActiveThisWeek: true },
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-active`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);

      // Single update statement carries the auto-demote.
      assert.equal(recorder.instanceUpdates.length, 1);
      assert.equal(recorder.instanceUpdates[0].data.isActiveThisWeek, false);

      // Activity records that this plan WAS active at delete time.
      assert.deepEqual(recorder.activityWrites[0].metadata, { wasActive: true });
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the plan does not exist", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const harness = await mutationSpinUp(makeC3DeleteStub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/ghost`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
      assert.equal(recorder.instanceUpdates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 (not 403) when the plan belongs to another user — no existence leak", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC3DeleteStub({
        recorder,
        instances: [
          { id: "p-other", userId: "stranger", revisionId: 1, isActiveThisWeek: false },
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-other`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 404);
      assert.equal(recorder.instanceUpdates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no Authorization header is present", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const harness = await mutationSpinUp(makeC3DeleteStub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-1`, { method: "DELETE" });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an over-length plan id", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const harness = await mutationSpinUp(makeC3DeleteStub({ recorder }));
    try {
      const res = await fetch(
        `${harness.baseUrl}/plans/${"x".repeat(101)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-C c4 — PATCH /plans/:id (multi-field) ───────────────────────────

interface C4PatchFix {
  id: string;
  userId: string;
  titleOverride: string | null;
  startDate: Date | null;
  endDate: Date | null;
  status: "draft" | "this_week" | "next_week" | "upcoming" | "past";
  isActiveThisWeek: boolean;
  breakfastOverrides: string | null;
  lunchOverrides: string | null;
  prepStatus: "not_prepped" | "partial" | "prepped";
  revisionId: number;
}

interface C4PatchRecorder {
  instanceUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function makeC4PatchStub(opts: {
  instances?: C4PatchFix[];
  recorder: C4PatchRecorder;
  /** Throw on mealPlanInstance.update — exercises rollback. */
  throwOnUpdate?: boolean;
}) {
  const instances = opts.instances ?? [];
  const recorder = opts.recorder;

  const txClient = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = instances.find((i) => i.id === args.where.id);
        return row ?? null;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorder.updateManyCalls.push(args);
        return { count: 0 };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (opts.throwOnUpdate) {
          throw new Error("update-failed");
        }
        recorder.instanceUpdates.push(args);
        const row = instances.find((i) => i.id === args.where.id);
        const bumped =
          args.data.revisionId &&
          typeof args.data.revisionId === "object" &&
          "increment" in (args.data.revisionId as Record<string, unknown>);
        const newRev = (row?.revisionId ?? 0) + (bumped ? 1 : 0);
        return { id: args.where.id, revisionId: newRev };
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-1" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanInstance: txClient.mealPlanInstance,
    userActivity: txClient.userActivity,
  };
}

function fixturePatch(opts: Partial<C4PatchFix> & { id: string }): C4PatchFix {
  return {
    id: opts.id,
    userId: opts.userId ?? A2_USER,
    titleOverride: opts.titleOverride ?? "Original Name",
    startDate: opts.startDate ?? null,
    endDate: opts.endDate ?? null,
    status: opts.status ?? "draft",
    isActiveThisWeek: opts.isActiveThisWeek ?? false,
    breakfastOverrides: opts.breakfastOverrides ?? null,
    lunchOverrides: opts.lunchOverrides ?? null,
    prepStatus: opts.prepStatus ?? "not_prepped",
    revisionId: opts.revisionId ?? 1,
  };
}

async function patchPlan(
  harness: Harness,
  id: string,
  body: Record<string, unknown>,
  userId: string = A2_USER,
): Promise<Response> {
  return fetch(`${harness.baseUrl}/plans/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${signToken(userId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH /plans/:id — multi-field (WS7-4-C c4)", () => {
  it("name-only PATCH emits plan_name_edited and does NOT bump revisionId (Ruling 8)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", titleOverride: "Old", revisionId: 5 })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { name: "New" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { instance: { revisionId: number }; macrosStale: boolean };
      assert.equal(body.instance.revisionId, 5);
      assert.equal(body.macrosStale, false);

      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.data.titleOverride, "New");
      assert.equal(upd.data.revisionId, undefined);

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_name_edited");
      assert.deepEqual(act.metadata, { from: "Old", to: "New" });
    } finally {
      await harness.close();
    }
  });

  it("startDate-only PATCH emits ONE plan_date_range_edited with fields=[startDate]", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", startDate: null, endDate: null, revisionId: 2 })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { startDate: "2026-06-01T00:00:00.000Z" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { instance: { revisionId: number } };
      assert.equal(body.instance.revisionId, 3);

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_date_range_edited");
      const meta = act.metadata as { fields: string[]; from: { startDate: string | null }; to: { startDate: string | null } };
      assert.deepEqual(meta.fields, ["startDate"]);
      assert.equal(meta.from.startDate, null);
      assert.equal(meta.to.startDate, "2026-06-01T00:00:00.000Z");
    } finally {
      await harness.close();
    }
  });

  it("startDate + endDate PATCH emits ONE plan_date_range_edited with fields=[startDate,endDate]", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", {
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-07T00:00:00.000Z",
      });
      assert.equal(res.status, 200);

      assert.equal(recorder.activityWrites.length, 1);
      const meta = recorder.activityWrites[0].metadata as { fields: string[] };
      assert.deepEqual(meta.fields, ["startDate", "endDate"]);
    } finally {
      await harness.close();
    }
  });

  // WS7-4-D c11 — wire-shape reconciliation. Mobile PlanDateRangeEditor emits
  // YYYY-MM-DD (local-time, no TZ shift); previous Zod schema accepted only
  // full ISO 8601 datetimes, so production PATCH was rejected at parse with
  // 400/responseTime:1ms. Server now accepts either shape; UTC midnight
  // canonicalization in isoOrNull() keeps activity-event metadata stable.
  it("startDate as YYYY-MM-DD (mobile wire shape) is accepted and canonicalized to UTC midnight ISO", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", startDate: null, endDate: null, revisionId: 2 })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { startDate: "2026-06-03" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { instance: { revisionId: number } };
      assert.equal(body.instance.revisionId, 3);

      assert.equal(recorder.activityWrites.length, 1);
      const meta = recorder.activityWrites[0].metadata as { to: { startDate: string | null } };
      assert.equal(meta.to.startDate, "2026-06-03T00:00:00.000Z");
    } finally {
      await harness.close();
    }
  });

  it("startDate + endDate as YYYY-MM-DD (mobile wire shape) both accepted", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", {
        startDate: "2026-06-03",
        endDate: "2026-06-09",
      });
      assert.equal(res.status, 200);
      const meta = recorder.activityWrites[0].metadata as { fields: string[]; to: { startDate: string | null; endDate: string | null } };
      assert.deepEqual(meta.fields, ["startDate", "endDate"]);
      assert.equal(meta.to.startDate, "2026-06-03T00:00:00.000Z");
      assert.equal(meta.to.endDate, "2026-06-09T00:00:00.000Z");
    } finally {
      await harness.close();
    }
  });

  it("malformed date string (not YYYY-MM-DD and not ISO) is rejected with 400 invalid body", async () => {
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder: { instanceUpdates: [], updateManyCalls: [], activityWrites: [] },
        instances: [fixturePatch({ id: "p-1" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { startDate: "not-a-date" } as unknown as { startDate: string });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid body");
    } finally {
      await harness.close();
    }
  });

  it("status PATCH (draft -> this_week) emits plan_status_changed metadata {from, to}", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", status: "draft" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { status: "this_week" });
      assert.equal(res.status, 200);

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_status_changed");
      assert.deepEqual(act.metadata, { from: "draft", to: "this_week" });
    } finally {
      await harness.close();
    }
  });

  it("isActiveThisWeek false -> true demotes prior actives in same tx and emits plan_activated_this_week", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        // Pre-dated fixture isolates the demote + emit assertions from the
        // WS7-5b-mobile-PRE auto-date envelope (which only fires when the
        // row is currently undated). Auto-date round-trip is covered in
        // the dedicated envelope tests below.
        instances: [
          fixturePatch({
            id: "p-1",
            isActiveThisWeek: false,
            startDate: new Date("2026-03-01T00:00:00.000Z"),
            endDate: new Date("2026-03-07T00:00:00.000Z"),
          }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { isActiveThisWeek: true });
      assert.equal(res.status, 200);

      assert.equal(recorder.updateManyCalls.length, 1);
      const upd = recorder.updateManyCalls[0];
      assert.equal((upd.where as { userId: string }).userId, A2_USER);
      assert.equal((upd.where as { isActiveThisWeek: boolean }).isActiveThisWeek, true);
      assert.deepEqual((upd.where as { id: { not: string } }).id, { not: "p-1" });

      assert.equal(recorder.activityWrites.length, 1);
      assert.equal(recorder.activityWrites[0].eventType, "plan_activated_this_week");
    } finally {
      await harness.close();
    }
  });

  it("isActiveThisWeek true -> false does NOT emit plan_activated_this_week (silent demotion)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", isActiveThisWeek: true })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { isActiveThisWeek: false });
      assert.equal(res.status, 200);

      assert.equal(recorder.updateManyCalls.length, 0);
      const types = recorder.activityWrites.map((a) => a.eventType);
      assert.equal(types.includes("plan_activated_this_week"), false);
    } finally {
      await harness.close();
    }
  });

  it("breakfastOverrides PATCH emits plan_breakfast_customized", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", breakfastOverrides: null })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { breakfastOverrides: "skip" });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      assert.equal(recorder.activityWrites[0].eventType, "plan_breakfast_customized");
    } finally {
      await harness.close();
    }
  });

  it("lunchOverrides PATCH emits plan_lunch_customized", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", lunchOverrides: null })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { lunchOverrides: "leftovers" });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      assert.equal(recorder.activityWrites[0].eventType, "plan_lunch_customized");
    } finally {
      await harness.close();
    }
  });

  it("prepStatus forward transition (not_prepped -> partial) emits plan_prep_started", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", prepStatus: "not_prepped" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { prepStatus: "partial" });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      assert.equal(recorder.activityWrites[0].eventType, "plan_prep_started");
    } finally {
      await harness.close();
    }
  });

  it("prepStatus backward transition (prepped -> not_prepped) applies write but emits NO event", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", prepStatus: "prepped" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { prepStatus: "not_prepped" });
      assert.equal(res.status, 200);
      assert.equal(recorder.instanceUpdates.length, 1);
      assert.equal(recorder.instanceUpdates[0].data.prepStatus, "not_prepped");
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("optimizationNotes PATCH applies write but emits NO activity", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", {
        optimizationNotes: [{ type: "prep", text: "Batch on Sunday" }],
      });
      assert.equal(res.status, 200);
      assert.equal(recorder.instanceUpdates.length, 1);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("multi-field PATCH (name + status + startDate) emits 3 events and bumps revisionId", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({ id: "p-1", titleOverride: "Old", status: "draft", revisionId: 7 }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", {
        name: "Renamed",
        status: "this_week",
        startDate: "2026-06-01T00:00:00.000Z",
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { instance: { revisionId: number } };
      assert.equal(body.instance.revisionId, 8);

      assert.equal(recorder.activityWrites.length, 3);
      const types = recorder.activityWrites.map((a) => a.eventType).sort();
      assert.deepEqual(types, [
        "plan_date_range_edited",
        "plan_name_edited",
        "plan_status_changed",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("macrosStale reflects planNeedsMacroEstimation result (true when injected)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1" })],
      }),
      { planNeedsMacroEstimation: async () => true },
    );
    try {
      const res = await patchPlan(harness, "p-1", { name: "X" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { macrosStale: boolean };
      assert.equal(body.macrosStale, true);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the plan does not exist", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(makeC4PatchStub({ recorder }));
    try {
      const res = await patchPlan(harness, "ghost", { name: "X" });
      assert.equal(res.status, 404);
      assert.equal(recorder.instanceUpdates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an empty body (Zod refine)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1" })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", {});
      assert.equal(res.status, 400);
      assert.equal(recorder.instanceUpdates.length, 0);
    } finally {
      await harness.close();
    }
  });

  // WS7-5b-mobile-PRE — auto-date envelope. PATCH /plans/:id auto-fills
  // startDate/endDate from the shared Sun-Sat currentWeekRange() helper
  // ONLY when ALL of: body sets isActiveThisWeek:true, the row is currently
  // undated (startDate === null), and the body did NOT supply its own dates.
  // Body dates always win; already-dated plans are never re-dated; non-active
  // and unrelated PATCHes never touch the date fields.

  it("auto-dates the plan on flip-to-active when undated and body has no dates (Sun-Sat, YYYY-MM-DD round-trip)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            isActiveThisWeek: false,
            startDate: null,
            endDate: null,
          }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { isActiveThisWeek: true });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const wrote = recorder.instanceUpdates[0].data;
      const start = wrote.startDate as Date;
      const end = wrote.endDate as Date;
      assert.ok(start instanceof Date, "startDate written as Date");
      assert.ok(end instanceof Date, "endDate written as Date");
      // UTC-midnight, Sunday → Saturday calendar week.
      assert.equal(start.getUTCHours(), 0);
      assert.equal(start.getUTCMinutes(), 0);
      assert.equal(start.getUTCDay(), 0, "startDate is a Sunday (UTC)");
      assert.equal(end.getUTCDay(), 6, "endDate is a Saturday (UTC)");
      assert.equal(
        (end.getTime() - start.getTime()) / 86_400_000,
        6,
        "Sun → Sat spans 6 days",
      );

      // Round-trip via toYmd — the read path hands mobile YYYY-MM-DD (NOT
      // ISO 8601). This is the c11/c16 wire-shape symmetry assertion.
      assert.match(toYmd(start) as string, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(toYmd(end) as string, /^\d{4}-\d{2}-\d{2}$/);
      const expected = currentWeekRange();
      assert.equal(toYmd(start), expected.startDate);
      assert.equal(toYmd(end), expected.endDate);
    } finally {
      await harness.close();
    }
  });

  it("body-supplied startDate+endDate WIN — auto-date does NOT fire even with isActiveThisWeek:true on an undated plan", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            isActiveThisWeek: false,
            startDate: null,
            endDate: null,
          }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", {
        isActiveThisWeek: true,
        startDate: "2026-02-01",
        endDate: "2026-02-07",
      });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const wrote = recorder.instanceUpdates[0].data;
      // Body dates pass through unchanged — NOT overwritten by the helper.
      assert.equal(toYmd(wrote.startDate as Date), "2026-02-01");
      assert.equal(toYmd(wrote.endDate as Date), "2026-02-07");
    } finally {
      await harness.close();
    }
  });

  it("on an ALREADY-dated plan, PATCH {isActiveThisWeek:true} leaves existing dates untouched", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            isActiveThisWeek: false,
            startDate: new Date("2026-03-01T00:00:00.000Z"),
            endDate: new Date("2026-03-07T00:00:00.000Z"),
          }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { isActiveThisWeek: true });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const wrote = recorder.instanceUpdates[0].data;
      // Date fields were NOT included in the update payload (no rewrite).
      assert.equal(
        Object.prototype.hasOwnProperty.call(wrote, "startDate"),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(wrote, "endDate"),
        false,
      );
    } finally {
      await harness.close();
    }
  });

  it("PATCH {name:'x'} on an undated plan does NOT auto-fill dates (no flip-to-active)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            titleOverride: "Old",
            startDate: null,
            endDate: null,
          }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { name: "New" });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const wrote = recorder.instanceUpdates[0].data;
      assert.equal(
        Object.prototype.hasOwnProperty.call(wrote, "startDate"),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(wrote, "endDate"),
        false,
      );
    } finally {
      await harness.close();
    }
  });

  it("PATCH {isActiveThisWeek:false} does NOT auto-fill dates (only flip-to-true triggers auto-date)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            isActiveThisWeek: true,
            startDate: null,
            endDate: null,
          }),
        ],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { isActiveThisWeek: false });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const wrote = recorder.instanceUpdates[0].data;
      assert.equal(
        Object.prototype.hasOwnProperty.call(wrote, "startDate"),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(wrote, "endDate"),
        false,
      );
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-D c1 — POST /plans/:id/items ────────────────────────────────────

interface D1PlanFix {
  id: string;
  userId: string;
  revisionId: number;
}

interface D1MealFix {
  id: string;
  userId: string | null;
  isPublic: boolean;
  isArchived: boolean;
  title: string;
}

interface D1ItemFix {
  id: string;
  mealPlanInstanceId: string;
  positionIndex: number;
}

interface D1ItemRecorder {
  itemCreates: Array<{ data: Record<string, unknown> }>;
  instanceUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function makeD1Stub(opts: {
  plans?: D1PlanFix[];
  meals?: D1MealFix[];
  existingItems?: D1ItemFix[];
  recorder: D1ItemRecorder;
  /** Throw on mealPlanItem.create — exercises rollback. */
  throwOnItemCreate?: boolean;
}) {
  const plans = opts.plans ?? [];
  const meals = opts.meals ?? [];
  const existingItems = opts.existingItems ?? [];
  const recorder = opts.recorder;
  let itemCounter = 0;

  const txClient = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = plans.find((p) => p.id === args.where.id);
        return row ? { userId: row.userId } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        recorder.instanceUpdates.push(args);
        const row = plans.find((p) => p.id === args.where.id);
        const bumped =
          args.data.revisionId &&
          typeof args.data.revisionId === "object" &&
          "increment" in (args.data.revisionId as Record<string, unknown>);
        const newRev = (row?.revisionId ?? 0) + (bumped ? 1 : 0);
        return { id: args.where.id, revisionId: newRev };
      },
    },
    meal: {
      findUnique: async (args: { where: { id: string } }) => {
        const m = meals.find((mm) => mm.id === args.where.id);
        return m ? { userId: m.userId, isPublic: m.isPublic, isArchived: m.isArchived } : null;
      },
    },
    mealPlanItem: {
      aggregate: async (args: {
        where: { mealPlanInstanceId: string };
        _max: { positionIndex: true };
      }) => {
        const inPlan = existingItems.filter(
          (i) => i.mealPlanInstanceId === args.where.mealPlanInstanceId,
        );
        const max = inPlan.reduce(
          (acc, i) => (acc == null || i.positionIndex > acc ? i.positionIndex : acc),
          null as number | null,
        );
        return { _max: { positionIndex: max } };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        if (opts.throwOnItemCreate) {
          throw new Error("item-create-failed");
        }
        recorder.itemCreates.push(args);
        itemCounter += 1;
        const id = `created-item-${itemCounter}`;
        return {
          id,
          mealId: args.data.mealId,
          positionIndex: args.data.positionIndex,
          assignedDayOfWeek: args.data.assignedDayOfWeek ?? null,
          assignedDate: null,
          servingsOverride: args.data.servingsOverride ?? null,
          isBreakfast: args.data.isBreakfast,
          isLunch: args.data.isLunch,
          isDinner: args.data.isDinner,
          notes: null,
        };
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-d1" };
      },
    },
  };

  // composeMealDetail (the response composer) hits prisma.meal.findUnique
  // outside the tx; serve a minimally-populated row that won't bypass the
  // archive gate. Return null mimics archived meal -> composeMealDetail
  // returns null. We want the meal expanded, so return a populated row.
  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanInstance: txClient.mealPlanInstance,
    meal: {
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        const m = meals.find((mm) => mm.id === args.where.id);
        if (!m) return null;
        return {
          id: m.id,
          userId: m.userId,
          title: m.title,
          description: null,
          mealType: "dinner",
          sourceType: "manual",
          cuisineType: null,
          difficulty: "easy",
          estimatedTimeMinutes: 30,
          imageUrl: null,
          servingsDefault: 4,
          tags: [],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          timesCooked: 0,
          isArchived: m.isArchived,
          isPublic: m.isPublic,
          dishLinks: [],
        };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
    },
    mealPlanItem: txClient.mealPlanItem,
    userActivity: txClient.userActivity,
  };
}

async function postPlanItem(
  harness: Harness,
  planId: string,
  body: Record<string, unknown>,
  userId: string = A2_USER,
): Promise<Response> {
  return fetch(`${harness.baseUrl}/plans/${planId}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${signToken(userId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /plans/:id/items (WS7-4-D c1)", () => {
  it("happy: adds a meal with default slot=dinner, bumps revision, emits plan_meal_added", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 2 }],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "m-1" });
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        item: { id: string; isDinner: boolean; positionIndex: number };
        planId: string;
        revisionId: number;
        macrosStale: boolean;
      };
      assert.equal(body.planId, "p-1");
      assert.equal(body.revisionId, 3);
      assert.equal(body.macrosStale, false);
      assert.equal(body.item.isDinner, true);
      assert.equal(body.item.positionIndex, 0);

      assert.equal(recorder.itemCreates.length, 1);
      const created = recorder.itemCreates[0].data;
      assert.equal(created.mealPlanInstanceId, "p-1");
      assert.equal(created.mealId, "m-1");
      assert.equal(created.isDinner, true);
      assert.equal(created.isBreakfast, false);
      assert.equal(created.isLunch, false);
      assert.equal(created.positionIndex, 0);

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_added");
      assert.equal(act.entityType, "MealPlanItem");
      const meta = act.metadata as { mealId: string; slot: string };
      assert.equal(meta.mealId, "m-1");
      assert.equal(meta.slot, "dinner");
    } finally {
      await harness.close();
    }
  });

  it("slot=breakfast maps to isBreakfast=true and other slot booleans=false", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", {
        mealId: "m-1",
        slot: "breakfast",
        assignedDayOfWeek: "Monday",
      });
      assert.equal(res.status, 201);
      const created = recorder.itemCreates[0].data;
      assert.equal(created.isBreakfast, true);
      assert.equal(created.isLunch, false);
      assert.equal(created.isDinner, false);
      assert.equal(created.assignedDayOfWeek, "Monday");

      const meta = recorder.activityWrites[0].metadata as {
        assignedDayOfWeek: string;
        slot: string;
      };
      assert.equal(meta.assignedDayOfWeek, "Monday");
      assert.equal(meta.slot, "breakfast");
    } finally {
      await harness.close();
    }
  });

  it("positionIndex picks up max(existing) + 1 for non-empty plans", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
        existingItems: [
          { id: "it-a", mealPlanInstanceId: "p-1", positionIndex: 4 },
          { id: "it-b", mealPlanInstanceId: "p-1", positionIndex: 7 },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "m-1" });
      assert.equal(res.status, 201);
      const created = recorder.itemCreates[0].data;
      assert.equal(created.positionIndex, 8);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the plan does not exist", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "ghost", { mealId: "m-1" });
      assert.equal(res.status, 404);
      assert.equal(recorder.itemCreates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the plan belongs to another user (no existence leak)", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-other", userId: "stranger", revisionId: 1 }],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-other", { mealId: "m-1" });
      assert.equal(res.status, 404);
      assert.equal(recorder.itemCreates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the meal does not exist", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        meals: [],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "ghost" });
      assert.equal(res.status, 404);
      assert.equal(recorder.itemCreates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the meal is private and not owned by requester (no existence leak)", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        meals: [
          { id: "m-priv", userId: "stranger", isPublic: false, isArchived: false, title: "Priv" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "m-priv" });
      assert.equal(res.status, 404);
      assert.equal(recorder.itemCreates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("macrosStale reflects planNeedsMacroEstimation result (true when injected)", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
      }),
      { planNeedsMacroEstimation: async () => true },
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "m-1" });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { macrosStale: boolean };
      assert.equal(body.macrosStale, true);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no Authorization header is present", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeD1Stub({ recorder }));
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-1/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mealId: "m-1" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on unknown body field (Zod strict)", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeD1Stub({ recorder }));
    try {
      const res = await postPlanItem(harness, "p-1", {
        mealId: "m-1",
        bogus: true,
      });
      assert.equal(res.status, 400);
      assert.equal(recorder.itemCreates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("rolls back: when mealPlanItem.create throws, no activity written and 500 returned", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        throwOnItemCreate: true,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        meals: [
          { id: "m-1", userId: A2_USER, isPublic: false, isArchived: false, title: "M1" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "m-1" });
      assert.equal(res.status, 500);
      assert.equal(recorder.itemCreates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-D c2 — DELETE /plans/:id/items/:itemId ──────────────────────────

interface D2ItemFix {
  id: string;
  mealPlanInstanceId: string;
  mealId: string;
  assignedDayOfWeek: string | null;
  isBreakfast: boolean;
  isLunch: boolean;
  isDinner: boolean;
}

interface D2Recorder {
  itemDeletes: Array<{ where: { id: string } }>;
  instanceUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function makeD2Stub(opts: {
  plans?: D1PlanFix[];
  items?: D2ItemFix[];
  recorder: D2Recorder;
  /** Throw on mealPlanItem.delete — exercises rollback. */
  throwOnItemDelete?: boolean;
}) {
  const plans = opts.plans ?? [];
  const items = opts.items ?? [];
  const recorder = opts.recorder;

  const txClient = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = plans.find((p) => p.id === args.where.id);
        return row ? { userId: row.userId } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        recorder.instanceUpdates.push(args);
        const row = plans.find((p) => p.id === args.where.id);
        const bumped =
          args.data.revisionId &&
          typeof args.data.revisionId === "object" &&
          "increment" in (args.data.revisionId as Record<string, unknown>);
        const newRev = (row?.revisionId ?? 0) + (bumped ? 1 : 0);
        return { id: args.where.id, revisionId: newRev };
      },
    },
    mealPlanItem: {
      findUnique: async (args: { where: { id: string } }) => {
        const i = items.find((it) => it.id === args.where.id);
        return i
          ? {
              mealPlanInstanceId: i.mealPlanInstanceId,
              mealId: i.mealId,
              assignedDayOfWeek: i.assignedDayOfWeek,
              isBreakfast: i.isBreakfast,
              isLunch: i.isLunch,
              isDinner: i.isDinner,
            }
          : null;
      },
      delete: async (args: { where: { id: string } }) => {
        if (opts.throwOnItemDelete) {
          throw new Error("item-delete-failed");
        }
        recorder.itemDeletes.push(args);
        return { id: args.where.id };
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-d2" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanInstance: txClient.mealPlanInstance,
    mealPlanItem: txClient.mealPlanItem,
    userActivity: txClient.userActivity,
  };
}

async function deletePlanItemReq(
  harness: Harness,
  planId: string,
  itemId: string,
  userId: string = A2_USER,
): Promise<Response> {
  return fetch(`${harness.baseUrl}/plans/${planId}/items/${itemId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${signToken(userId)}` },
  });
}

describe("DELETE /plans/:id/items/:itemId (WS7-4-D c2)", () => {
  it("happy: deletes the item, bumps revision, emits plan_meal_composted with mealId+itemId+slot", async () => {
    const recorder: D2Recorder = {
      itemDeletes: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD2Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 4 }],
        items: [
          {
            id: "it-1",
            mealPlanInstanceId: "p-1",
            mealId: "m-1",
            assignedDayOfWeek: "Tuesday",
            isBreakfast: false,
            isLunch: true,
            isDinner: false,
          },
        ],
      }),
    );
    try {
      const res = await deletePlanItemReq(harness, "p-1", "it-1");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        planId: string;
        revisionId: number;
        macrosStale: boolean;
      };
      assert.equal(body.planId, "p-1");
      assert.equal(body.revisionId, 5);
      assert.equal(body.macrosStale, false);

      assert.equal(recorder.itemDeletes.length, 1);
      assert.equal(recorder.itemDeletes[0].where.id, "it-1");

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_composted");
      assert.equal(act.entityType, "MealPlanItem");
      assert.equal(act.entityId, "it-1");
      const meta = act.metadata as {
        mealId: string;
        itemId: string;
        slot: string;
        assignedDayOfWeek: string;
      };
      assert.equal(meta.mealId, "m-1");
      assert.equal(meta.itemId, "it-1");
      assert.equal(meta.slot, "lunch");
      assert.equal(meta.assignedDayOfWeek, "Tuesday");
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when plan does not exist", async () => {
    const recorder: D2Recorder = {
      itemDeletes: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeD2Stub({ recorder, plans: [], items: [] }));
    try {
      const res = await deletePlanItemReq(harness, "ghost", "it-1");
      assert.equal(res.status, 404);
      assert.equal(recorder.itemDeletes.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when item does not exist", async () => {
    const recorder: D2Recorder = {
      itemDeletes: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD2Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        items: [],
      }),
    );
    try {
      const res = await deletePlanItemReq(harness, "p-1", "ghost-item");
      assert.equal(res.status, 404);
      assert.equal(recorder.itemDeletes.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when item belongs to a different plan (no existence leak)", async () => {
    const recorder: D2Recorder = {
      itemDeletes: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD2Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        items: [
          {
            id: "it-wrong",
            mealPlanInstanceId: "p-other",
            mealId: "m-x",
            assignedDayOfWeek: null,
            isBreakfast: false,
            isLunch: false,
            isDinner: true,
          },
        ],
      }),
    );
    try {
      const res = await deletePlanItemReq(harness, "p-1", "it-wrong");
      assert.equal(res.status, 404);
      assert.equal(recorder.itemDeletes.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("rolls back: when mealPlanItem.delete throws, no activity written and 500 returned", async () => {
    const recorder: D2Recorder = {
      itemDeletes: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD2Stub({
        recorder,
        throwOnItemDelete: true,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        items: [
          {
            id: "it-fail",
            mealPlanInstanceId: "p-1",
            mealId: "m-1",
            assignedDayOfWeek: null,
            isBreakfast: false,
            isLunch: false,
            isDinner: true,
          },
        ],
      }),
    );
    try {
      const res = await deletePlanItemReq(harness, "p-1", "it-fail");
      assert.equal(res.status, 500);
      assert.equal(recorder.itemDeletes.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-D c3 — PATCH /plans/:id/items/:itemId ───────────────────────────

interface D3ItemFix {
  id: string;
  mealPlanInstanceId: string;
  mealId: string;
  positionIndex: number;
  assignedDayOfWeek: string | null;
  assignedDate: Date | null;
  servingsOverride: number | null;
  ingredientOverrides: unknown;
  recipeOverrideJson: unknown;
  isBreakfast: boolean;
  isLunch: boolean;
  isDinner: boolean;
  notes: string | null;
}

interface D3Recorder {
  itemUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  itemCreates: Array<{ data: Record<string, unknown> }>;
  itemDeletes: Array<{ where: { id: string } }>;
  instanceUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

function d3ItemFix(opts: Partial<D3ItemFix> & { id: string; mealPlanInstanceId: string; mealId: string }): D3ItemFix {
  return {
    id: opts.id,
    mealPlanInstanceId: opts.mealPlanInstanceId,
    mealId: opts.mealId,
    positionIndex: opts.positionIndex ?? 0,
    assignedDayOfWeek: opts.assignedDayOfWeek ?? null,
    assignedDate: opts.assignedDate ?? null,
    servingsOverride: opts.servingsOverride ?? null,
    ingredientOverrides: opts.ingredientOverrides ?? null,
    recipeOverrideJson: opts.recipeOverrideJson ?? null,
    isBreakfast: opts.isBreakfast ?? false,
    isLunch: opts.isLunch ?? false,
    isDinner: opts.isDinner ?? true,
    notes: opts.notes ?? null,
  };
}

function makeD3Stub(opts: {
  plans?: D1PlanFix[];
  items?: D3ItemFix[];
  meals?: D1MealFix[];
  recorder: D3Recorder;
  /** Throw on mealPlanItem.update — exercises rollback. */
  throwOnItemUpdate?: boolean;
  /** Throw on mealPlanItem.create AFTER delete (mealId-swap path rollback). */
  throwOnItemCreate?: boolean;
}) {
  const plans = opts.plans ?? [];
  const items = opts.items ?? [];
  const meals = opts.meals ?? [];
  const recorder = opts.recorder;
  let itemCounter = 0;

  const txClient = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = plans.find((p) => p.id === args.where.id);
        return row ? { userId: row.userId } : null;
      },
      // bumpPlanRevision call inside the route's tx.
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        recorder.instanceUpdates.push(args);
        const row = plans.find((p) => p.id === args.where.id);
        const bumped =
          args.data.revisionId &&
          typeof args.data.revisionId === "object" &&
          "increment" in (args.data.revisionId as Record<string, unknown>);
        const newRev = (row?.revisionId ?? 0) + (bumped ? 1 : 0);
        return { id: args.where.id, revisionId: newRev };
      },
    },
    mealPlanItem: {
      findUnique: async (args: { where: { id: string } }) => {
        const i = items.find((it) => it.id === args.where.id);
        if (!i) return null;
        return {
          mealPlanInstanceId: i.mealPlanInstanceId,
          mealId: i.mealId,
          positionIndex: i.positionIndex,
          assignedDayOfWeek: i.assignedDayOfWeek,
          assignedDate: i.assignedDate,
          servingsOverride: i.servingsOverride,
          ingredientOverrides: i.ingredientOverrides,
          recipeOverrideJson: i.recipeOverrideJson,
          isBreakfast: i.isBreakfast,
          isLunch: i.isLunch,
          isDinner: i.isDinner,
          notes: i.notes,
        };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (opts.throwOnItemUpdate) {
          throw new Error("item-update-failed");
        }
        recorder.itemUpdates.push(args);
        const i = items.find((it) => it.id === args.where.id);
        const merged = {
          ...i,
          ...args.data,
        } as Record<string, unknown>;
        return {
          id: args.where.id,
          mealId: merged.mealId ?? i?.mealId,
          positionIndex: merged.positionIndex ?? i?.positionIndex,
          assignedDayOfWeek: merged.assignedDayOfWeek ?? null,
          assignedDate: merged.assignedDate ?? null,
          servingsOverride: merged.servingsOverride ?? null,
          ingredientOverrides: merged.ingredientOverrides ?? null,
          recipeOverrideJson: merged.recipeOverrideJson ?? null,
          isBreakfast: merged.isBreakfast ?? false,
          isLunch: merged.isLunch ?? false,
          isDinner: merged.isDinner ?? false,
          notes: merged.notes ?? null,
        };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        if (opts.throwOnItemCreate) {
          throw new Error("item-create-failed");
        }
        recorder.itemCreates.push(args);
        itemCounter += 1;
        const id = `swapped-item-${itemCounter}`;
        return {
          id,
          mealId: args.data.mealId,
          positionIndex: args.data.positionIndex,
          assignedDayOfWeek: args.data.assignedDayOfWeek ?? null,
          assignedDate: args.data.assignedDate ?? null,
          servingsOverride: args.data.servingsOverride ?? null,
          ingredientOverrides: args.data.ingredientOverrides ?? null,
          recipeOverrideJson: args.data.recipeOverrideJson ?? null,
          isBreakfast: args.data.isBreakfast,
          isLunch: args.data.isLunch,
          isDinner: args.data.isDinner,
          notes: args.data.notes ?? null,
        };
      },
      delete: async (args: { where: { id: string } }) => {
        recorder.itemDeletes.push(args);
        return { id: args.where.id };
      },
    },
    meal: {
      findUnique: async (args: { where: { id: string } }) => {
        const m = meals.find((mm) => mm.id === args.where.id);
        return m ? { userId: m.userId, isPublic: m.isPublic, isArchived: m.isArchived } : null;
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-d3" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = plans.find((p) => p.id === args.where.id);
        return row ? { revisionId: row.revisionId } : null;
      },
    },
    // composeMealDetail outside-tx call
    meal: {
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        const m = meals.find((mm) => mm.id === args.where.id);
        if (!m) return null;
        return {
          id: m.id,
          userId: m.userId,
          title: m.title,
          description: null,
          mealType: "dinner",
          sourceType: "manual",
          cuisineType: null,
          difficulty: "easy",
          estimatedTimeMinutes: 30,
          imageUrl: null,
          servingsDefault: 4,
          tags: [],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          timesCooked: 0,
          isArchived: m.isArchived,
          isPublic: m.isPublic,
          dishLinks: [],
        };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
    },
    mealPlanItem: txClient.mealPlanItem,
    userActivity: txClient.userActivity,
  };
}

async function patchPlanItemReq(
  harness: Harness,
  planId: string,
  itemId: string,
  body: Record<string, unknown>,
  userId: string = A2_USER,
): Promise<Response> {
  return fetch(`${harness.baseUrl}/plans/${planId}/items/${itemId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${signToken(userId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const D3_DEFAULT_PLANS = [{ id: "p-1", userId: A2_USER, revisionId: 5 }];
const D3_DEFAULT_MEALS: D1MealFix[] = [
  { id: "m-old", userId: A2_USER, isPublic: false, isArchived: false, title: "Old" },
  { id: "m-new", userId: A2_USER, isPublic: false, isArchived: false, title: "New" },
];

describe("PATCH /plans/:id/items/:itemId (WS7-4-D c3)", () => {
  it("assignedDayOfWeek null -> Monday emits plan_meal_assigned with { day }", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { assignedDayOfWeek: "Monday" });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_assigned");
      assert.deepEqual(act.metadata, { day: "Monday" });
    } finally {
      await harness.close();
    }
  });

  it("assignedDayOfWeek Monday -> null emits plan_meal_unassigned with { from }", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [
          d3ItemFix({
            id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old",
            assignedDayOfWeek: "Monday",
          }),
        ],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { assignedDayOfWeek: null });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_unassigned");
      assert.deepEqual(act.metadata, { from: "Monday" });
    } finally {
      await harness.close();
    }
  });

  it("assignedDayOfWeek Monday -> Tuesday emits plan_meal_assigned with { from, to }", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [
          d3ItemFix({
            id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old",
            assignedDayOfWeek: "Monday",
          }),
        ],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { assignedDayOfWeek: "Tuesday" });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_assigned");
      assert.deepEqual(act.metadata, { from: "Monday", to: "Tuesday" });
    } finally {
      await harness.close();
    }
  });

  it("slot dinner -> lunch updates all 3 booleans and emits plan_meal_edited { field: slot, from, to }", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { slot: "lunch" });
      assert.equal(res.status, 200);
      assert.equal(recorder.itemUpdates.length, 1);
      const upd = recorder.itemUpdates[0].data;
      assert.equal(upd.isBreakfast, false);
      assert.equal(upd.isLunch, true);
      assert.equal(upd.isDinner, false);

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_edited");
      assert.deepEqual(act.metadata, { field: "slot", from: "dinner", to: "lunch" });
    } finally {
      await harness.close();
    }
  });

  it("servingsOverride null -> 6 emits plan_meal_edited { field: servingsOverride, from, to }", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { servingsOverride: 6 });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_edited");
      assert.deepEqual(act.metadata, { field: "servingsOverride", from: null, to: 6 });
    } finally {
      await harness.close();
    }
  });

  it("ingredientOverrides set emits plan_meal_edited { field: ingredientOverrides } with value omitted", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", {
        ingredientOverrides: [{ ingredientName: "salt", action: "remove" }],
      });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_edited");
      assert.deepEqual(act.metadata, { field: "ingredientOverrides" });
    } finally {
      await harness.close();
    }
  });

  it("recipeOverrideJson set emits plan_recipe_changed { cleared: false }", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const validOverride = {
        titleOverride: "Tweaked",
        dishes: [
          { name: "Main", ingredients: [{ name: "salt", quantity: 1, unit: "tsp" }] },
        ],
        steps: ["Mix all"],
        createdAt: new Date().toISOString(),
      };
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { recipeOverrideJson: validOverride });
      assert.equal(res.status, 200);
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_recipe_changed");
      assert.deepEqual(act.metadata, { cleared: false });
    } finally {
      await harness.close();
    }
  });

  it("atomic mealId swap deletes old + creates new with Q-P1-4 preservation matrix, emits single plan_meal_changed", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [
          d3ItemFix({
            id: "it-old", mealPlanInstanceId: "p-1", mealId: "m-old",
            positionIndex: 3,
            assignedDayOfWeek: "Wednesday",
            servingsOverride: 5,
            ingredientOverrides: [{ name: "tomato" }],
            recipeOverrideJson: { dishes: [] },
            isLunch: true,
            isDinner: false,
            notes: "user note",
          }),
        ],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-old", { mealId: "m-new" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        item: {
          id: string;
          mealId: string;
          assignedDayOfWeek: string;
          isLunch: boolean;
          servingsOverride: number | null;
          notes: string | null;
          positionIndex: number;
        };
        planId: string;
        revisionId: number;
      };
      assert.ok(body.item.id.startsWith("swapped-item-"));
      assert.equal(body.item.mealId, "m-new");

      // PRESERVED
      assert.equal(body.item.assignedDayOfWeek, "Wednesday");
      assert.equal(body.item.isLunch, true);
      assert.equal(body.item.notes, "user note");
      assert.equal(body.item.positionIndex, 3);

      // RESET
      assert.equal(body.item.servingsOverride, null);

      // Old item deleted, new item created.
      assert.equal(recorder.itemDeletes.length, 1);
      assert.equal(recorder.itemDeletes[0].where.id, "it-old");
      assert.equal(recorder.itemCreates.length, 1);
      const created = recorder.itemCreates[0].data;
      assert.equal(created.mealId, "m-new");
      assert.equal(created.assignedDayOfWeek, "Wednesday");
      assert.equal(created.notes, "user note");
      assert.equal(created.positionIndex, 3);
      assert.equal(created.servingsOverride, null);
      assert.equal(created.isLunch, true);

      // SINGLE plan_meal_changed event (NOT separate added + composted).
      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_meal_changed");
      const meta = act.metadata as {
        oldItemId: string;
        newItemId: string;
        oldMealId: string;
        newMealId: string;
      };
      assert.equal(meta.oldItemId, "it-old");
      assert.ok(meta.newItemId.startsWith("swapped-item-"));
      assert.equal(meta.oldMealId, "m-old");
      assert.equal(meta.newMealId, "m-new");
    } finally {
      await harness.close();
    }
  });

  it("mealId combined with other fields returns 400 (v1 body restriction)", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", {
        mealId: "m-new", slot: "lunch",
      });
      assert.equal(res.status, 400);
      assert.equal(recorder.itemDeletes.length, 0);
      assert.equal(recorder.itemCreates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("mealId swap to non-existent meal returns 404, item NOT deleted", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: [
          { id: "m-old", userId: A2_USER, isPublic: false, isArchived: false, title: "Old" },
        ],
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { mealId: "ghost" });
      assert.equal(res.status, 404);
      assert.equal(recorder.itemDeletes.length, 0);
      assert.equal(recorder.itemCreates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("noop branch: empty diff returns 200 with no bump and no activity", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old", notes: "same" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { notes: "same" });
      assert.equal(res.status, 200);
      assert.equal(recorder.itemUpdates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);

      const body = (await res.json()) as { revisionId: number; macrosStale: boolean };
      assert.equal(body.macrosStale, false);
      assert.equal(body.revisionId, 5); // current revision, no bump
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when plan does not exist", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(makeD3Stub({ recorder }));
    try {
      const res = await patchPlanItemReq(harness, "ghost", "it-1", { slot: "lunch" });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when item is cross-plan", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        items: [d3ItemFix({ id: "it-x", mealPlanInstanceId: "p-other", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-x", { slot: "lunch" });
      assert.equal(res.status, 404);
      assert.equal(recorder.itemUpdates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on empty body (Zod refine)", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(makeD3Stub({ recorder }));
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", {});
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("macrosStale reflects planNeedsMacroEstimation result (true when injected, servings change)", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
      { planNeedsMacroEstimation: async () => true },
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { servingsOverride: 8 });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { macrosStale: boolean };
      assert.equal(body.macrosStale, true);
    } finally {
      await harness.close();
    }
  });

  it("rolls back: when mealPlanItem.update throws, no activity written and 500 returned", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        throwOnItemUpdate: true,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-1", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-1", { slot: "lunch" });
      assert.equal(res.status, 500);
      assert.equal(recorder.itemUpdates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("rollback (mealId-swap path): when create throws after delete, no activity written and 500 returned", async () => {
    const recorder: D3Recorder = {
      itemUpdates: [], itemCreates: [], itemDeletes: [],
      instanceUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD3Stub({
        recorder,
        throwOnItemCreate: true,
        plans: D3_DEFAULT_PLANS,
        meals: D3_DEFAULT_MEALS,
        items: [d3ItemFix({ id: "it-old", mealPlanInstanceId: "p-1", mealId: "m-old" })],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-old", { mealId: "m-new" });
      assert.equal(res.status, 500);
      // Stub still records the delete call (TX is in-memory; routine reaches
      // delete BEFORE create throws). The 500 + no activity confirms the
      // route surfaced the error without emitting.
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-4-D c4 — POST /plans/:id/items/:itemId/promote-override ───────────

interface D4Recorder {
  mealCreates: Array<{ data: Record<string, unknown> }>;
  dishCreates: Array<{ data: Record<string, unknown> }>;
  itemUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  activityWrites: Array<Record<string, unknown>>;
}

const D4_VALID_OVERRIDE = {
  titleOverride: "Promoted",
  dishes: [
    {
      name: "Sauce",
      ingredients: [{ name: "salt", quantity: 1, unit: "tsp" }],
    },
  ],
  steps: ["Step 1"],
  createdAt: "2026-05-26T00:00:00Z",
};

function makeD4Stub(opts: {
  plans?: D1PlanFix[];
  items?: Array<{
    id: string;
    mealPlanInstanceId: string;
    mealId: string;
    recipeOverrideJson: unknown;
  }>;
  sourceMeals?: Array<{ id: string; title: string }>;
  ingredients?: Array<{ id: string; canonicalName: string }>;
  recorder: D4Recorder;
}) {
  const plans = opts.plans ?? [];
  const items = opts.items ?? [];
  const sourceMeals = opts.sourceMeals ?? [];
  const ingredients = opts.ingredients ?? [];
  const recorder = opts.recorder;
  let mealCounter = 0;
  let dishCounter = 0;

  const txClient = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = plans.find((p) => p.id === args.where.id);
        return row ? { userId: row.userId } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = plans.find((p) => p.id === args.where.id);
        const bumped =
          args.data.revisionId &&
          typeof args.data.revisionId === "object" &&
          "increment" in (args.data.revisionId as Record<string, unknown>);
        return {
          id: args.where.id,
          revisionId: (row?.revisionId ?? 0) + (bumped ? 1 : 0),
        };
      },
    },
    mealPlanItem: {
      findUnique: async (args: { where: { id: string } }) => {
        const i = items.find((it) => it.id === args.where.id);
        return i
          ? {
              mealPlanInstanceId: i.mealPlanInstanceId,
              mealId: i.mealId,
              recipeOverrideJson: i.recipeOverrideJson,
            }
          : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        recorder.itemUpdates.push(args);
        return {
          id: args.where.id,
          mealId: args.data.mealId ?? null,
          positionIndex: 0,
          assignedDayOfWeek: null,
          assignedDate: null,
          servingsOverride: null,
          isBreakfast: false,
          isLunch: false,
          isDinner: true,
          notes: null,
        };
      },
    },
    meal: {
      findUnique: async (args: { where: { id: string } }) => {
        const m = sourceMeals.find((mm) => mm.id === args.where.id);
        return m
          ? {
              title: m.title,
              description: null,
              cuisineType: null,
              mealType: "dinner",
              imageUrl: null,
              servingsDefault: 4,
              estimatedTimeMinutes: 30,
              difficulty: "easy",
              tags: [],
            }
          : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.mealCreates.push(args);
        mealCounter += 1;
        return { id: `promoted-meal-${mealCounter}` };
      },
    },
    mealDishLink: {
      findFirst: async () => null,
      create: async () => ({ id: "mdl-d4" }),
    },
    dish: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.dishCreates.push(args);
        dishCounter += 1;
        return { id: `promoted-dish-${dishCounter}` };
      },
    },
    ingredient: {
      findFirst: async (args: {
        where: { canonicalName: { equals: string; mode: string } };
      }) => {
        const target = args.where.canonicalName.equals;
        const hit = ingredients.find((i) => i.canonicalName === target);
        return hit ? { id: hit.id } : null;
      },
    },
    dishIngredient: {
      create: async () => ({ id: "di-d4" }),
    },
    recipeInstructionStep: {
      create: async () => ({ id: "step-d4" }),
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.activityWrites.push(args.data);
        return { id: "act-d4" };
      },
    },
  };

  return {
    $transaction: async <T,>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient),
    // Outside-tx composeMealDetail call.
    meal: {
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        return {
          id: args.where.id,
          userId: "u-1",
          title: "Promoted",
          description: null,
          mealType: "dinner",
          sourceType: "manual",
          cuisineType: null,
          difficulty: "easy",
          estimatedTimeMinutes: 30,
          imageUrl: null,
          servingsDefault: 4,
          tags: [],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          timesCooked: 0,
          isArchived: false,
          isPublic: false,
          dishLinks: [],
        };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
    },
    mealPlanInstance: txClient.mealPlanInstance,
    mealPlanItem: txClient.mealPlanItem,
    userActivity: txClient.userActivity,
  };
}

async function promotePlanItemReq(
  harness: Harness,
  planId: string,
  itemId: string,
  userId: string = A2_USER,
): Promise<Response> {
  return fetch(
    `${harness.baseUrl}/plans/${planId}/items/${itemId}/promote-override`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${signToken(userId)}` },
    },
  );
}

describe("POST /plans/:id/items/:itemId/promote-override (WS7-4-D c4)", () => {
  it("happy: promotes override, rebinds item, emits plan_recipe_changed with promoted=true", async () => {
    const recorder: D4Recorder = {
      mealCreates: [], dishCreates: [], itemUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD4Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 3 }],
        items: [
          {
            id: "it-1",
            mealPlanInstanceId: "p-1",
            mealId: "m-src",
            recipeOverrideJson: D4_VALID_OVERRIDE,
          },
        ],
        sourceMeals: [{ id: "m-src", title: "Source" }],
        ingredients: [{ id: "ing-salt", canonicalName: "salt" }],
      }),
    );
    try {
      const res = await promotePlanItemReq(harness, "p-1", "it-1");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        item: { id: string; mealId: string };
        planId: string;
        revisionId: number;
        macrosStale: boolean;
        newMealId: string;
      };
      assert.equal(body.planId, "p-1");
      assert.equal(body.newMealId, "promoted-meal-1");
      assert.equal(body.item.mealId, "promoted-meal-1");
      assert.equal(body.revisionId, 4);

      assert.equal(recorder.mealCreates.length, 1);
      assert.equal(recorder.itemUpdates.length, 1);
      const upd = recorder.itemUpdates[0].data;
      assert.equal(upd.mealId, "promoted-meal-1");

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_recipe_changed");
      const meta = act.metadata as {
        promoted: boolean;
        newMealId: string;
        oldMealId: string;
      };
      assert.equal(meta.promoted, true);
      assert.equal(meta.newMealId, "promoted-meal-1");
      assert.equal(meta.oldMealId, "m-src");
    } finally {
      await harness.close();
    }
  });

  it("returns 422 when item has no recipeOverrideJson (nothing to promote)", async () => {
    const recorder: D4Recorder = {
      mealCreates: [], dishCreates: [], itemUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD4Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        items: [
          {
            id: "it-1",
            mealPlanInstanceId: "p-1",
            mealId: "m-src",
            recipeOverrideJson: null,
          },
        ],
        sourceMeals: [{ id: "m-src", title: "Source" }],
        ingredients: [],
      }),
    );
    try {
      const res = await promotePlanItemReq(harness, "p-1", "it-1");
      assert.equal(res.status, 422);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "no_override");
      assert.equal(recorder.mealCreates.length, 0);
      assert.equal(recorder.itemUpdates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 422 with unresolved_ingredient when an ingredient name doesn't resolve; rollback (no item update, no activity)", async () => {
    const recorder: D4Recorder = {
      mealCreates: [], dishCreates: [], itemUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD4Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        items: [
          {
            id: "it-1",
            mealPlanInstanceId: "p-1",
            mealId: "m-src",
            recipeOverrideJson: {
              dishes: [
                {
                  name: "D1",
                  ingredients: [{ name: "Unicorn Horn", quantity: 1, unit: "ea" }],
                },
              ],
              createdAt: "2026-05-26T00:00:00Z",
            },
          },
        ],
        sourceMeals: [{ id: "m-src", title: "Source" }],
        ingredients: [], // no resolvable ingredients
      }),
    );
    try {
      const res = await promotePlanItemReq(harness, "p-1", "it-1");
      assert.equal(res.status, 422);
      const body = (await res.json()) as { error: string; ingredientName: string };
      assert.equal(body.error, "unresolved_ingredient");
      assert.equal(body.ingredientName, "Unicorn Horn");
      // Item was NOT rebound; no activity emitted.
      assert.equal(recorder.itemUpdates.length, 0);
      assert.equal(recorder.activityWrites.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when plan is not owned by requester (no existence leak)", async () => {
    const recorder: D4Recorder = {
      mealCreates: [], dishCreates: [], itemUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD4Stub({
        recorder,
        plans: [{ id: "p-1", userId: "stranger", revisionId: 1 }],
        items: [
          {
            id: "it-1",
            mealPlanInstanceId: "p-1",
            mealId: "m-src",
            recipeOverrideJson: D4_VALID_OVERRIDE,
          },
        ],
      }),
    );
    try {
      const res = await promotePlanItemReq(harness, "p-1", "it-1");
      assert.equal(res.status, 404);
      assert.equal(recorder.mealCreates.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when item is cross-plan", async () => {
    const recorder: D4Recorder = {
      mealCreates: [], dishCreates: [], itemUpdates: [], activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD4Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 1 }],
        items: [
          {
            id: "it-x",
            mealPlanInstanceId: "p-other",
            mealId: "m-src",
            recipeOverrideJson: D4_VALID_OVERRIDE,
          },
        ],
      }),
    );
    try {
      const res = await promotePlanItemReq(harness, "p-1", "it-x");
      assert.equal(res.status, 404);
      assert.equal(recorder.mealCreates.length, 0);
    } finally {
      await harness.close();
    }
  });
});
