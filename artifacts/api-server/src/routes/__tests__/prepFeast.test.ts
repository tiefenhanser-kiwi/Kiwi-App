// PREP-1 (D-WS9-314) — Thanksgiving prep, Option 2. The feast (a meal tagged
// `thanksgiving-feast`) leaves the full week (Part B) and is prepped in a session
// of its own, keyed apart (Part D). Real Express + JWT; loader + AI stubbed at
// the deps boundary, Prisma stubbed in memory.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { PrepWeekUnknownMealError, type LoadPrepWeekInputResult, type PrepLoadedPlan } from "../../lib/prepWeekAggregation";
import type { PrepWeekResult } from "../../lib/ai/schemas/prepWeek";
import { loadPrepStepSet } from "../../lib/prepStepSet";
import { createCookingRouter } from "../cooking";
import { withSessionUser } from "./fixtures/sessionUserStub";

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "u-feast";
export const WEEKNIGHT = "11111111-1111-4111-8111-111111111111";
export const FEAST = "22222222-2222-4222-8222-222222222222";
export const FRIDAY = "33333333-3333-4333-8333-333333333333";
const ONION = "a0000000-0000-4000-8000-000000000001";
const CARROT = "a0000000-0000-4000-8000-000000000002";
const CELERY = "a0000000-0000-4000-8000-000000000003";
const CABBAGE = "a0000000-0000-4000-8000-000000000004";

const veg = (ingredientId: string, ingredientName: string, preparationNote = "diced") => ({
  ingredientId, ingredientName, category: "Produce", quantity: 1, unit: "each", preparationNote, sourceYield: null,
});
const dish = (n: number, dishName: string, ingredients: ReturnType<typeof veg>[]) => ({
  dishId: `d${n}000000-0000-4000-8000-000000000000`, dishName, dishRole: "main" as const,
  baseServings: 4, authoredBaseServings: 4, ingredients, stepTexts: [], componentSteps: [],
});

/** Mon weeknight (onion, carrot), Thu feast (onion, celery), Fri leftovers (cabbage). */
export function feastWeek(opts: { feastTagged?: boolean } = {}): LoadPrepWeekInputResult {
  const input: PrepLoadedPlan = {
    planId: PLAN_ID,
    planName: "Thanksgiving week",
    meals: [
      { mealId: WEEKNIGHT, mealName: "Weeknight Stir Fry", cuisine: null, servingsOverride: null, dishes: [dish(1, "Stir Fry", [veg(ONION, "yellow onion"), veg(CARROT, "carrot")])] },
      {
        mealId: FEAST, mealName: "Classic Thanksgiving", cuisine: null, servingsOverride: 10,
        dishes: [dish(2, "Sage Stuffing", [veg(ONION, "yellow onion"), veg(CELERY, "celery")])],
        ...(opts.feastTagged === false ? {} : { feast: true as const }),
      },
      { mealId: FRIDAY, mealName: "Leftover Sandwiches", cuisine: null, servingsOverride: null, dishes: [dish(3, "Slaw", [veg(CABBAGE, "green cabbage", "shredded")])] },
    ],
  };
  return {
    input,
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-11-22",
      lagByMealId: new Map([[WEEKNIGHT, 1], [FEAST, 4], [FRIDAY, 5]]),
      dayNameByMealId: new Map([[WEEKNIGHT, "Monday"], [FEAST, "Thursday"], [FRIDAY, "Friday"]]),
    },
    identity: { foldedIdByIngredientId: new Map() },
  };
}

export function loaderStub(load: () => LoadPrepWeekInputResult) {
  return (async (params: { planId: string; mealIds?: string[] }) => {
    const l = load();
    const unknown = (params.mealIds ?? []).filter((id) => !l.input.meals.some((m) => m.mealId === id));
    if (unknown.length > 0) throw new PrepWeekUnknownMealError(params.planId, unknown);
    return l;
  }) as never;
}

export function memoryPrisma() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = new Map<string, any>();
  let completions: { planId: string; stepKey: string }[] = [];
  return {
    rows,
    keys: () => completions.map((c) => c.stepKey).sort(),
    seed: (stepKey: string) => completions.push({ planId: PLAN_ID, stepKey }),
    prisma: {
      prepWeekStructure: {
        findUnique: async ({ where }: { where: { planId: string } }) => rows.get(where.planId) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upsert: async ({ where, create, update }: any) => {
          const ex = rows.get(where.planId);
          const next = ex ? { ...ex, ...update } : { ...create };
          rows.set(where.planId, next);
          return next;
        },
      },
      prepStepCompletion: {
        findMany: async () => completions.map((c) => ({ stepKey: c.stepKey, checkedAt: new Date() })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deleteMany: async ({ where }: any) => {
          const before = completions.length;
          completions = completions.filter((c) => {
            if (c.planId !== where.planId) return true;
            if (where.stepKey?.startsWith !== undefined) {
              const inList = (where.stepKey.notIn as string[] | undefined)?.includes(c.stepKey) ?? false;
              return !(c.stepKey.startsWith(where.stepKey.startsWith) && !inList);
            }
            if (where.stepKey?.notIn) return (where.stepKey.notIn as string[]).includes(c.stepKey);
            return c.stepKey !== where.stepKey;
          });
          return { count: before - completions.length };
        },
      },
    },
  };
}

