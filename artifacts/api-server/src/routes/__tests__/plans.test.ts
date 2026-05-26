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
        instances: [fixturePatch({ id: "p-1", isActiveThisWeek: false })],
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
});
