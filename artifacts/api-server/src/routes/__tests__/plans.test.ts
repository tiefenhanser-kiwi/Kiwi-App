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
import { currentWeekRange, resolveThisWeekPlan } from "../../lib/planDates";
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
  // WS7-6 (E) Block 1 REWORK — resolver tiebreak fields.
  activatedAt?: Date | null;
  isWizardDraft?: boolean;
  createdAt?: Date;
  startDate?: Date | null;
  endDate?: Date | null;
  prepStatus?: "not_prepped" | "partial" | "prepped";
  prepStatusIsManual?: boolean;
  // WS7-8a B3 — checked stepKeys for this plan (drives the per-meal derivation;
  // the step set itself comes from the injected loadPrepStepSet stub).
  completions?: string[];
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
    activatedAt: opts.activatedAt ?? null,
    isWizardDraft: opts.isWizardDraft ?? false,
    revisionId: 2,
    prepStatus: opts.prepStatus ?? "not_prepped",
    prepStatusIsManual: opts.prepStatusIsManual ?? false,
    _completions: opts.completions ?? [],
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
      // WS7-6 (E) Block 1 REWORK — findMany is dual-purpose:
      //   (a) full-row my_plans list (no select, with include) — returned
      //       as full instance fixtures sorted createdAt DESC;
      //   (b) narrow covering-set query for resolveThisWeekWinnerId
      //       (select: {id,startDate,endDate,activatedAt,createdAt} +
      //        where: {userId, isWizardDraft:false, startDate.lte/not:null,
      //        endDate.gte/not:null}) — returned as the projected scalars.
      // The branch is detected by the presence of select.activatedAt.
      findMany: async (args: {
        where: {
          userId: string;
          isArchived?: boolean;
          isWizardDraft?: boolean;
          startDate?: { lte: Date; not?: null };
          endDate?: { gte: Date; not?: null };
        };
        select?: {
          id?: boolean;
          startDate?: boolean;
          endDate?: boolean;
          activatedAt?: boolean;
          createdAt?: boolean;
        };
      }) => {
        if (args.select?.activatedAt) {
          // Narrow covering-subset query — the resolver's only DB read.
          return instances
            .filter((i) => {
              if (i.userId !== args.where.userId) return false;
              if (args.where.isWizardDraft !== undefined && i.isWizardDraft !== args.where.isWizardDraft) return false;
              if (args.where.startDate?.lte) {
                if (i.startDate === null) return false;
                if (i.startDate.getTime() > args.where.startDate.lte.getTime()) return false;
              }
              if (args.where.endDate?.gte) {
                if (i.endDate === null) return false;
                if (i.endDate.getTime() < args.where.endDate.gte.getTime()) return false;
              }
              return true;
            })
            .map((i) => ({
              id: i.id,
              startDate: i.startDate,
              endDate: i.endDate,
              activatedAt: i.activatedAt,
              createdAt: i.createdAt,
            }));
        }
        // Default branch — my_plans list (full hydration).
        return instances
          .filter((i) => {
            if (i.userId !== args.where.userId) return false;
            if (args.where.isWizardDraft !== undefined && i.isWizardDraft !== args.where.isWizardDraft) return false;
            return true;
          })
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      findUnique: async (args: { where: { id: string } }) =>
        instances.find((i) => i.id === args.where.id) ?? null,
    },
    // WS7-8a B3 — GET /plans/:id reads completion rows for the per-meal
    // derivation. Keyed off the fixture's _completions (default none).
    prepStepCompletion: {
      findMany: async (args: { where: { planId: string } }) => {
        const inst = instances.find((i) => i.id === args.where.planId) as
          | (ReturnType<typeof instanceFix> & { _completions?: string[] })
          | undefined;
        return (inst?._completions ?? []).map((stepKey) => ({ stepKey }));
      },
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
      // D-WS9-049 A2.2 — GET /plans/:id now batches the per-item Meal expansion
      // via composeMealDetailsBatch (one meal.findMany instead of N findUnique).
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        meals.filter((m) => args.where.id.in.includes(m.id)),
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

// WS7-8a B3 — GET /plans/:id derives per-meal prep from the freshly assembled
// step set (loadPrepStepSet). Inject a stub: default returns no steps (every
// meal vacuously prepped), or supply a known step set for the isPrepped tests.
function a2SpinUp(
  stub: unknown,
  loadPrepStepSet: () => Promise<{ stepKey: string; contributesToMealIds: string[] }[]> = async () => [],
): Promise<Harness> {
  return spinUp({
    prisma: stub as never,
    computePlanMacros: (async () => HAPPY_RESULT) as never,
    loadPrepStepSet: loadPrepStepSet as never,
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

  // WS7-5a — Branch B (PRD §5.6 redline). Hidden wizard drafts are written
  // on POST /wizard/expand with isWizardDraft=true; my_plans must NOT list
  // them (the user picks them up via GET /wizard/drafts via the "Resume
  // where you left off" prompt, not the regular Plans tab).
  it("my_plans excludes wizard pre-save drafts (isWizardDraft=true)", async () => {
    // Custom stub: filter by every where key the route passes so we observe
    // the isWizardDraft: false predicate. Each instance carries the new
    // flag; only normal plans should be returned.
    interface DraftAwareInstance {
      id: string;
      userId: string;
      titleOverride: string;
      isWizardDraft: boolean;
      isArchived: boolean;
      isActiveThisWeek: boolean;
      createdAt: Date;
      status: string;
      startDate: Date | null;
      endDate: Date | null;
      revisionId: number;
      prepStatus: string;
      optimizationNotes: unknown;
      breakfastOverrides: string | null;
      lunchOverrides: string | null;
      template: {
        title: string;
        description: string;
        imageUrl: string | null;
        tags: string[];
      };
      items: unknown[];
    }

    const fixtures: DraftAwareInstance[] = [
      // Normal plan — should be returned.
      {
        ...instanceFix({ id: "p-real", name: "Real Plan" }),
        isWizardDraft: false,
        isArchived: false,
      },
      // Wizard draft — must be filtered out.
      {
        ...instanceFix({ id: "p-draft", name: "Hidden Wizard Draft" }),
        isWizardDraft: true,
        isArchived: false,
      },
    ];

    const stub = {
      mealPlanInstance: {
        findMany: async (args: {
          where: {
            userId: string;
            isArchived?: boolean;
            isWizardDraft?: boolean;
          };
        }) =>
          fixtures.filter(
            (i) =>
              i.userId === args.where.userId &&
              (args.where.isArchived === undefined ||
                i.isArchived === args.where.isArchived) &&
              (args.where.isWizardDraft === undefined ||
                i.isWizardDraft === args.where.isWizardDraft),
          ),
        findFirst: async (args: {
          where: {
            userId: string;
            isActiveThisWeek?: boolean;
            isWizardDraft?: boolean;
          };
        }) =>
          fixtures.find(
            (i) =>
              i.userId === args.where.userId &&
              (args.where.isActiveThisWeek === undefined ||
                i.isActiveThisWeek === args.where.isActiveThisWeek) &&
              (args.where.isWizardDraft === undefined ||
                i.isWizardDraft === args.where.isWizardDraft),
          ) ?? null,
        findUnique: async (args: { where: { id: string } }) =>
          fixtures.find((i) => i.id === args.where.id) ?? null,
      },
      mealPlanTemplate: { findMany: async () => [] },
      meal: { findUnique: async () => null },
      recipeInstructionStep: { findMany: async () => [] },
      systemSetting: {
        findMany: async (args: { where: { key: { in: string[] } } }) =>
          A2_SETTINGS.filter((s) => args.where.key.in.includes(s.key)),
      },
    };

    const harness = await a2SpinUp(stub);
    try {
      const res = await fetch(`${harness.baseUrl}/plans`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plans: { id: string }[];
      };
      assert.deepEqual(body.plans.map((p) => p.id), ["p-real"]);
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

  it("includes the activeThisWeek summary (date-range predicate, R1)", async () => {
    // WS7-6 (E): the active summary is filtered by [startDate, endDate]
    // covering `now`, not by the dropped flag. Fixture must carry dates
    // that bookend the test's runtime `now` so the new findFirst filter
    // returns the row.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-active",
            name: "Active Plan",
            startDate: new Date(now - 3 * day),
            endDate: new Date(now + 3 * day),
          }),
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

  // ── WS7-6 (E) Block 1 §27 verification — auto-roll + wire shape ─────────
  //
  // The model change (drop the stored isActiveThisWeek column, derive from
  // [startDate, endDate]) is justified by the auto-roll property: a
  // future-dated plan must become "this week" purely as time passes, with
  // ZERO write event between the create and the moment the read first
  // surfaces it (D-WS7-062 — there is no scheduler that could flip a
  // stored flag). These tests pin that property.
  describe("WS7-6 (E) §27 — auto-roll proof", () => {
    it("R1 returns the row whose date range covers `now` over rows that don't (purely by date predicate)", async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-past",
              name: "Last Week",
              startDate: new Date(now - 14 * day),
              endDate: new Date(now - 8 * day),
              createdAt: new Date("2026-04-01T00:00:00Z"),
            }),
            instanceFix({
              id: "p-future",
              name: "Next Week",
              startDate: new Date(now + 8 * day),
              endDate: new Date(now + 14 * day),
              createdAt: new Date("2026-04-02T00:00:00Z"),
            }),
            instanceFix({
              id: "p-now",
              name: "This Week",
              startDate: new Date(now - 3 * day),
              endDate: new Date(now + 3 * day),
              createdAt: new Date("2026-04-03T00:00:00Z"),
            }),
          ],
        }),
      );
      try {
        const res = await fetch(`${harness.baseUrl}/plans`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        const body = (await res.json()) as {
          activeThisWeek: { id: string } | null;
        };
        // p-now is the only row whose [startDate, endDate] covers `now`.
        // No write happened between the seed and this read.
        assert.ok(body.activeThisWeek);
        assert.equal(body.activeThisWeek.id, "p-now");
      } finally {
        await harness.close();
      }
    });

    // WS7-6 (E) Block 1 REWORK — Model 2 multi-row proof. R1 must pick
    // the resolver WINNER (newest activatedAt among covering rows), not
    // just the first covering row. Two plans cover the same window; the
    // one with the fresher activatedAt wins.
    it("R1 returns the resolver winner — newest activatedAt — when MULTIPLE rows cover now", async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-older-act",
              name: "Older activation",
              startDate: new Date(now - 3 * day),
              endDate: new Date(now + 3 * day),
              activatedAt: new Date(now - 2 * day),
              createdAt: new Date(now - 5 * day),
            }),
            instanceFix({
              id: "p-newer-act",
              name: "Newer activation",
              startDate: new Date(now - 1 * day),
              endDate: new Date(now + 5 * day),
              activatedAt: new Date(now - 1 * day),
              createdAt: new Date(now - 1 * day),
            }),
          ],
        }),
      );
      try {
        const res = await fetch(`${harness.baseUrl}/plans`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        const body = (await res.json()) as {
          activeThisWeek: { id: string } | null;
        };
        assert.ok(body.activeThisWeek);
        assert.equal(body.activeThisWeek.id, "p-newer-act");
      } finally {
        await harness.close();
      }
    });

    it("R1 returns null when no row covers `now` (auto-roll has not occurred yet)", async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-future",
              name: "Next Week",
              startDate: new Date(now + 1 * day),
              endDate: new Date(now + 7 * day),
            }),
          ],
        }),
      );
      try {
        const res = await fetch(`${harness.baseUrl}/plans`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        const body = (await res.json()) as { activeThisWeek: unknown };
        assert.equal(body.activeThisWeek, null);
      } finally {
        await harness.close();
      }
    });
  });

  describe("WS7-6 (E) §27 — null-exempt proof", () => {
    it("a null-dated plan is NEVER returned as activeThisWeek (even if it is the only row)", async () => {
      // Use-template + wizard-draft + undated save all create null-dated
      // plans. The DB EXCLUDE constraint is WHERE-clause exempt for nulls
      // (so multiple undated plans coexist), and the date-range predicate
      // returns false for them — they're never "this week".
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-undated",
              name: "Undated",
              startDate: null,
              endDate: null,
            }),
          ],
        }),
      );
      try {
        const res = await fetch(`${harness.baseUrl}/plans`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        const body = (await res.json()) as { activeThisWeek: unknown };
        assert.equal(body.activeThisWeek, null);
      } finally {
        await harness.close();
      }
    });
  });

  describe("WS7-6 (E) §27 — wire-shape round-trip", () => {
    it("GET /plans/:id ships isActiveThisWeek=true on a covers-now plan", async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-current",
              name: "Covers now",
              startDate: new Date(now - 2 * day),
              endDate: new Date(now + 2 * day),
            }),
          ],
        }),
      );
      try {
        const res = await fetch(`${harness.baseUrl}/plans/p-current`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          plan: { id: string; isActiveThisWeek: boolean };
        };
        assert.equal(body.plan.id, "p-current");
        assert.equal(body.plan.isActiveThisWeek, true);
      } finally {
        await harness.close();
      }
    });

    it("GET /plans/:id ships isActiveThisWeek=false on a future-dated plan (proves no-write auto-roll boundary)", async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-future",
              name: "Next Week",
              startDate: new Date(now + 7 * day),
              endDate: new Date(now + 14 * day),
            }),
          ],
        }),
      );
      try {
        const res = await fetch(`${harness.baseUrl}/plans/p-future`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          plan: { id: string; isActiveThisWeek: boolean };
        };
        // Future plan does not cover `now` yet — boolean ships as false.
        // When time advances past startDate, the SAME row will start
        // shipping true without any write event.
        assert.equal(body.plan.isActiveThisWeek, false);
      } finally {
        await harness.close();
      }
    });

    // WS7-6 (E) Block 1 REWORK — Model 2 wire-shape proof: a covering
    // row that is NOT the winner ships isActiveThisWeek=false. Two plans
    // cover now; the one with the older activatedAt loses the tiebreak
    // and the wire boolean reflects that.
    it("GET /plans/:id ships isActiveThisWeek=false on a covering-but-not-winner plan (Model 2 tiebreak)", async () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-loser",
              name: "Older covering",
              startDate: new Date(now - 3 * day),
              endDate: new Date(now + 3 * day),
              activatedAt: new Date(now - 2 * day),
            }),
            instanceFix({
              id: "p-winner",
              name: "Newer covering",
              startDate: new Date(now - 1 * day),
              endDate: new Date(now + 5 * day),
              activatedAt: new Date(now - 1 * day),
            }),
          ],
        }),
      );
      try {
        const loser = await fetch(`${harness.baseUrl}/plans/p-loser`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        const loserBody = (await loser.json()) as {
          plan: { id: string; isActiveThisWeek: boolean };
        };
        assert.equal(loserBody.plan.id, "p-loser");
        assert.equal(loserBody.plan.isActiveThisWeek, false);

        const winner = await fetch(`${harness.baseUrl}/plans/p-winner`, {
          headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
        });
        const winnerBody = (await winner.json()) as {
          plan: { id: string; isActiveThisWeek: boolean };
        };
        assert.equal(winnerBody.plan.isActiveThisWeek, true);
      } finally {
        await harness.close();
      }
    });

    it("GET /plans/:id ships isActiveThisWeek=false on a null-dated plan", async () => {
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-undated",
              name: "Undated",
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
          plan: { id: string; isActiveThisWeek: boolean };
        };
        assert.equal(body.plan.isActiveThisWeek, false);
      } finally {
        await harness.close();
      }
    });
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

  // WS7-6 Fix-Block 2 (D, closes D-WS7-060) — Hans's ratified rule:
  // per-day average = sum of ASSIGNED meals ÷ count of distinct assigned
  // days. Numerator and denominator must gate on the SAME assignment
  // check. Pre-fix the divisor switched to assigned-day count while the
  // numerator summed ALL items, so a plan with N items and 1 day assigned
  // returned the SUM of all meals as the per-day value (user read it as
  // "macros stopped calculating").
  it("WS7-6 D / D-WS7-060 — partial assignment: numerator gates on assignedDayOfWeek (sum-of-assigned ÷ count-of-assigned-days)", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-partial",
            name: "Partial Plan",
            items: [
              // Assigned — counts in BOTH numerator and denominator.
              { id: "it-1", mealId: "m-a", positionIndex: 0, assignedDayOfWeek: "Monday" },
              // UNassigned — pre-fix the 1000-cal meal silently slid into
              // the numerator while the denominator stayed at 1 (Monday),
              // bloating the per-day to 1500.
              { id: "it-2", mealId: "m-big", positionIndex: 1, assignedDayOfWeek: null },
            ],
          }),
        ],
        meals: [
          mealFix("m-a", "Assigned meal", 500),
          mealFix("m-big", "Unassigned big meal", 1000),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-partial`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: { macroDailyAverage: { caloriesPerDay: number | null; proteinGPerDay: number | null } };
      };
      // 500 (only the Monday-assigned meal) ÷ 1 assigned day = 500/day.
      // NOT (500 + 1000) / 1 = 1500 (pre-fix bug).
      assert.equal(body.plan.macroDailyAverage.caloriesPerDay, 500);
      // protein: only the assigned meal (mealFix uses 20g) ÷ 1 day = 20.
      assert.equal(body.plan.macroDailyAverage.proteinGPerDay, 20);
    } finally {
      await harness.close();
    }
  });

  it("WS7-6 D — zero meals assigned → all macro fields null (UI renders dash)", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-none",
            name: "No assignments",
            items: [
              { id: "it-1", mealId: "m-a", positionIndex: 0, assignedDayOfWeek: null },
              { id: "it-2", mealId: "m-b", positionIndex: 1, assignedDayOfWeek: null },
            ],
          }),
        ],
        meals: [mealFix("m-a", "A", 500), mealFix("m-b", "B", 700)],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-none`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: {
          macroDailyAverage: {
            caloriesPerDay: number | null;
            proteinGPerDay: number | null;
            carbsGPerDay: number | null;
            fatGPerDay: number | null;
          };
        };
      };
      assert.equal(body.plan.macroDailyAverage.caloriesPerDay, null);
      assert.equal(body.plan.macroDailyAverage.proteinGPerDay, null);
      assert.equal(body.plan.macroDailyAverage.carbsGPerDay, null);
      assert.equal(body.plan.macroDailyAverage.fatGPerDay, null);
    } finally {
      await harness.close();
    }
  });

  it("WS7-6 D — all meals assigned: same totals/distinct-day-count math as before (no regression)", async () => {
    const harness = await a2SpinUp(
      makeA2Stub({
        instances: [
          instanceFix({
            id: "p-full",
            name: "Fully assigned",
            items: [
              { id: "it-1", mealId: "m-a", positionIndex: 0, assignedDayOfWeek: "Monday" },
              { id: "it-2", mealId: "m-b", positionIndex: 1, assignedDayOfWeek: "Tuesday" },
              { id: "it-3", mealId: "m-c", positionIndex: 2, assignedDayOfWeek: "Wednesday" },
            ],
          }),
        ],
        meals: [
          mealFix("m-a", "A", 600),
          mealFix("m-b", "B", 400),
          mealFix("m-c", "C", 500),
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-full`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        plan: { macroDailyAverage: { caloriesPerDay: number | null } };
      };
      // (600 + 400 + 500) / 3 distinct days = 500/day.
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
            // WS7-8a B3 — pinned manual so the stored value passes through the
            // now-derived rollup (an unpinned plan would report the derived
            // value instead).
            prepStatusIsManual: true,
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

  // ── WS7-8a B3 — per-meal prep surfacing on GET /plans/:id (D-WS7-153) ──
  describe("GET /plans/:id — per-meal prep state (B3)", () => {
    const STEP_ONION = {
      stepKey: "produce#onion",
      contributesToMealIds: ["meal-x", "meal-y"],
    };
    const STEP_BEEF = { stepKey: "proteins#beef", contributesToMealIds: ["meal-x"] };

    async function getPlan(harness: Harness, id: string) {
      const res = await fetch(`${harness.baseUrl}/plans/${id}`, {
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);
      return (await res.json()) as {
        plan: {
          prepStatus: string;
          prepStatusIsManual: boolean;
          items: { mealId: string; isPrepped: boolean }[];
        };
      };
    }

    it("item.isPrepped reflects checked contributing steps; rollup is derived (partial)", async () => {
      // onion (→ both meals) checked; beef (→ meal-x) NOT. So meal-y is fully
      // prepped (its only step is onion); meal-x still needs beef.
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-prep",
              name: "Prep Plan",
              completions: ["produce#onion"],
              items: [
                { id: "it-x", mealId: "meal-x", positionIndex: 0, assignedDayOfWeek: null },
                { id: "it-y", mealId: "meal-y", positionIndex: 1, assignedDayOfWeek: null },
              ],
            }),
          ],
          meals: [mealFix("meal-x", "Tacos", 500), mealFix("meal-y", "Fajitas", 450)],
        }),
        async () => [STEP_ONION, STEP_BEEF],
      );
      try {
        const body = await getPlan(harness, "p-prep");
        const itemX = body.plan.items.find((i) => i.mealId === "meal-x")!;
        const itemY = body.plan.items.find((i) => i.mealId === "meal-y")!;
        assert.equal(itemY.isPrepped, true);
        assert.equal(itemX.isPrepped, false);
        assert.equal(body.plan.prepStatus, "partial");
        assert.equal(body.plan.prepStatusIsManual, false);
      } finally {
        await harness.close();
      }
    });

    it("all contributing steps checked → every item prepped, rollup prepped", async () => {
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-done",
              name: "Done Plan",
              completions: ["produce#onion", "proteins#beef"],
              items: [
                { id: "it-x", mealId: "meal-x", positionIndex: 0, assignedDayOfWeek: null },
                { id: "it-y", mealId: "meal-y", positionIndex: 1, assignedDayOfWeek: null },
              ],
            }),
          ],
          meals: [mealFix("meal-x", "Tacos", 500), mealFix("meal-y", "Fajitas", 450)],
        }),
        async () => [STEP_ONION, STEP_BEEF],
      );
      try {
        const body = await getPlan(harness, "p-done");
        assert.ok(body.plan.items.every((i) => i.isPrepped));
        assert.equal(body.plan.prepStatus, "prepped");
      } finally {
        await harness.close();
      }
    });

    it("all-easy plan (no prep-worthy steps) → items vacuously prepped, rollup prepped", async () => {
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-easy",
              name: "Easy Plan",
              items: [
                { id: "it-x", mealId: "meal-x", positionIndex: 0, assignedDayOfWeek: null },
              ],
            }),
          ],
          meals: [mealFix("meal-x", "Big Salad", 200)],
        }),
        async () => [], // deterministic recompute yields zero prep steps
      );
      try {
        const body = await getPlan(harness, "p-easy");
        assert.equal(body.plan.items[0].isPrepped, true);
        assert.equal(body.plan.prepStatus, "prepped");
      } finally {
        await harness.close();
      }
    });

    it("a manual pin overrides the derived rollup on read", async () => {
      // No steps checked (would derive not_prepped), but a manual prepped pin
      // wins.
      const harness = await a2SpinUp(
        makeA2Stub({
          instances: [
            instanceFix({
              id: "p-pinned",
              name: "Pinned",
              prepStatus: "prepped",
              prepStatusIsManual: true,
              items: [
                { id: "it-x", mealId: "meal-x", positionIndex: 0, assignedDayOfWeek: null },
              ],
            }),
          ],
          meals: [mealFix("meal-x", "Tacos", 500)],
        }),
        async () => [STEP_BEEF], // meal-x needs beef, unchecked → derived not_prepped
      );
      try {
        const body = await getPlan(harness, "p-pinned");
        assert.equal(body.plan.prepStatus, "prepped"); // pin wins
        assert.equal(body.plan.prepStatusIsManual, true);
        // …but the per-item derived flag still reflects reality.
        assert.equal(body.plan.items[0].isPrepped, false);
      } finally {
        await harness.close();
      }
    });
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
  // WS7-7-A B5 fix2 — fork-on-acquire: each Meal.create issued by the fork
  // helper (foreign/null-owner template meals cloned into user-owned copies).
  forkedMeals?: Array<Record<string, unknown>>;
}

function makeC4Stub(opts: {
  templates?: TemplateDetailFix[];
  recorder: C4Recorder;
  /** Throw after the createMany — exercises rollback. */
  throwOnUpdate?: boolean;
  /**
   * WS7-7-A B5 fix2 — ownership of the template's item meals, for the
   * fork-on-acquire gate. A mealId absent here is treated as not-owned (→ fork).
   */
  meals?: Array<{ id: string; userId: string | null }>;
}) {
  const templates = opts.templates ?? [];
  const recorder = opts.recorder;
  const meals = opts.meals ?? [];
  let instanceCounter = 0;
  let forkCounter = 0;

  const txClient = {
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
    // WS7-7-A B5 fix2 — the fork gate's owner lookup + the fork helper's reads
    // and writes. Sources are synthesized minimal (no dishes) — the deep-clone
    // fidelity is covered by lib/__tests__/mealFork.test.ts; here we only need
    // the rebind + ownership routing.
    meal: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        meals.filter((m) => args.where.id.in.includes(m.id)),
      findUnique: async (args: { where: { id: string } }) => ({
        id: args.where.id,
        userId: meals.find((m) => m.id === args.where.id)?.userId ?? null,
        title: `T-${args.where.id}`,
        description: null,
        mealType: "dinner",
        sourceType: "curated",
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
        dishLinks: [],
      }),
      create: async (args: { data: Record<string, unknown> }) => {
        (recorder.forkedMeals ??= []).push(args.data);
        forkCounter += 1;
        return { id: `fork-${forkCounter}` };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
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
    // D-WS9-026 — first-plan stamp (write-if-null).
    user: {
      updateMany: async () => ({ count: 0 }),
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
        // The template's meals are owned by "owner" (a public template) — all
        // foreign to A2_USER, so each is forked-on-acquire into a user-owned
        // copy and the new plan's items rebind to the forks.
        meals: [
          { id: "m-a", userId: "owner" },
          { id: "m-b", userId: "owner" },
          { id: "m-c", userId: "owner" },
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

      // Instance was created with the expected shape. WS7-6 (E): the
      // use-template path no longer auto-activates — the new row is
      // undated and the date-range predicate already treats it as
      // not-current (null start/end), so isActiveThisWeek is computed
      // false. Mobile dates the plan with a follow-up PATCH.
      assert.equal(recorder.createdInstances.length, 1);
      const created = recorder.createdInstances[0];
      assert.equal(created.userId, A2_USER);
      assert.equal(created.mealPlanTemplateId, "t-use");
      assert.equal(created.startDate, null);
      assert.equal(created.endDate, null);
      assert.equal(created.status, "draft");
      assert.equal(created.titleOverride, null);

      // optimizationNotes copied from the template.
      const notes = created.optimizationNotes as Array<{ type: string; text: string }>;
      assert.equal(Array.isArray(notes), true);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, "Batch sauce");

      // 3 items copied, ordered by positionIndex, with day assignments
      // preserved. WS7-7-A B5 fix2: each foreign template meal was forked, so
      // the items rebind to the user-owned fork ids (NOT the original m-a/b/c).
      assert.equal(recorder.createManyItemsCalls.length, 1);
      const items = recorder.createManyItemsCalls[0].data;
      assert.equal(items.length, 3);
      assert.equal(items[0].assignedDayOfWeek, "Monday");
      assert.equal(items[2].assignedDayOfWeek, null);
      for (const it of items) {
        assert.ok(
          String(it.mealId).startsWith("fork-"),
          "item rebinds to a forked, user-owned meal",
        );
      }
      assert.notDeepEqual(
        items.map((i) => i.mealId),
        ["m-a", "m-b", "m-c"],
      );

      // Three forks minted (one per distinct foreign meal), each user-owned
      // and private.
      assert.equal(recorder.forkedMeals?.length, 3);
      for (const fm of recorder.forkedMeals ?? []) {
        assert.equal(fm.userId, A2_USER);
        assert.equal(fm.isPublic, false);
      }

      // WS7-6 (E): no demote-prior — single-current is enforced by the
      // per-user EXCLUDE constraint on [startDate, endDate], and the new
      // row is undated (null-exempt). The use-template path therefore
      // never touches other rows.
      assert.equal(recorder.updateManyCalls.length, 0);

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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
    // D-WS9-026 — first-plan stamp (write-if-null). Separate from the
    // mealPlanInstance.updateMany the demote-prior assertions watch.
    user: {
      updateMany: async () => ({ count: 0 }),
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

      // Instance row shape: null template, no name, draft, undated.
      // WS7-6 (E): isActiveThisWeek is no longer stored; "active" is the
      // date-range predicate. A minimal-body create is undated → never
      // current → metadata isActiveThisWeek = false.
      assert.equal(recorder.createdInstances.length, 1);
      const created = recorder.createdInstances[0];
      assert.equal(created.userId, A2_USER);
      assert.equal(created.mealPlanTemplateId, null);
      assert.equal(created.titleOverride, null);
      assert.equal(created.status, "draft");
      assert.equal(created.startDate, null);
      assert.equal(created.endDate, null);

      // WS7-6 (E): no demote-prior — the per-user EXCLUDE constraint
      // enforces single-current, and an undated plan is null-exempt.
      assert.equal(recorder.updateManyCalls.length, 0);

      // Activity emitted with the right shape — metadata's computed
      // boolean is false because the row has null dates.
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

  it("creates an Instance with full body — body dates land verbatim, no demote-prior", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      // WS7-6 (E): body dates that bookend `now` make the new row
      // current via the computed predicate. The activity-emit metadata
      // reflects that computed boolean.
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const startIso = new Date(now - 3 * day).toISOString();
      const endIso = new Date(now + 3 * day).toISOString();
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "My Empty Plan",
          startDate: startIso,
          endDate: endIso,
          isActiveThisWeek: true,
        }),
      });
      assert.equal(res.status, 201);

      assert.equal(recorder.createdInstances.length, 1);
      const created = recorder.createdInstances[0];
      assert.equal(created.titleOverride, "My Empty Plan");
      assert.ok(created.startDate instanceof Date);
      assert.ok(created.endDate instanceof Date);

      // WS7-6 (E): no demote-prior. Single-current is enforced at the
      // DB by the per-user EXCLUDE constraint on [startDate, endDate];
      // the app layer never issues a demote updateMany.
      assert.equal(recorder.updateManyCalls.length, 0);

      // Two emits: plan_created (always) + the re-pointed
      // plan_activated_this_week (because the created row covers now).
      // c2 adds the second emit — c1 only had plan_created.
      assert.equal(recorder.activityWrites.length, 2);
      const createdEvt = recorder.activityWrites.find(
        (a) => a.eventType === "plan_created",
      );
      assert.ok(createdEvt);
      assert.deepEqual(createdEvt.metadata, { isActiveThisWeek: true });
      const activated = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(activated, "expected plan_activated_this_week on covers-now create");
      assert.deepEqual(activated.metadata, { source: "plans_create" });
    } finally {
      await harness.close();
    }
  });

  it("POST /plans undated body does NOT emit plan_activated_this_week (only plan_created)", async () => {
    // WS7-6 (E) Block 1 c2 — the re-pointed predicate gates on
    // not-current → current. An undated create stays not-current
    // (null-dated → never covers now), so the activation event must
    // not fire.
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
        body: JSON.stringify({ name: "Just a Plan" }),
      });
      assert.equal(res.status, 201);

      const types = recorder.activityWrites.map((a) => a.eventType);
      assert.deepEqual(types, ["plan_created"]);
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

  // ── WS7-6 (E) Block 1 REWORK c3 — seam A stamp + analytics ─────────
  it("seam A: POST /plans STAMPS activatedAt when create dates cover now, and emits plan_activated_this_week", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const startDate = new Date(now - 2 * day).toISOString();
      const endDate = new Date(now + 4 * day).toISOString();
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Covers Now", startDate, endDate }),
      });
      assert.equal(res.status, 201);

      const created = recorder.createdInstances[0];
      // Seam A — activatedAt stamped because dates cover now.
      assert.ok(created.activatedAt instanceof Date,
        "POST /plans should stamp activatedAt when create dates cover now");

      // plan_activated_this_week emitted with source: plans_create.
      const activated = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(activated, "plan_activated_this_week should emit");
      assert.deepEqual(activated.metadata, { source: "plans_create" });

      // plan_created emit metadata.isActiveThisWeek = true (covering + stamped).
      const createdEvt = recorder.activityWrites.find(
        (a) => a.eventType === "plan_created",
      );
      assert.deepEqual(createdEvt?.metadata, { isActiveThisWeek: true });
    } finally {
      await harness.close();
    }
  });

  it("seam A: POST /plans does NOT stamp activatedAt when create dates do NOT cover now", async () => {
    const recorder: C2Recorder = {
      createdInstances: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(makeC2Stub({ recorder }));
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const startDate = new Date(now + 7 * day).toISOString(); // next week
      const endDate = new Date(now + 13 * day).toISOString();
      const res = await fetch(`${harness.baseUrl}/plans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signToken(A2_USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Future", startDate, endDate }),
      });
      assert.equal(res.status, 201);

      const created = recorder.createdInstances[0];
      // Seam A — no stamp because dates don't cover now (future plan).
      // Stub's create returns the args.data spread, so undefined activatedAt
      // becomes a missing key (Prisma's undefined → don't write the column).
      assert.equal(created.activatedAt, undefined,
        "POST /plans must NOT stamp activatedAt when create dates don't cover now");

      // plan_activated_this_week NOT emitted.
      const activated = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.equal(activated, undefined,
        "plan_activated_this_week must NOT emit for a future-dated create");
    } finally {
      await harness.close();
    }
  });

  it("seam A: POST /plans undated does NOT stamp activatedAt (null dates → never covers)", async () => {
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
        body: JSON.stringify({ name: "Undated" }),
      });
      assert.equal(res.status, 201);

      const created = recorder.createdInstances[0];
      assert.equal(created.startDate, null);
      assert.equal(created.endDate, null);
      assert.equal(created.activatedAt, undefined);
      assert.equal(
        recorder.activityWrites.find(
          (a) => a.eventType === "plan_activated_this_week",
        ),
        undefined,
      );
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
  // WS7-6 (E) Block 1 REWORK: wasActive is now "was the resolver winner
  // pre-delete". Resolver tiebreak fields kept on the fixture so the
  // DELETE-tx-scoped resolveThisWeekWinnerId narrow findMany picks the
  // winner correctly.
  startDate: Date | null;
  endDate: Date | null;
  activatedAt?: Date | null;
  createdAt?: Date;
  isWizardDraft?: boolean;
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        const row = instances.find((i) => i.id === args.where.id);
        return row ?? null;
      },
      // WS7-6 (E) Block 1 REWORK — narrow covering-subset query consumed
      // by resolveThisWeekWinnerId inside the DELETE tx. Mirrors the real
      // Prisma filter shape (userId + isWizardDraft + startDate.lte/not:null
      // + endDate.gte/not:null) and projects only the resolver-relevant
      // scalars.
      findMany: async (args: {
        where: {
          userId: string;
          isWizardDraft?: boolean;
          startDate?: { lte: Date; not?: null };
          endDate?: { gte: Date; not?: null };
        };
      }) => {
        return instances
          .filter((i) => {
            if (i.userId !== args.where.userId) return false;
            const draftFlag = i.isWizardDraft ?? false;
            if (args.where.isWizardDraft !== undefined && draftFlag !== args.where.isWizardDraft) return false;
            if (args.where.startDate?.lte) {
              if (i.startDate === null) return false;
              if (i.startDate.getTime() > args.where.startDate.lte.getTime()) return false;
            }
            if (args.where.endDate?.gte) {
              if (i.endDate === null) return false;
              if (i.endDate.getTime() < args.where.endDate.gte.getTime()) return false;
            }
            return true;
          })
          .map((i) => ({
            id: i.id,
            startDate: i.startDate,
            endDate: i.endDate,
            activatedAt: i.activatedAt ?? null,
            createdAt: i.createdAt ?? new Date("2026-05-01T00:00:00.000Z"),
          }));
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
    // D-WS9-026 — first-plan stamp (write-if-null). Separate from the
    // mealPlanInstance.updateMany the demote-prior assertions watch.
    user: {
      updateMany: async () => ({ count: 0 }),
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
          { id: "p-1", userId: A2_USER, revisionId: 3, startDate: null, endDate: null },
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
      // WS7-6 (E): no isActiveThisWeek write — the column is gone.
      assert.equal(Object.prototype.hasOwnProperty.call(upd.data, "isActiveThisWeek"), false);
      assert.deepEqual(upd.data.revisionId, { increment: 1 });

      assert.equal(recorder.activityWrites.length, 1);
      const act = recorder.activityWrites[0];
      assert.equal(act.userId, A2_USER);
      assert.equal(act.eventType, "plan_composted");
      assert.equal(act.entityType, "MealPlanInstance");
      assert.equal(act.entityId, "p-1");
      // undated row → computed wasActive is false.
      assert.deepEqual(act.metadata, { wasActive: false });
    } finally {
      await harness.close();
    }
  });

  it("DELETE on active plan records wasActive=true (Q-P1-5) — computed from row's date range", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    // WS7-6 (E): "active" is now derived. Seed dates that bookend `now`
    // so the helper computes wasActive=true at delete time.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const harness = await mutationSpinUp(
      makeC3DeleteStub({
        recorder,
        instances: [
          {
            id: "p-active",
            userId: A2_USER,
            revisionId: 1,
            startDate: new Date(now - 3 * day),
            endDate: new Date(now + 3 * day),
          },
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-active`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);

      // Single update statement; it does NOT write isActiveThisWeek
      // (column dropped). status/compostedAt/isArchived/revisionId only.
      assert.equal(recorder.instanceUpdates.length, 1);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          recorder.instanceUpdates[0].data,
          "isActiveThisWeek",
        ),
        false,
      );

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
          { id: "p-other", userId: "stranger", revisionId: 1, startDate: null, endDate: null },
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

  // WS7-6 (E) Block 1 REWORK c3 — wasActive is now "was the resolver
  // WINNER pre-delete" (Phase 0 ruling, Phase 1 accepted as a metadata-
  // shape change). A covering plan that LOST the tiebreak to a sibling
  // with a fresher activatedAt ships wasActive=false; the winner ships
  // wasActive=true. Multi-row proof — distinguishes Model 2's resolver
  // semantic from the old per-row date-range predicate.
  it("DELETE of a covering-but-not-winner plan records wasActive=false (resolver loser)", async () => {
    const recorder: C3DeleteRecorder = { instanceUpdates: [], activityWrites: [] };
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const harness = await mutationSpinUp(
      makeC3DeleteStub({
        recorder,
        instances: [
          {
            id: "p-loser",
            userId: A2_USER,
            revisionId: 1,
            startDate: new Date(now - 3 * day),
            endDate: new Date(now + 3 * day),
            activatedAt: new Date(now - 2 * day), // older activation
            createdAt: new Date(now - 5 * day),
          },
          {
            id: "p-winner",
            userId: A2_USER,
            revisionId: 1,
            startDate: new Date(now - 1 * day),
            endDate: new Date(now + 5 * day),
            activatedAt: new Date(now - 1 * day), // newer activation → wins
            createdAt: new Date(now - 1 * day),
          },
        ],
      }),
    );
    try {
      const res = await fetch(`${harness.baseUrl}/plans/p-loser`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${signToken(A2_USER)}` },
      });
      assert.equal(res.status, 200);

      const act = recorder.activityWrites[0];
      assert.equal(act.eventType, "plan_composted");
      // Covering but not winner → wasActive=false under Model 2.
      assert.deepEqual(act.metadata, { wasActive: false },
        "covering-but-not-winner plan must record wasActive=false");
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
  prepStatusIsManual: boolean;
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
    // D-WS9-026 — first-plan stamp (write-if-null). Separate from the
    // mealPlanInstance.updateMany the demote-prior assertions watch.
    user: {
      updateMany: async () => ({ count: 0 }),
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
    prepStatusIsManual: opts.prepStatusIsManual ?? false,
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

  it("startDate + endDate PATCH emits ONE plan_date_range_edited with fields=[startDate,endDate] (+ activated_this_week when new range covers now)", async () => {
    // WS7-6 (E) Block 1 c2 — date-range PATCHes that newly cover `now`
    // emit BOTH plan_date_range_edited (one combined event per c4
    // mapping) AND plan_activated_this_week (the re-pointed activation
    // event). The fixture starts undated; the new range bookends a
    // dynamic `now` so the test stays valid as the calendar advances.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1" })],
      }),
    );
    try {
      const startIso = new Date(now - 3 * day).toISOString();
      const endIso = new Date(now + 3 * day).toISOString();
      const res = await patchPlan(harness, "p-1", {
        startDate: startIso,
        endDate: endIso,
      });
      assert.equal(res.status, 200);

      const dateEdit = recorder.activityWrites.find(
        (a) => a.eventType === "plan_date_range_edited",
      );
      assert.ok(dateEdit, "expected one plan_date_range_edited");
      const meta = dateEdit.metadata as { fields: string[] };
      assert.deepEqual(meta.fields, ["startDate", "endDate"]);

      const activated = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(activated, "expected plan_activated_this_week on newly-covers-now PATCH");
      assert.deepEqual(activated.metadata, { source: "plans_patch" });
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

  it("PATCH that shifts dates from covering-now to not-covering-now does NOT emit plan_activated_this_week (silent demotion)", async () => {
    // WS7-6 (E) Block 1 c2 — re-pointed predicate. The "covers-now →
    // not-covering-now" transition does not emit the activation event;
    // it is a silent demotion. The user did not commit to a new
    // this-week plan.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            startDate: new Date(now - 3 * day),
            endDate: new Date(now + 3 * day),
          }),
        ],
      }),
    );
    try {
      // Shift dates well into the past — no longer covers now.
      const res = await patchPlan(harness, "p-1", {
        startDate: "2025-01-01T00:00:00.000Z",
        endDate: "2025-01-07T00:00:00.000Z",
      });
      assert.equal(res.status, 200);

      assert.equal(recorder.updateManyCalls.length, 0);
      const types = recorder.activityWrites.map((a) => a.eventType);
      assert.equal(types.includes("plan_activated_this_week"), false);
    } finally {
      await harness.close();
    }
  });

  it("PATCH that newly covers `now` via date change EMITS plan_activated_this_week (re-pointed predicate)", async () => {
    // WS7-6 (E) Block 1 c2 — the not-current → current transition fires
    // the re-pointed event. Source metadata distinguishes the path so
    // analytics can split create vs. patch vs. wizard-activate.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            // Pre-state: dates in the past (not-current).
            startDate: new Date("2025-01-01T00:00:00.000Z"),
            endDate: new Date("2025-01-07T00:00:00.000Z"),
          }),
        ],
      }),
    );
    try {
      const startIso = new Date(now - 3 * day).toISOString();
      const endIso = new Date(now + 3 * day).toISOString();
      const res = await patchPlan(harness, "p-1", {
        startDate: startIso,
        endDate: endIso,
      });
      assert.equal(res.status, 200);

      const emit = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(emit, "expected plan_activated_this_week to fire");
      assert.deepEqual(emit.metadata, { source: "plans_patch" });
    } finally {
      await harness.close();
    }
  });

  it("PATCH that re-dates a covers-now plan to another covers-now range does NOT re-emit (same-state)", async () => {
    // WS7-6 (E) Block 1 c2 — the re-pointed predicate fires only on the
    // not-current → current transition. A covers-now → covers-now
    // re-date (user nudging the plan's range while it still covers
    // today) is not a fresh commitment and must not re-emit.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            startDate: new Date(now - 5 * day),
            endDate: new Date(now + 2 * day),
          }),
        ],
      }),
    );
    try {
      const startIso = new Date(now - 2 * day).toISOString();
      const endIso = new Date(now + 5 * day).toISOString();
      const res = await patchPlan(harness, "p-1", {
        startDate: startIso,
        endDate: endIso,
      });
      assert.equal(res.status, 200);

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
      // WS7-8a B3 — a forward manual PATCH pins the override.
      assert.equal(recorder.instanceUpdates[0].data.prepStatusIsManual, true);
    } finally {
      await harness.close();
    }
  });

  it("prepStatus backward transition (prepped -> not_prepped) applies write but emits NO event", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", prepStatus: "prepped", prepStatusIsManual: true })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { prepStatus: "not_prepped" });
      assert.equal(res.status, 200);
      assert.equal(recorder.instanceUpdates.length, 1);
      assert.equal(recorder.instanceUpdates[0].data.prepStatus, "not_prepped");
      assert.equal(recorder.activityWrites.length, 0);
      // WS7-8a B3 — un-mark/reset clears the pin, returning control to derived.
      assert.equal(recorder.instanceUpdates[0].data.prepStatusIsManual, false);
    } finally {
      await harness.close();
    }
  });

  it("end-of-session Done (not_prepped -> prepped) pins manual=true + emits plan_prep_started", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [fixturePatch({ id: "p-1", prepStatus: "not_prepped", prepStatusIsManual: false })],
      }),
    );
    try {
      const res = await patchPlan(harness, "p-1", { prepStatus: "prepped" });
      assert.equal(res.status, 200);
      assert.equal(recorder.instanceUpdates[0].data.prepStatus, "prepped");
      assert.equal(recorder.instanceUpdates[0].data.prepStatusIsManual, true);
      assert.equal(recorder.activityWrites[0].eventType, "plan_prep_started");
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

  // WS7-6 (E) Block 2 — chip auto-date envelope + stamp fallback. PATCH
  // /plans/:id now treats body.isActiveThisWeek:true as the chip's one-tap
  // "make this my week" designation: the envelope sets dates to the shared
  // Sun-Sat currentWeekRange() whenever the body says active=true (no
  // longer gated on row.startDate === null), and a stamp fallback after
  // seam B guarantees activatedAt = now even when the dates already match
  // currentWeekRange() exactly (envelope produces no diff). Body
  // startDate/endDate still win — activation does not clobber an explicit
  // date edit. Non-active and unrelated PATCHes never touch the date
  // fields or stamp activatedAt. The three round-trip tests below cover
  // (a) future-dated, (b) past-dated, and (c) already-exactly-this-week
  // starting states; each fail-against-old (pre-Block-2 noop) and
  // pass-against-new (dates + stamp + emit + resolver winner).

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

  // ── Block 2 round-trip (a/b/c): chip designation moves dates to this
  // week, stamps activatedAt, emits plan_activated_this_week, and the
  // resolver picks the chipped plan as winner — for every starting state.

  it("round-trip (a) future-dated chip PATCH: dates → this-week, activatedAt stamped, emit, resolver winner over pre-existing P", async () => {
    // Pre-Block-2: future-dated row + flag PATCH was a noop (envelope's
    // `row.startDate === null` guard skipped the auto-date branch, no
    // field diff, no stamp). Under Block 2: envelope ALWAYS rewrites
    // dates to currentWeekRange() when the flag is true, seam B fires
    // (didNewlyCoverNow {future} → {this-week} is true → stamp), emit
    // fires, resolver picks the chipped plan.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = currentWeekRange();
    const expectedStart = new Date(week.startDate);
    const expectedEnd = new Date(week.endDate);

    // P — pre-existing covering plan with activatedAt in the past.
    const pCovering = fixturePatch({
      id: "p-pre",
      startDate: new Date(now - 5 * day),
      endDate: new Date(now + 2 * day),
    });
    const pActivatedAt = new Date(now - 3 * day);

    // Q — future-dated plan that the chip will pull to this week.
    const qFuture = fixturePatch({
      id: "q-future",
      startDate: new Date(now + 14 * day),
      endDate: new Date(now + 20 * day),
    });

    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({ recorder, instances: [pCovering, qFuture] }),
    );
    try {
      const res = await patchPlan(harness, "q-future", { isActiveThisWeek: true });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "q-future");

      // Dates moved to currentWeekRange().
      assert.ok(upd.data.startDate instanceof Date, "startDate written");
      assert.ok(upd.data.endDate instanceof Date, "endDate written");
      assert.equal((upd.data.startDate as Date).getTime(), expectedStart.getTime());
      assert.equal((upd.data.endDate as Date).getTime(), expectedEnd.getTime());

      // activatedAt stamped via seam B (date change moves not-covering → covering).
      assert.ok(upd.data.activatedAt instanceof Date, "activatedAt stamped");
      const qStampedAt = upd.data.activatedAt as Date;

      // plan_activated_this_week emitted for Q.
      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(act, "plan_activated_this_week must emit");
      assert.equal(act.entityId, "q-future");
      assert.deepEqual(act.metadata, { source: "plans_patch" });

      // Resolver picks Q. Prior winner P's wire-side isActiveThisWeek
      // flips to false because the projection is id-compared against the
      // resolver winner id.
      const postWrite = [
        {
          id: pCovering.id,
          startDate: pCovering.startDate,
          endDate: pCovering.endDate,
          activatedAt: pActivatedAt,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          id: qFuture.id,
          startDate: expectedStart,
          endDate: expectedEnd,
          activatedAt: qStampedAt,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ];
      const winner = resolveThisWeekPlan(postWrite);
      assert.ok(winner, "resolver must find a winner");
      assert.equal(winner.id, "q-future", "Q wins");
      assert.notEqual(winner.id, pCovering.id, "P (prior winner) demoted");
    } finally {
      await harness.close();
    }
  });

  it("round-trip (b) past-dated chip PATCH: dates → this-week, activatedAt stamped, emit, resolver winner over pre-existing P", async () => {
    // Pre-Block-2: past-dated row + flag PATCH was a noop. Under Block
    // 2: envelope rewrites dates, seam B stamps (not-covering →
    // covering), emit fires, resolver picks Q.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = currentWeekRange();
    const expectedStart = new Date(week.startDate);
    const expectedEnd = new Date(week.endDate);

    const pCovering = fixturePatch({
      id: "p-pre",
      startDate: new Date(now - 5 * day),
      endDate: new Date(now + 2 * day),
    });
    const pActivatedAt = new Date(now - 3 * day);

    // Q — past-dated plan (clearly before this week).
    const qPast = fixturePatch({
      id: "q-past",
      startDate: new Date("2025-01-01T00:00:00.000Z"),
      endDate: new Date("2025-01-07T00:00:00.000Z"),
    });

    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({ recorder, instances: [pCovering, qPast] }),
    );
    try {
      const res = await patchPlan(harness, "q-past", { isActiveThisWeek: true });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "q-past");

      assert.equal((upd.data.startDate as Date).getTime(), expectedStart.getTime());
      assert.equal((upd.data.endDate as Date).getTime(), expectedEnd.getTime());
      assert.ok(upd.data.activatedAt instanceof Date, "activatedAt stamped (seam B)");
      const qStampedAt = upd.data.activatedAt as Date;

      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(act, "plan_activated_this_week must emit");
      assert.equal(act.entityId, "q-past");
      assert.deepEqual(act.metadata, { source: "plans_patch" });

      const postWrite = [
        {
          id: pCovering.id,
          startDate: pCovering.startDate,
          endDate: pCovering.endDate,
          activatedAt: pActivatedAt,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          id: qPast.id,
          startDate: expectedStart,
          endDate: expectedEnd,
          activatedAt: qStampedAt,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ];
      const winner = resolveThisWeekPlan(postWrite);
      assert.ok(winner);
      assert.equal(winner.id, "q-past", "Q wins");
      assert.notEqual(winner.id, pCovering.id, "P demoted");
    } finally {
      await harness.close();
    }
  });

  it("round-trip (c) already-exactly-this-week chip PATCH: dates UNCHANGED, activatedAt stamped via fallback, emit, resolver winner over pre-existing P", async () => {
    // Pre-Block-2: row with startDate !== null skipped the envelope; no
    // field diff → noop → no stamp → P kept winning. Under Block 2: the
    // envelope sees dates already match currentWeekRange() so it does
    // NOT add to changedFields (no spurious date emit), but the stamp
    // fallback fires because body.isActiveThisWeek === true && seam B
    // did not stamp. activatedAt is stamped, emit fires, resolver picks Q.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = currentWeekRange();
    const thisWeekStart = new Date(week.startDate);
    const thisWeekEnd = new Date(week.endDate);

    const pCovering = fixturePatch({
      id: "p-pre",
      // Same calendar week as currentWeekRange() — both P and Q cover now,
      // so the resolver must use activatedAt to tiebreak.
      startDate: thisWeekStart,
      endDate: thisWeekEnd,
    });
    const pActivatedAt = new Date(now - 3 * day);

    // Q — already exactly-this-week before the chip tap.
    const qAlready = fixturePatch({
      id: "q-already",
      startDate: thisWeekStart,
      endDate: thisWeekEnd,
    });

    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({ recorder, instances: [pCovering, qAlready] }),
    );
    try {
      const res = await patchPlan(harness, "q-already", { isActiveThisWeek: true });
      assert.equal(res.status, 200);

      // One update — the stamp fallback's activatedAt write.
      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "q-already");

      // Dates NOT in the update data — envelope saw they matched and
      // didn't add to changedFields. No spurious date-range emit.
      assert.equal(
        Object.prototype.hasOwnProperty.call(upd.data, "startDate"),
        false,
        "startDate not rewritten when already matches currentWeekRange()",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(upd.data, "endDate"),
        false,
        "endDate not rewritten when already matches currentWeekRange()",
      );

      // Stamp fallback fired.
      assert.ok(upd.data.activatedAt instanceof Date, "fallback stamps activatedAt");
      const qStampedAt = upd.data.activatedAt as Date;

      // No spurious plan_date_range_edited; one plan_activated_this_week.
      const dateEdit = recorder.activityWrites.find(
        (a) => a.eventType === "plan_date_range_edited",
      );
      assert.equal(dateEdit, undefined, "no spurious plan_date_range_edited");

      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(act, "plan_activated_this_week must emit via fallback path");
      assert.equal(act.entityId, "q-already");
      assert.deepEqual(act.metadata, { source: "plans_patch" });

      // Resolver picks Q on activatedAt tiebreak (qStampedAt > pActivatedAt).
      const postWrite = [
        {
          id: pCovering.id,
          startDate: pCovering.startDate,
          endDate: pCovering.endDate,
          activatedAt: pActivatedAt,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          id: qAlready.id,
          startDate: qAlready.startDate,
          endDate: qAlready.endDate,
          activatedAt: qStampedAt,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ];
      const winner = resolveThisWeekPlan(postWrite);
      assert.ok(winner);
      assert.equal(winner.id, "q-already", "Q wins via fallback stamp");
      assert.notEqual(winner.id, pCovering.id, "P demoted by activatedAt tiebreak");
    } finally {
      await harness.close();
    }
  });

  // ── D-WS7-106 — coverage-of-now gate (build-it-right §5). The chip
  // never sends a self-contradictory body, but the API contract allows
  // { isActiveThisWeek: true, startDate: <future>, endDate: <future> }.
  // Such a PATCH must NOT stamp activatedAt and must NOT emit
  // plan_activated_this_week — otherwise a future-only row would carry a
  // fresh activatedAt the resolver can't pick up (won't cover until the
  // dates roll in) and any later silent demotion would inherit stale
  // activation state. Pins both gates to (flag === true && post-PATCH
  // dates cover now), reusing the shared day-granular helper.
  it("D-WS7-106 guard: contradictory {isActiveThisWeek:true} + future body dates → no stamp, no emit, NOT resolver winner", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // P — pre-existing covering plan with activatedAt in the past.
    const pCovering = fixturePatch({
      id: "p-pre",
      startDate: new Date(now - 5 * day),
      endDate: new Date(now + 2 * day),
    });
    const pActivatedAt = new Date(now - 3 * day);

    // Q — undated, but body explicitly supplies future dates. Body
    // wins over the envelope (envelope gate requires
    // body.startDate === undefined), so the post-PATCH range does NOT
    // cover now.
    const qUndated = fixturePatch({
      id: "q-contradiction",
      startDate: null,
      endDate: null,
    });

    const futureStartIso = new Date(now + 14 * day).toISOString();
    const futureEndIso = new Date(now + 20 * day).toISOString();

    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({ recorder, instances: [pCovering, qUndated] }),
    );
    try {
      const res = await patchPlan(harness, "q-contradiction", {
        isActiveThisWeek: true,
        startDate: futureStartIso,
        endDate: futureEndIso,
      });
      assert.equal(res.status, 200);

      // The write happens (dates were updated) but activatedAt is NOT
      // stamped — the resulting range does not cover now.
      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "q-contradiction");
      assert.equal(
        Object.prototype.hasOwnProperty.call(upd.data, "activatedAt"),
        false,
        "D-WS7-106: activatedAt must NOT be stamped when post-PATCH range does not cover now",
      );

      // No plan_activated_this_week emit.
      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.equal(
        act,
        undefined,
        "D-WS7-106: plan_activated_this_week must NOT emit on a contradictory flag PATCH",
      );

      // Resolver still picks P — Q's future range is not eligible.
      const postWrite = [
        {
          id: pCovering.id,
          startDate: pCovering.startDate,
          endDate: pCovering.endDate,
          activatedAt: pActivatedAt,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          id: qUndated.id,
          startDate: new Date(futureStartIso),
          endDate: new Date(futureEndIso),
          activatedAt: null,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ];
      const winner = resolveThisWeekPlan(postWrite);
      assert.ok(winner);
      assert.equal(winner.id, pCovering.id, "P retains winner — Q is not eligible (future range)");
      assert.notEqual(winner.id, "q-contradiction");
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

  it("PATCH {isActiveThisWeek:false} does NOT auto-fill dates (only the body's true value triggers auto-date)", async () => {
    // WS7-6 (E): the auto-date envelope predicate requires
    // `body.isActiveThisWeek === true`. A body of false is advisory and
    // produces no field diff — the route returns the noop result and
    // never calls update.
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
      assert.equal(recorder.instanceUpdates.length, 0);
    } finally {
      await harness.close();
    }
  });

  // ── WS7-6 (E) Block 1 REWORK c3 — seam B stamp + analytics ─────────
  it("seam B: PATCH newly-covers-now STAMPS activatedAt and emits plan_activated_this_week", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({ id: "p-future", startDate: null, endDate: null }),
        ],
      }),
    );
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const startDate = new Date(now - 2 * day).toISOString();
      const endDate = new Date(now + 4 * day).toISOString();
      const res = await patchPlan(harness, "p-future", { startDate, endDate });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      // Seam B — activatedAt stamped because dates newly cover now.
      assert.ok(upd.data.activatedAt instanceof Date,
        "PATCH newly-covers-now must stamp activatedAt");

      // plan_activated_this_week emitted with source: plans_patch.
      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(act, "plan_activated_this_week must emit");
      assert.deepEqual(act.metadata, { source: "plans_patch" });
    } finally {
      await harness.close();
    }
  });

  // EQUIVALENCE PROOF (test 21b — required by Hans). Direct three-prong
  // verification that, after a newly-covers-now PATCH on plan Q in a
  // fixture where another covering plan P already has activatedAt set
  // in the past:
  //   (1) Q stamps activatedAt (seam B fired)
  //   (2) plan_activated_this_week emits for Q
  //   (3) resolveThisWeekPlan over the user's covering set returns Q
  // Proves the emit gate's "newly covers" decision and the resolver's
  // "is the winner" decision AGREE — not just under the stamp invariant
  // by reasoning, but by direct test.
  it("EQUIVALENCE: PATCH newly-covers-now → stamp + emit + Q is the resolver winner over a pre-existing covering P", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // P — pre-existing covering plan with activatedAt in the past.
    const pCovering = fixturePatch({
      id: "p-pre-existing",
      startDate: new Date(now - 5 * day),
      endDate: new Date(now + 2 * day),
    });
    const pActivatedAt = new Date(now - 3 * day);

    // Q — future-dated plan that the PATCH will pull into the covering set.
    const qFuture = fixturePatch({
      id: "q-newly-covering",
      startDate: null,
      endDate: null,
    });

    const recorder: C4PatchRecorder = {
      instanceUpdates: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4PatchStub({ recorder, instances: [pCovering, qFuture] }),
    );
    try {
      const startDate = new Date(now - 1 * day).toISOString();
      const endDate = new Date(now + 5 * day).toISOString();
      const res = await patchPlan(harness, "q-newly-covering", {
        startDate,
        endDate,
      });
      assert.equal(res.status, 200);

      // (1) Seam B fired — Q stamped activatedAt.
      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "q-newly-covering");
      assert.ok(upd.data.activatedAt instanceof Date,
        "(1) seam B must stamp activatedAt on Q");
      const qStampedAt = upd.data.activatedAt as Date;

      // (2) plan_activated_this_week emitted for Q.
      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(act, "(2) plan_activated_this_week must emit for Q");
      assert.equal(act.entityId, "q-newly-covering");
      assert.deepEqual(act.metadata, { source: "plans_patch" });

      // (3) Run the resolver over the post-write candidate set: P (covering,
      // activatedAt = pActivatedAt) and Q (now covering with the stamped
      // qStampedAt). The resolver must return Q — proving the analytics
      // gate's "newly covers" decision agrees with the resolver's "is
      // winner" decision by direct test, not by reasoning alone.
      const postWriteCandidates = [
        {
          id: pCovering.id,
          startDate: pCovering.startDate,
          endDate: pCovering.endDate,
          activatedAt: pActivatedAt,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          id: qFuture.id,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          activatedAt: qStampedAt,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ];
      const winner = resolveThisWeekPlan(postWriteCandidates);
      assert.ok(winner, "(3) resolver must find a winner");
      assert.equal(
        winner.id,
        "q-newly-covering",
        "(3) resolver must return Q — emit gate and resolver agree",
      );
    } finally {
      await harness.close();
    }
  });

  // D-WS7-103 — 21b-redo with the realistic mobile wire shape: date-only
  // YYYY-MM-DD strings, not full ISO instants. The original 21b sent ISO
  // timestamps multiple days out and never hit the UTC-midnight-of-today
  // boundary; the bug was that endDate=today UTC-midnight failed the seam B
  // gate the moment now passed 00:00 UTC. Here the PATCH body's endDate is
  // today's UTC YYYY-MM-DD; the route's toNullableDate canonicalizes it
  // to today's 00:00 UTC Date, mirroring real Prisma storage. The seam B
  // gate (didNewlyCoverNow) is exercised against the actual now from
  // inside the handler — so as long as the test runs at any time except
  // the exact instant of 00:00 UTC today (a sub-millisecond window), the
  // OLD instant comparison reports "expired" and the NEW UTC-day
  // comparison reports "covers".
  it("EQUIVALENCE (D-WS7-103): PATCH with date-only YYYY-MM-DD body on the UTC-day boundary still stamps + wins resolver", async () => {
    const now = new Date();
    const ymd = (d: Date): string => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    };
    const day = 24 * 60 * 60 * 1000;
    const sixDaysAgoYmd = ymd(new Date(now.getTime() - 6 * day));
    const todayYmd = ymd(now);

    // P — pre-existing covering plan with activatedAt in the past. Stored
    // as arbitrary instants (not UTC midnight) so its coverage is
    // unambiguous regardless of when the test runs.
    const pCovering = fixturePatch({
      id: "p-pre-existing",
      startDate: new Date(now.getTime() - 5 * day),
      endDate: new Date(now.getTime() + 2 * day),
    });
    const pActivatedAt = new Date(now.getTime() - 3 * day);

    // Q — undated, about to be PATCHed with date-only YYYY-MM-DD where
    // endDate is today's UTC date. Under OLD code this PATCH would NOT
    // stamp activatedAt (the endDate Date is 00:00 UTC of today; now is
    // past that instant); under NEW code the day-truncated compare
    // admits today's endDate.
    const qFuture = fixturePatch({
      id: "q-newly-covering",
      startDate: null,
      endDate: null,
    });

    const recorder: C4PatchRecorder = {
      instanceUpdates: [],
      updateManyCalls: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeC4PatchStub({ recorder, instances: [pCovering, qFuture] }),
    );
    try {
      const res = await patchPlan(harness, "q-newly-covering", {
        startDate: sixDaysAgoYmd,
        endDate: todayYmd,
      });
      assert.equal(res.status, 200);

      // (1) Seam B fired — Q stamped activatedAt despite endDate being
      // today's UTC midnight. THIS IS THE BUG: under OLD code, the gate
      // sees endDate (00:00 UTC today) < now (XX:XX UTC today) and
      // returns false, so activatedAt is NOT set on update.data.
      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      assert.equal(upd.where.id, "q-newly-covering");
      assert.ok(
        upd.data.activatedAt instanceof Date,
        "(1) seam B must stamp activatedAt on Q even when endDate is today's UTC midnight (date-only wire shape)",
      );
      const qStampedAt = upd.data.activatedAt as Date;

      // (2) plan_activated_this_week emitted for Q.
      const act = recorder.activityWrites.find(
        (a) => a.eventType === "plan_activated_this_week",
      );
      assert.ok(
        act,
        "(2) plan_activated_this_week must emit for Q on UTC-day boundary",
      );
      assert.equal(act.entityId, "q-newly-covering");
      assert.deepEqual(act.metadata, { source: "plans_patch" });

      // (3) Resolver over the post-write candidate set: Q's stored dates
      // are the UTC-midnight canonical Date objects (mirroring real
      // Prisma's `new Date("YYYY-MM-DD")` round-trip). Q's fresh
      // activatedAt beats P's older activatedAt → Q wins.
      const postWriteCandidates = [
        {
          id: pCovering.id,
          startDate: pCovering.startDate,
          endDate: pCovering.endDate,
          activatedAt: pActivatedAt,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
        {
          id: qFuture.id,
          startDate: new Date(sixDaysAgoYmd),
          endDate: new Date(todayYmd),
          activatedAt: qStampedAt,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ];
      const winner = resolveThisWeekPlan(postWriteCandidates);
      assert.ok(winner, "(3) resolver must find a winner");
      assert.equal(
        winner.id,
        "q-newly-covering",
        "(3) resolver must return Q with end=today UTC-midnight — wire-shape proof",
      );
    } finally {
      await harness.close();
    }
  });

  it("seam B: PATCH covers-now → covers-now re-date does NOT re-stamp activatedAt (same-state)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            startDate: new Date(now - 3 * day),
            endDate: new Date(now + 3 * day),
          }),
        ],
      }),
    );
    try {
      // Move dates by 1 day in each direction — still covering, just a re-date.
      const startDate = new Date(now - 2 * day).toISOString();
      const endDate = new Date(now + 4 * day).toISOString();
      const res = await patchPlan(harness, "p-1", { startDate, endDate });
      assert.equal(res.status, 200);

      assert.equal(recorder.instanceUpdates.length, 1);
      const upd = recorder.instanceUpdates[0];
      // No restamp — covers→covers does not transition.
      assert.equal(upd.data.activatedAt, undefined,
        "PATCH covers→covers same-state must NOT re-stamp activatedAt");

      // No plan_activated_this_week emit.
      assert.equal(
        recorder.activityWrites.find(
          (a) => a.eventType === "plan_activated_this_week",
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  it("seam B: PATCH covers-now → not-covering does NOT stamp activatedAt (silent demotion)", async () => {
    const recorder: C4PatchRecorder = { instanceUpdates: [], updateManyCalls: [], activityWrites: [] };
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const harness = await mutationSpinUp(
      makeC4PatchStub({
        recorder,
        instances: [
          fixturePatch({
            id: "p-1",
            startDate: new Date(now - 3 * day),
            endDate: new Date(now + 3 * day),
          }),
        ],
      }),
    );
    try {
      // Demote: push to next week.
      const startDate = new Date(now + 7 * day).toISOString();
      const endDate = new Date(now + 13 * day).toISOString();
      const res = await patchPlan(harness, "p-1", { startDate, endDate });
      assert.equal(res.status, 200);

      const upd = recorder.instanceUpdates[0];
      // No stamp on demotion — silent.
      assert.equal(upd.data.activatedAt, undefined,
        "PATCH covers→not-covering must NOT stamp activatedAt");
      assert.equal(
        recorder.activityWrites.find(
          (a) => a.eventType === "plan_activated_this_week",
        ),
        undefined,
        "plan_activated_this_week must NOT emit on silent demotion",
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
  // WS7-7-A B5 fix2 — Meal.create calls issued by the fork helper.
  forkedMeals?: Array<Record<string, unknown>>;
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
      // Serves both the fork gate (reads userId/isPublic/isArchived) and the
      // fork helper's include read (dishLinks). Sources are synthesized minimal
      // (no dishes) — deep-clone fidelity is covered by mealFork.test.ts.
      findUnique: async (args: { where: { id: string } }) => {
        const m = meals.find((mm) => mm.id === args.where.id);
        if (!m) return null;
        return {
          userId: m.userId,
          isPublic: m.isPublic,
          isArchived: m.isArchived,
          title: m.title,
          description: null,
          mealType: "dinner",
          sourceType: "curated",
          cuisineType: null,
          difficulty: "easy",
          estimatedTimeMinutes: 30,
          imageUrl: null,
          servingsDefault: 4,
          tags: [] as string[],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          dishLinks: [] as unknown[],
        };
      },
      // WS7-7-A B5 fix2 — fork-on-acquire write.
      create: async (args: { data: Record<string, unknown> }) => {
        (recorder.forkedMeals ??= []).push(args.data);
        return { id: `fork-${(recorder.forkedMeals ?? []).length}` };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
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

  // WS7-7-A B5 fix2 (D-WS7-139) — fork-on-acquire at #2 add-to-plan.
  it("forks a curated (null-owner) meal on add and binds the item to the user-owned copy", async () => {
    const recorder: D1ItemRecorder = {
      itemCreates: [],
      instanceUpdates: [],
      activityWrites: [],
    };
    const harness = await mutationSpinUp(
      makeD1Stub({
        recorder,
        plans: [{ id: "p-1", userId: A2_USER, revisionId: 2 }],
        // r-pasta-shaped: a public, curated, null-owner catalog meal.
        meals: [
          { id: "r-pasta", userId: null, isPublic: true, isArchived: false, title: "Creamy Mushroom Pasta" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "r-pasta" });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { item: { mealId: string } };

      // The item binds to the fork, NOT the curated null-owner meal.
      assert.equal(recorder.itemCreates.length, 1);
      const bound = recorder.itemCreates[0].data.mealId as string;
      assert.ok(bound.startsWith("fork-"), "item rebinds to a forked meal");
      assert.equal(body.item.mealId, bound);

      // One fork minted, user-owned + private → the me.ts:1160 ownership gate
      // (meal.userId === null || !== userId) now PASSES for this bound meal,
      // so a subsequent PATCH /me/meals would not 403 (Failure 2 fixed).
      assert.equal(recorder.forkedMeals?.length, 1);
      assert.equal(recorder.forkedMeals?.[0].userId, A2_USER);
      assert.equal(recorder.forkedMeals?.[0].isPublic, false);
    } finally {
      await harness.close();
    }
  });

  // Boundary: a meal the requester already owns is bound as-is (no self-copy).
  it("does NOT fork a meal the requester already owns (binds as-is)", async () => {
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
          { id: "m-own", userId: A2_USER, isPublic: false, isArchived: false, title: "Mine" },
        ],
      }),
    );
    try {
      const res = await postPlanItem(harness, "p-1", { mealId: "m-own" });
      assert.equal(res.status, 201);
      assert.equal(recorder.itemCreates[0].data.mealId, "m-own");
      assert.equal(recorder.forkedMeals, undefined);
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
  // WS7-7-A B5 fix2 — Meal.create calls issued by the swap fork helper.
  forkedMeals?: Array<Record<string, unknown>>;
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
      // Serves the swap fork gate (userId/isPublic/isArchived) AND the fork
      // helper's include read (dishLinks). Minimal source — deep-clone fidelity
      // is covered by mealFork.test.ts.
      findUnique: async (args: { where: { id: string } }) => {
        const m = meals.find((mm) => mm.id === args.where.id);
        if (!m) return null;
        return {
          userId: m.userId,
          isPublic: m.isPublic,
          isArchived: m.isArchived,
          title: m.title,
          description: null,
          mealType: "dinner",
          sourceType: "curated",
          cuisineType: null,
          difficulty: "easy",
          estimatedTimeMinutes: 30,
          imageUrl: null,
          servingsDefault: 4,
          tags: [] as string[],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          dishLinks: [] as unknown[],
        };
      },
      // WS7-7-A B5 fix2 — fork-on-acquire write on swap-in.
      create: async (args: { data: Record<string, unknown> }) => {
        (recorder.forkedMeals ??= []).push(args.data);
        return { id: `fork-${(recorder.forkedMeals ?? []).length}` };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [] as unknown[],
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

  // WS7-7-A B5 fix2 (D-WS7-139) — fork-on-acquire at #4 swap. Swapping in a
  // curated (null-owner) meal forks it; the new item binds to the user-owned
  // copy. (Swapping to an already-owned meal — the test above — binds as-is.)
  it("forks a curated meal swapped in and binds the new item to the user-owned copy", async () => {
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
          { id: "r-pasta", userId: null, isPublic: true, isArchived: false, title: "Creamy Mushroom Pasta" },
        ],
        items: [
          d3ItemFix({
            id: "it-old", mealPlanInstanceId: "p-1", mealId: "m-old",
            positionIndex: 2, assignedDayOfWeek: "Friday",
          }),
        ],
      }),
    );
    try {
      const res = await patchPlanItemReq(harness, "p-1", "it-old", { mealId: "r-pasta" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { item: { mealId: string } };

      // The swapped-in item binds to the fork, not the curated null-owner meal.
      const created = recorder.itemCreates[0].data;
      assert.ok(String(created.mealId).startsWith("fork-"));
      assert.equal(body.item.mealId, created.mealId);

      // One fork minted, user-owned + private (the me.ts:1160 gate now passes).
      assert.equal(recorder.forkedMeals?.length, 1);
      assert.equal(recorder.forkedMeals?.[0].userId, A2_USER);
      assert.equal(recorder.forkedMeals?.[0].isPublic, false);
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
    // Block 4a — forkMealForUser resolves the acquiring household once per fork
    // inside the tx; no prefs row in these stubs → forks keep source servings.
    userPreferences: { findUnique: async () => null },
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
