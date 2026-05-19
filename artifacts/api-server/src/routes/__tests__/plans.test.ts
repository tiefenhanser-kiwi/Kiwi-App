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
