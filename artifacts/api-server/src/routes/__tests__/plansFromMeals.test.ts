// WS9 Redesign Arc Block 1 (D-WS9-237) — POST /api/plans/from-meals.
//
// One ACTIVE plan from exactly the picked meals: public ids fork
// (D-WS7-139), owned ids bind as-is, a foreign private id is 403, a missing
// id is 404; the instance is dated this week with activatedAt + committedAt,
// isWizardDraft:false; NO draft row, NO WizardLastBatch upsert; items in the
// order given; days assigned + persisted (first planDurationDays only).
//
// The fork stub mirrors plans.test.ts's C4 stub: sources are synthesized
// minimal (dishLinks: []) — clone fidelity is lib/__tests__/mealFork.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { currentWeekRange, resolveThisWeekPlan } from "../../lib/planDates";
import { addUtcDays, todayFor, tomorrowUtc } from "../../lib/planDayAssignment";
import { createPlansRouter } from "../plans";
import { withSessionUser } from "./fixtures/sessionUserStub";

const U = "from-meals-user";

interface Recorder {
  createdInstances: Array<Record<string, unknown>>;
  createManyItems: Array<Record<string, unknown>>;
  itemUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  forkedFrom: string[];
  templatesCreated: Array<Record<string, unknown>>;
  activities: Array<Record<string, unknown>>;
  lastBatchUpserts: number;
  firstPlanStamps: number;
}

interface SourceMeal {
  id: string;
  userId: string | null;
  isPublic: boolean;
  isArchived?: boolean;
  categories?: string[];
  activeTimeMinutes?: number | null;
  estimatedTimeMinutes?: number;
  difficulty?: string;
}

