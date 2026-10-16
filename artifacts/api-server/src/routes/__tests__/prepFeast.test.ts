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
/** A celery row only a weeknight has, under a SMALLER id than the feast's celery. */
const CELERY_RIBS = "a0000000-0000-4000-8000-000000000000";

export function feastWeek(opts: { feastTagged?: boolean; weeknight?: "stir-fry" | "slaw" | "celery-ribs"; feastServings?: number; fold?: Map<string, string> } = {}): LoadPrepWeekInputResult {
  // PREP-1 G — Monday can be swapped for a dinner that leads with the feast's celery,
  // which re-orders the produce of a whole-plan build; or for one whose "celery ribs"
  // row folds with the feast's celery under a smaller id.
  const monday = opts.weeknight === "slaw"
    ? { mealId: WEEKNIGHT, mealName: "Celery Slaw Bowls", cuisine: null, servingsOverride: null, dishes: [dish(4, "Celery Slaw", [veg(CELERY, "celery", "thinly sliced"), veg(CABBAGE, "green cabbage", "shredded")])] }
    : opts.weeknight === "celery-ribs"
      ? { mealId: WEEKNIGHT, mealName: "Celery Soup", cuisine: null, servingsOverride: null, dishes: [dish(5, "Celery Soup", [veg(CELERY_RIBS, "celery ribs", "chopped")])] }
      : { mealId: WEEKNIGHT, mealName: "Weeknight Stir Fry", cuisine: null, servingsOverride: null, dishes: [dish(1, "Stir Fry", [veg(ONION, "yellow onion"), veg(CARROT, "carrot")])] };
  const input: PrepLoadedPlan = {
    planId: PLAN_ID,
    planName: "Thanksgiving week",
    meals: [
      monday,
      {
        mealId: FEAST, mealName: "Classic Thanksgiving", cuisine: null, servingsOverride: opts.feastServings ?? 10,
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
    identity: { foldedIdByIngredientId: opts.fold ?? new Map() },
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
    // The limiter's store is module-global; this file posts well past 12/min.
    rateLimiterOpts: { capacity: 1000, refillPerSec: 1000 },
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

type Envelope = { result: PrepWeekResult; cacheHit: boolean; session?: string; sessionDay?: string; reason?: string };

describe("PREP-1 Part D — Prep the feast", () => {
  it("one session over the feast alone, every key `feast#`, labelled Wednesday; the second open is a cache hit", async () => {
    const calls: { stepIds: string[] }[] = [];
    const mem = memoryPrisma();
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: mem.prisma as never, runAICall: narrationStub(calls) });
    try {
      const first = (await post(h.url, { session: "feast" })) as { status: number; body: Envelope };
      assert.equal(first.status, 200);
      assert.equal(first.body.session, "feast");
      assert.equal(first.body.sessionDay, "Wednesday");
      assert.equal(first.body.cacheHit, false);
      assert.deepEqual(mealsOf(first.body.result), [FEAST]);
      const keys = namesOf(first.body.result);
      assert.ok(keys.length > 0 && keys.every((k) => k.startsWith("feast#") && k.length <= 80), keys.join(", "));
      assert.ok(keys.includes(`feast#produce#${CELERY}`));
      assert.equal(calls.length, 1);
      // Stored in the week's row, inside its JSON, under the ENGINE's keys.
      const row = mem.rows.get(PLAN_ID);
      assert.equal(row.compositionFingerprint, null, "a feast-created row must read as a miss for the week");
      assert.ok(row.structureJson.feastSession.result.phases.flatMap((p: { steps: { stepKey: string }[] }) => p.steps).every((s: { stepKey: string }) => !s.stepKey.startsWith("feast#")));

      const again = (await post(h.url, { session: "feast" })) as { status: number; body: Envelope };
      assert.equal(again.body.cacheHit, true);
      assert.deepEqual(namesOf(again.body.result), keys);
      assert.equal(calls.length, 1, "a cached feast session narrated again");
    } finally {
      await h.close();
    }
  });

  it("the week and the feast share a row and miss independently; the week's result never carries the feast blob", async () => {
    const calls: { stepIds: string[] }[] = [];
    const mem = memoryPrisma();
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: mem.prisma as never, runAICall: narrationStub(calls) });
    try {
      await post(h.url, { session: "feast" });
      const week = await post(h.url);
      assert.equal(week.status, 200);
      assert.equal(calls.length, 2);
      assert.ok(mem.rows.get(PLAN_ID).structureJson.feastSession, "the week's write dropped the feast session");
      const weekHit = await post(h.url);
      assert.equal((weekHit.body as unknown as Envelope).cacheHit, true);
      assert.ok(!("feastSession" in weekHit.body.result));
      const feastHit = (await post(h.url, { session: "feast" })) as { status: number; body: Envelope };
      assert.equal(feastHit.body.cacheHit, true);
      assert.equal(calls.length, 2);
    } finally {
      await h.close();
    }
  });

  it("🔴 the week's regeneration keeps the feast's ticks (the keep-list)", async () => {
    const mem = memoryPrisma();
    mem.seed(`feast#produce#${CELERY}`);
    mem.seed(`feast#produce#${ONION}`);
    mem.seed(`produce#${ONION}`);
    mem.seed("produce#gone-from-the-plan");
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: mem.prisma as never, runAICall: narrationStub([]) });
    try {
      assert.equal((await post(h.url)).status, 200);
      assert.deepEqual(mem.keys(), [`feast#produce#${CELERY}`, `feast#produce#${ONION}`, `produce#${ONION}`].sort());
    } finally {
      await h.close();
    }
  });

  it("the feast's regeneration prunes only stale `feast#` keys", async () => {
    const mem = memoryPrisma();
    mem.seed(`feast#produce#${CELERY}`);
    mem.seed("feast#produce#stale");
    mem.seed("produce#weeknight-only");
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: mem.prisma as never, runAICall: narrationStub([]) });
    try {
      assert.equal((await post(h.url, { session: "feast" })).status, 200);
      assert.deepEqual(mem.keys(), [`feast#produce#${CELERY}`, "produce#weeknight-only"].sort());
    } finally {
      await h.close();
    }
  });

  it("🔴 the onion shared by the weeknight and the stuffing is two checkboxes, not one (the prefix)", async () => {
    const refs = await loadPrepStepSet({ planId: PLAN_ID, userId: USER, prisma: {} as never, loadPrepWeekInput: loaderStub(() => feastWeek()) });
    const core = refs.filter((r) => !r.contributesToMealIds.includes(FEAST)).map((r) => r.stepKey);
    const feast = refs.filter((r) => r.contributesToMealIds.includes(FEAST)).map((r) => r.stepKey);
    assert.ok(core.includes(`produce#${ONION}`), "fixture: the weeknight's onion");
    assert.ok(feast.length > 0);
    assert.deepEqual(feast.filter((k) => core.includes(k)), [], "a feast step shares a key with the week");
    assert.ok(refs.every((r) => r.contributesToMealIds.length > 0));
    // Ticking the week's onion does not prep the feast; ticking the feast's steps does.
    const { derivePrepCompletion } = await import("../../lib/prepCompletion");
    const weekOnly = derivePrepCompletion([WEEKNIGHT, FEAST, FRIDAY], refs, new Set(core));
    assert.equal(weekOnly.perMeal[FEAST], false);
    assert.equal(derivePrepCompletion([WEEKNIGHT, FEAST, FRIDAY], refs, new Set(feast)).perMeal[FEAST], true);
  });

  it("the feast session is Wednesday's: from Sunday, the feast is 1 day out, not 4", async () => {
    const { buildFeastSession } = await import("../../lib/prepWeekBuild");
    const build = buildFeastSession(feastWeek())!;
    assert.ok(build.stepPlan.steps.every((s) => (s.daysUntilCook ?? 0) <= 1));
    assert.equal(build.holds.size, 0, "a feast portion was held for cook day in the feast's own session");
  });

  it("refusals: no feast in the plan, and a feast session with a meal selection", async () => {
    const calls: { stepIds: string[] }[] = [];
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek({ feastTagged: false })), prisma: memoryPrisma().prisma as never, runAICall: narrationStub(calls) });
    try {
      const none = await post(h.url, { session: "feast" });
      assert.equal(none.status, 400);
      assert.equal(none.body.reason, "no_feast");
      const both = await post(h.url, { session: "feast", mealIds: [FEAST] });
      assert.equal(both.status, 400);
      assert.equal(calls.length, 0);
    } finally {
      await h.close();
    }
  });

  it("the free structure route carries the feast's steps under their own keys", async () => {
    const h = await spin({ loadPrepWeekInput: loaderStub(() => feastWeek()), prisma: memoryPrisma().prisma as never, runAICall: narrationStub([]) });
    try {
      const res = await fetch(`${h.url}/structure`, { headers: { Authorization: `Bearer ${signToken(USER)}` } });
      const body = (await res.json()) as { steps: { stepKey: string; contributesToMealIds: string[] }[] };
      const feast = body.steps.filter((s) => s.contributesToMealIds.includes(FEAST));
      assert.ok(feast.length > 0 && feast.every((s) => s.stepKey.startsWith("feast#")));
      assert.ok(body.steps.some((s) => s.stepKey === `produce#${ONION}`));
    } finally {
      await h.close();
    }
  });
});