export function narrationStub(calls: { stepIds: string[] }[]) {
  return (async (_k: string, vars: { prepNarrationInput: { steps: { stepId: string }[] } }) => {
    const steps = vars.prepNarrationInput.steps;
    calls.push({ stepIds: steps.map((s) => s.stepId) });
    return {
      success: true,
      data: { steps: steps.map((s, i) => ({ stepId: s.stepId, title: `Step ${i + 1}`, instructions: `Do step ${i + 1}.` })) },
      metadata: { promptKey: "prep.narrate_steps", promptVersion: 21, model: "stub", mode: "tool", latencyMs: 1, inputTokens: 1, outputTokens: 1, costEstimateUsd: 0, retryCount: 0 },
    };
  }) as never;
}

export async function spin(deps: Parameters<typeof createCookingRouter>[0]) {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createCookingRouter({
    ...deps,
    prisma: withSessionUser(deps?.prisma) as never,
    resolvePromptDescriptor: (async () => ({ body: "", defaultModel: "stub", defaultMode: "tool", toolDescription: "", version: 21 })) as never,
    subscriptionService: { can: async () => ({ allowed: true }) } as never,
  }));
  return await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/plans/${PLAN_ID}/prep-week`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${signToken(USER)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as { result: PrepWeekResult; reason?: string; [k: string]: unknown } };
}

const mealsOf = (r: PrepWeekResult) => [...new Set(r.phases.flatMap((p) => p.steps.flatMap((s) => s.contributesToMealIds)))].sort();
const namesOf = (r: PrepWeekResult) => r.phases.flatMap((p) => p.steps).map((s) => s.stepKey);

describe("PREP-1 Part B — the feast leaves the full week", () => {
  it("Prep the Week covers the weeknight and Friday only, and narrates nothing of the feast", async () => {
    const calls: { stepIds: string[] }[] = [];
    const mem = memoryPrisma();
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: mem.prisma as never, runAICall: narrationStub(calls) });
    try {
      const { status, body } = await post(h.url);
      assert.equal(status, 200);
      assert.deepEqual(mealsOf(body.result), [WEEKNIGHT, FRIDAY].sort());
      assert.ok(!namesOf(body.result).includes(`produce#${CELERY}`), "the feast's celery is in the core week");
      assert.equal(calls.length, 1);
    } finally {
      await h.close();
    }
  });

  it("without the tag the feast is just a meal — the same week, the feast in it", async () => {
    const calls: { stepIds: string[] }[] = [];
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek({ feastTagged: false })), prisma: memoryPrisma().prisma as never, runAICall: narrationStub(calls) });
    try {
      const { body } = await post(h.url);
      assert.deepEqual(mealsOf(body.result), [WEEKNIGHT, FEAST, FRIDAY].sort());
    } finally {
      await h.close();
    }
  });

  it("Prep Selected Meals drops the feast; naming only the feast is a 400 that costs nothing", async () => {
    const calls: { stepIds: string[] }[] = [];
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: memoryPrisma().prisma as never, runAICall: narrationStub(calls) });
    try {
      const both = await post(h.url, { mealIds: [WEEKNIGHT, FEAST] });
      assert.equal(both.status, 200);
      assert.deepEqual(mealsOf(both.body.result), [WEEKNIGHT]);
      const only = await post(h.url, { mealIds: [FEAST] });
      assert.equal(only.status, 400);
      assert.equal(only.body.reason, "feast_has_own_prep");
      assert.equal(calls.length, 1, "the feast-only selection called the narrator");
    } finally {
      await h.close();
    }
  });

  it("the core step set (isPrepped) gives the feast no steps of its own", async () => {
    const refs = await loadPrepStepSet({
      planId: PLAN_ID, userId: USER, prisma: {} as never,
      loadPrepWeekInput: loaderStub(() => feastWeek()),
    });
    const core = refs.filter((r) => !r.stepKey.startsWith("feast#"));
    assert.ok(core.length > 0);
    assert.ok(core.every((r) => !r.contributesToMealIds.includes(FEAST)));
  });
});