function makeStub(opts: { meals: SourceMeal[]; priorWinner?: { id: string; title: string } }) {
  const rec: Recorder = {
    createdInstances: [],
    createManyItems: [],
    itemUpdates: [],
    forkedFrom: [],
    templatesCreated: [],
    activities: [],
    lastBatchUpserts: 0,
    firstPlanStamps: 0,
  };
  const meals = new Map(opts.meals.map((m) => [m.id, m]));
  const forkSource = new Map<string, string>(); // forkId → sourceId
  let forkN = 0;
  const items: Array<{ id: string; mealId: string; positionIndex: number }> = [];

  const mealRow = (id: string) => {
    const src = meals.get(forkSource.get(id) ?? id);
    return {
      id,
      activeTimeMinutes: src?.activeTimeMinutes ?? 20,
      estimatedTimeMinutes: src?.estimatedTimeMinutes ?? 40,
      difficulty: src?.difficulty ?? "easy",
      dishLinks: [
        {
          dish: {
            dishIngredients: (src?.categories ?? ["Pantry"]).map((category) => ({
              ingredient: { category, canonicalName: category.toLowerCase() },
            })),
          },
        },
      ],
    };
  };

  const tx = {
    userPreferences: { findUnique: async () => ({ householdSize: 3 }) },
    meal: {
      findMany: async (args: { where: { id: { in: string[] } }; select?: Record<string, unknown> }) => {
        if (args.select && "dishLinks" in args.select) {
          return args.where.id.in.map(mealRow);
        }
        return args.where.id.in
          .map((id) => meals.get(id))
          .filter((m): m is SourceMeal => !!m)
          .map((m) => ({ id: m.id, userId: m.userId, isPublic: m.isPublic, isArchived: m.isArchived ?? false }));
      },
      findUnique: async (args: { where: { id: string } }) => {
        const m = meals.get(args.where.id);
        if (!m) return null;
        return {
          id: m.id,
          userId: m.userId,
          title: `T-${m.id}`,
          displayTitle: null,
          description: null,
          mealType: "dinner",
          sourceType: "curated",
          cuisineType: null,
          difficulty: m.difficulty ?? "easy",
          estimatedTimeMinutes: m.estimatedTimeMinutes ?? 40,
          activeTimeMinutes: m.activeTimeMinutes ?? 20,
          imageUrl: null,
          servingsDefault: 4,
          authoredServingsDefault: 4,
          tags: [],
          allergens: [],
          allergensStampedAt: null,
          allergenSources: null,
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          dishLinks: [],
        };
      },
      create: async (args: { data: { sourceStoreMealId?: string; userId: string; isPublic: boolean } }) => {
        forkN += 1;
        const id = `fork-${forkN}`;
        forkSource.set(id, args.data.sourceStoreMealId ?? "?");
        rec.forkedFrom.push(args.data.sourceStoreMealId ?? "?");
        assert.equal(args.data.userId, U);
        assert.equal(args.data.isPublic, false);
        return { id };
      },
    },
    recipeInstructionStep: { findMany: async () => [] },
    mealPlanTemplate: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        rec.templatesCreated.push(args.data);
        return { id: "tpl-1" };
      },
    },
    mealPlanInstance: {
      // resolveThisWeekWinnerId reads the user's covering rows.
      findMany: async () =>
        opts.priorWinner
          ? [
              {
                id: opts.priorWinner.id,
                startDate: new Date(currentWeekRange().startDate),
                endDate: new Date(currentWeekRange().endDate),
                activatedAt: new Date("2026-01-01T00:00:00Z"),
                createdAt: new Date("2026-01-01T00:00:00Z"),
              },
            ]
          : [],
      findUnique: async (args: { where: { id: string } }) =>
        opts.priorWinner && args.where.id === opts.priorWinner.id
          ? { titleOverride: null, template: { title: opts.priorWinner.title } }
          : null,
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: "plan-1", revisionId: 1, ...args.data };
        rec.createdInstances.push(row);
        return { id: "plan-1", revisionId: 1 };
      },
    },
    mealPlanItem: {
      createMany: async (args: { data: Array<{ mealId: string; positionIndex: number }> }) => {
        for (const d of args.data) {
          items.push({ id: `item-${d.positionIndex}`, mealId: d.mealId, positionIndex: d.positionIndex });
          rec.createManyItems.push(d);
        }
        return { count: args.data.length };
      },
      findMany: async () => [...items].sort((a, b) => a.positionIndex - b.positionIndex),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        rec.itemUpdates.push(args);
        return {};
      },
    },
    userActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        rec.activities.push(args.data);
        return {};
      },
    },
    user: {
      updateMany: async () => {
        rec.firstPlanStamps += 1;
        return { count: 1 };
      },
    },
    wizardLastBatch: {
      upsert: async () => {
        rec.lastBatchUpserts += 1;
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async <T,>(cb: (t: typeof tx) => Promise<T>) => cb(tx),
    meal: tx.meal,
    mealPlanInstance: tx.mealPlanInstance,
    mealPlanItem: tx.mealPlanItem,
    userActivity: tx.userActivity,
    wizardLastBatch: tx.wizardLastBatch,
  };
  return { prisma, rec };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createPlansRouter({
      prisma: withSessionUser(prisma) as never,
      computePlanMacros: (async () => ({})) as never,
      planNeedsMacroEstimation: (async () => false) as never,
      mutationLimiterOpts: { capacity: 1000, refillPerSec: 100 },
    }),
  );
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("no bind"));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