describe("PREP-1 G — the feast session's cache is the feast's alone", () => {
  it("swapping a weeknight keeps the feast cached; changing the feast's servings re-narrates", async () => {
    const calls: { stepIds: string[] }[] = [];
    const mem = memoryPrisma();
    let load = () => feastWeek();
    const h = await spin({ loadPrepWeekInput: loaderStub(() => load()), prisma: mem.prisma as never, runAICall: narrationStub(calls) });
    try {
      assert.equal((await post(h.url, { session: "feast" })).status, 200);
      assert.equal(calls.length, 1);
      load = () => feastWeek({ weeknight: "slaw" });
      const swapped = (await post(h.url, { session: "feast" })) as { status: number; body: Envelope };
      assert.equal(swapped.body.cacheHit, true, "a weeknight swap re-narrated the feast");
      assert.equal(calls.length, 1);
      load = () => feastWeek({ weeknight: "slaw", feastServings: 12 });
      const resized = (await post(h.url, { session: "feast" })) as { status: number; body: Envelope };
      assert.equal(resized.body.cacheHit, false);
      assert.equal(calls.length, 2);
    } finally {
      await h.close();
    }
  });

  it("the session itself does not move with a weeknight: same narration input, same keys", async () => {
    const { buildFeastSession } = await import("../../lib/prepWeekBuild");
    const a = buildFeastSession(feastWeek())!;
    const b = buildFeastSession(feastWeek({ weeknight: "slaw" }))!;
    assert.equal(JSON.stringify(b.stepPlan.narrationInput), JSON.stringify(a.stepPlan.narrationInput));
    assert.deepEqual(b.stepPlan.steps.map((s) => s.stepKey), a.stepPlan.steps.map((s) => s.stepKey));
  });

  it("a weeknight's row cannot decide a feast food's key, so a swap never orphans a feast tick", async () => {
    const { buildFeastSession } = await import("../../lib/prepWeekBuild");
    // Monday's "celery ribs" folds with the feast's celery (the loader's map sends
    // both to the smaller id, Monday's). A whole-plan build would key the feast's
    // celery on Monday's row; swap Monday out and that key — and its tick — is gone.
    const withRibs = buildFeastSession(feastWeek({ weeknight: "celery-ribs", fold: new Map([[CELERY, CELERY_RIBS]]) }))!;
    const without = buildFeastSession(feastWeek())!;
    assert.ok(withRibs.stepPlan.steps.some((s) => s.stepKey === `produce#${CELERY}`));
    assert.deepEqual(withRibs.stepPlan.steps.map((s) => s.stepKey), without.stepPlan.steps.map((s) => s.stepKey));
  });
});
