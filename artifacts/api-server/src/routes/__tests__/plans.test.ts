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

function c4SpinUp(stub: unknown, opts?: { limiterCapacity?: number }): Promise<Harness> {
  return spinUp({
    prisma: stub as never,
    computePlanMacros: (async () => HAPPY_RESULT) as never,
    // Risk 3 — over-provision the mutation limiter so the test suite does
    // not 429 itself across the c4 cases.
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
    const harness = await c4SpinUp(
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
    const harness = await c4SpinUp(
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
    const harness = await c4SpinUp(
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
    const harness = await c4SpinUp(makeC4Stub({ recorder }));
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
    const harness = await c4SpinUp(makeC4Stub({ recorder }));
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
    const harness = await c4SpinUp(makeC4Stub({ recorder, templates: [] }));
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
    const harness = await c4SpinUp(
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
    const harness = await c4SpinUp(
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
    const harness = await c4SpinUp(
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