async function post(h: Harness, body: unknown, userId = U) {
  const res = await fetch(`${h.baseUrl}/plans/from-meals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(userId)}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const MEALS: SourceMeal[] = [
  { id: "cat-fish", userId: null, isPublic: true, categories: ["Protein", "Produce"], activeTimeMinutes: 30 },
  { id: "cat-pasta", userId: null, isPublic: true, categories: ["Pantry", "Dairy"], activeTimeMinutes: 15 },
  { id: "own-chili", userId: U, isPublic: false, categories: ["Canned"], activeTimeMinutes: 10 },
  { id: "own-salad", userId: U, isPublic: false, categories: ["Produce"], activeTimeMinutes: 8 },
  { id: "theirs", userId: "someone-else", isPublic: false },
  { id: "archived", userId: null, isPublic: true, isArchived: true },
];

describe("POST /api/plans/from-meals", () => {
  it("forks public ids, binds owned ids, creates ONE active plan with days — no draft, no batch row", async () => {
    const { prisma, rec } = makeStub({ meals: MEALS, priorWinner: { id: "old-plan", title: "Old week" } });
    const h = await spinUp(prisma);
    try {
      const { status, json } = await post(h, {
        mealIds: ["cat-pasta", "own-chili", "cat-fish", "own-salad"],
        planDurationDays: 3,
        householdSize: 2,
        title: "Picked week",
      });
      assert.equal(status, 201);
      assert.equal(json.planId, "plan-1");
      assert.deepEqual(json.instance, { id: "plan-1", revisionId: 1 });
      assert.deepEqual(json.demoted, { id: "old-plan", name: "Old week" });

      // Forks: the two public ids, once each; owned ids never forked.
      assert.deepEqual(rec.forkedFrom, ["cat-pasta", "cat-fish"]);

      // Items in the order given, bound to the fork / the owned id.
      assert.deepEqual(
        rec.createManyItems.map((d) => [d.positionIndex, d.mealId, d.isDinner]),
        [
          [0, "fork-1", true],
          [1, "own-chili", true],
          [2, "fork-2", true],
          [3, "own-salad", true],
        ],
      );

      // The instance: ACTIVE, committed, never a draft — and (Block 2, Part D,
      // rule (a)) the window opens TODAY, the first meal is tomorrow, and it
      // ends on the last assigned day: today … tomorrow + 2 for the three
      // dated meals (the unassigned fourth pick does not extend the range).
      const inst = rec.createdInstances[0];
      const today = todayFor(undefined);
      const tomorrow = tomorrowUtc();
      const dayAfterNext = new Date(tomorrow.getTime() + 2 * 86_400_000);
      assert.equal(inst.isWizardDraft, false);
      assert.equal(inst.mealPlanTemplateId, "tpl-1");
      assert.ok(inst.activatedAt instanceof Date);
      assert.ok(inst.committedAt instanceof Date);
      assert.equal((inst.startDate as Date).toISOString(), today.toISOString());
      assert.equal((inst.endDate as Date).toISOString(), dayAfterNext.toISOString());
      assert.equal(json.startDate, today.toISOString().slice(0, 10));
      assert.equal(json.endDate, dayAfterNext.toISOString().slice(0, 10));
      assert.equal("wizardDraftPayload" in inst, false);
      // Range-containment (D-WS9-147): it is the this-week winner from the day
      // it is made ("active the day you make it"), through the last dinner.
      const row = {
        id: "plan-1",
        startDate: inst.startDate as Date,
        endDate: inst.endDate as Date,
        activatedAt: inst.activatedAt as Date,
        createdAt: new Date(),
      };
      assert.equal(resolveThisWeekPlan([row], new Date())?.id, "plan-1");
      assert.equal(resolveThisWeekPlan([row], tomorrow)?.id, "plan-1");
      assert.equal(resolveThisWeekPlan([row], dayAfterNext)?.id, "plan-1");
      assert.equal(resolveThisWeekPlan([row], new Date(dayAfterNext.getTime() + 86_400_000)), null);

      // Hidden template with the given title + the item count.
      assert.equal(rec.templatesCreated.length, 1);
      assert.equal(rec.templatesCreated[0].title, "Picked week");
      assert.equal(rec.templatesCreated[0].defaultDaysCount, 4);
      assert.equal(rec.templatesCreated[0].sourceType, "wizard");
      assert.equal(rec.templatesCreated[0].isPublic, false);

      // No WizardLastBatch upsert; first-plan stamp + activity fired.
      assert.equal(rec.lastBatchUpserts, 0);
      assert.equal(rec.firstPlanStamps, 1);
      assert.equal(rec.activities.length, 1);
      assert.equal(rec.activities[0].eventType, "plan_activated_this_week");
      assert.equal((rec.activities[0].metadata as any).source, "plans_from_meals");

      // Days: 4 meals, 3 days → the first three dated (fish first — Protein;
      // then pasta — Dairy; then chili — Canned, the easiest last); the fourth
      // (own-salad) left unassigned. Written on the items at create (F3).
      assert.equal(rec.itemUpdates.length, 0, "no post-hoc update: days ride the createMany");
      const items = rec.createManyItems;
      assert.equal(items[3].assignedDayOfWeek, null, "the 4th pick has no day");
      assert.equal(items[3].assignedDate, null);
      const dated = items.slice(0, 3).map((d) => d.assignedDate as Date);
      // item-2 (fish) is day 0, item-0 (pasta) day 1, item-1 (chili) day 2.
      assert.ok(dated[2] < dated[0] && dated[0] < dated[1]);
      assert.equal(dated[2].toISOString(), tomorrow.toISOString());
      assert.equal(typeof items[0].assignedDayOfWeek, "string");
      // The response echoes the assignment (YYYY-MM-DD).
      assert.equal(json.days.length, 4);
      assert.equal(json.days[3].assignedDayOfWeek, null);
      assert.match(json.days[0].assignedDate, /^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await h.close();
    }
  });

  it("uses the stored household when the body has none; defaults the title", async () => {
    const { prisma, rec } = makeStub({ meals: MEALS });
    const h = await spinUp(prisma);
    try {
      const { status, json } = await post(h, { mealIds: ["own-chili"], planDurationDays: 1 });
      assert.equal(status, 201);
      assert.equal(json.demoted, null);
      // A one-day plan: the window opens today, its one dinner is tomorrow.
      assert.equal(json.startDate, todayFor(undefined).toISOString().slice(0, 10));
      assert.equal(json.endDate, tomorrowUtc().toISOString().slice(0, 10));
      assert.equal(rec.templatesCreated[0].title, "Your picks");
      assert.deepEqual(rec.forkedFrom, []);
    } finally {
      await h.close();
    }
  });

  // WS9 Redesign Arc Block 2 (Part D) — rules (a) + (e). "Today" is the
  // client's local calendar day; the window opens on it, the first meal is
  // the next day, the window ends on the last assigned day.
  it("Part D (a): a Wednesday-created 7-day plan (localDate Wed) → startDate Wed, first meal Thu, endDate the following Wed, this-week winner ON Wednesday", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `own-${i}`,
      userId: U,
      isPublic: false,
      categories: ["Pantry"],
      activeTimeMinutes: 20 + i,
    }));
    const { prisma, rec } = makeStub({ meals: seven });
    const h = await spinUp(prisma);
    try {
      const wed = "2026-09-16"; // a Wednesday
      const { status, json } = await post(h, {
        mealIds: seven.map((m) => m.id),
        planDurationDays: 7,
        localDate: wed,
      });
      assert.equal(status, 201);
      assert.equal(json.startDate, "2026-09-16");
      assert.equal(new Date(json.startDate).getUTCDay(), 3, "starts on the Wednesday");
      assert.equal(json.endDate, "2026-09-23", "ends the following Wednesday (7 dinners Thu … Wed)");
      const dates = (json.days as { assignedDate: string | null }[]).map((d) => d.assignedDate).sort();
      assert.equal(dates[0], "2026-09-17", "first meal is Thursday");
      assert.equal(dates[6], "2026-09-23");
      // This-week winner ON the Wednesday it was made.
      const inst = rec.createdInstances[0];
      const row = {
        id: "plan-1",
        startDate: inst.startDate as Date,
        endDate: inst.endDate as Date,
        activatedAt: inst.activatedAt as Date,
        createdAt: new Date(),
      };
      assert.equal(resolveThisWeekPlan([row], new Date("2026-09-16T15:00:00Z"))?.id, "plan-1");
      assert.equal(resolveThisWeekPlan([row], new Date("2026-09-15T15:00:00Z")), null);
    } finally {
      await h.close();
    }
  });

  it("Part D (e): localDate 2026-09-19 sent at 01:26Z on the 20th → first meal 2026-09-20 (not Monday the 21st)", async () => {
    const { prisma } = makeStub({ meals: MEALS });
    const h = await spinUp(prisma);
    try {
      // Hans's own example: Saturday 9:26 PM ET is 01:26Z Sunday. In UTC days
      // the first meal would land on MONDAY; with the client's calendar day it
      // is Sunday.
      const { status, json } = await post(h, {
        mealIds: ["own-chili"],
        planDurationDays: 1,
        localDate: "2026-09-19",
      });
      assert.equal(status, 201);
      assert.equal(json.startDate, "2026-09-19");
      assert.equal(json.days[0].assignedDate, "2026-09-20");
      assert.equal(json.days[0].assignedDayOfWeek, "Sunday");
      assert.equal(json.endDate, "2026-09-20");
      // Sanity: the UTC-day reading of that instant WOULD have been Monday.
      assert.equal(addUtcDays(new Date("2026-09-20T01:26:00Z"), 1).getUTCDay(), 1);
    } finally {
      await h.close();
    }
  });

  it("Part D (e): a malformed localDate is a 400", async () => {
    const { prisma, rec } = makeStub({ meals: MEALS });
    const h = await spinUp(prisma);
    try {
      for (const bad of ["2026-9-19", "19/09/2026", "2026-09-19T00:00:00Z", "2026-02-30", 20260919]) {
        const { status } = await post(h, { mealIds: ["own-chili"], planDurationDays: 1, localDate: bad });
        assert.equal(status, 400, `localDate ${String(bad)} must be rejected`);
      }
      assert.equal(rec.createdInstances.length, 0);
    } finally {
      await h.close();
    }
  });

  it("403 for another user's private meal; 404 for a missing or archived id; nothing written", async () => {
    const { prisma, rec } = makeStub({ meals: MEALS });
    const h = await spinUp(prisma);
    try {
      const forbidden = await post(h, { mealIds: ["own-chili", "theirs"], planDurationDays: 2 });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.json.mealId, "theirs");
      const missing = await post(h, { mealIds: ["nope"], planDurationDays: 1 });
      assert.equal(missing.status, 404);
      const archived = await post(h, { mealIds: ["archived"], planDurationDays: 1 });
      assert.equal(archived.status, 404);
      assert.equal(rec.createdInstances.length, 0);
      assert.equal(rec.forkedFrom.length, 0);
    } finally {
      await h.close();
    }
  });

  it("validates the body (1..14 ids, 1..7 days) and requires auth", async () => {
    const { prisma } = makeStub({ meals: MEALS });
    const h = await spinUp(prisma);
    try {
      assert.equal((await post(h, { mealIds: [], planDurationDays: 3 })).status, 400);
      assert.equal(
        (await post(h, { mealIds: Array.from({ length: 15 }, (_, i) => `m${i}`), planDurationDays: 3 })).status,
        400,
      );
      assert.equal((await post(h, { mealIds: ["own-chili"], planDurationDays: 8 })).status, 400);
      const res = await fetch(`${h.baseUrl}/plans/from-meals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mealIds: ["own-chili"], planDurationDays: 1 }),
      });
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });

  it("a public id picked twice forks once and binds both items to the same fork", async () => {
    const { prisma, rec } = makeStub({ meals: MEALS });
    const h = await spinUp(prisma);
    try {
      const { status } = await post(h, { mealIds: ["cat-fish", "cat-fish"], planDurationDays: 2 });
      assert.equal(status, 201);
      assert.deepEqual(rec.forkedFrom, ["cat-fish"]);
      assert.deepEqual(
        rec.createManyItems.map((d) => d.mealId),
        ["fork-1", "fork-1"],
      );
    } finally {
      await h.close();
    }
  });
});
