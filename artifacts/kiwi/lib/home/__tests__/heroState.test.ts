// WS7-3 Block C2 Commit 1 — unit tests for the pure Hero-card state
// derivation. Pure functions, no React / no JSX — runs under the bare
// node:test + --experimental-strip-types harness (Phase 1 §10).

import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveHeroModel, planDurationDays } from "../heroState";
import type { HomePayload } from "@/lib/api/home";

// A list-shaped meal — the `todaysMeal.meal` embed shape (GET /home).
const MEAL = {
  id: "meal-1",
  title: "Salmon Teriyaki",
  cuisine: "Japanese",
  minutes: 30,
  servings: 4,
  authoredServingsDefault: 4,
  calories: 540,
  protein: 38,
  carbs: 32,
  fat: 24,
  tags: ["seafood"],
  image: null,
};

// A compact plan summary — the GET /home `activePlan` shape.
const PLAN_SUMMARY = {
  id: "plan-1",
  name: "Spice It Up",
  status: "this_week",
  startDate: "2026-05-18T00:00:00.000Z",
  endDate: "2026-05-24T00:00:00.000Z",
  revisionId: 3,
};

function mkPayload(over: Partial<HomePayload>): HomePayload {
  return {
    todaysMeal: null,
    activePlan: null,
    // WS9-2 2c Commit 6 — `planDiscoveryCards` dropped from the fixture with the
    // field itself. firstPlanCreatedAt is required by HomePayload, so it is
    // spelled out here rather than relying on the caller's override.
    firstPlanCreatedAt: null,
    ...over,
  };
}

// ── deriveHeroModel ─────────────────────────────────────────────────────────

test("deriveHeroModel: undefined payload (loading/error) → empty", () => {
  const model = deriveHeroModel(undefined);
  assert.equal(model.kind, "empty");
});

test("deriveHeroModel: both null → empty", () => {
  const model = deriveHeroModel(mkPayload({}));
  assert.equal(model.kind, "empty");
});

test("deriveHeroModel: today's meal → today branch", () => {
  const model = deriveHeroModel(
    mkPayload({
      todaysMeal: {
        mealPlanItemId: "item-1",
        dayOffset: 2,
        planId: "plan-1",
        planName: "Spice It Up",
        meal: MEAL,
      },
    }),
  );
  assert.equal(model.kind, "today");
  if (model.kind === "today") {
    assert.equal(model.planId, "plan-1");
    // #1 — mealPlanItemId is threaded so the today card can open Meal Detail
    // with full plan-item context (no longer dropped).
    assert.equal(model.planItemId, "item-1");
    assert.equal(model.meal.id, "meal-1");
    assert.equal(model.meal.minutes, 30);
  }
});

test("deriveHeroModel: no meal but active plan → plan branch with duration", () => {
  const model = deriveHeroModel(mkPayload({ activePlan: PLAN_SUMMARY }));
  assert.equal(model.kind, "plan");
  if (model.kind === "plan") {
    assert.equal(model.planId, "plan-1");
    assert.equal(model.name, "Spice It Up");
    // 2026-05-18 → 2026-05-24 inclusive = 7 days.
    assert.equal(model.durationDays, 7);
  }
});

test("deriveHeroModel: today's meal wins over an active plan", () => {
  const model = deriveHeroModel(
    mkPayload({
      todaysMeal: {
        mealPlanItemId: "item-1",
        dayOffset: 0,
        planId: "plan-1",
        planName: "Spice It Up",
        meal: MEAL,
      },
      activePlan: PLAN_SUMMARY,
    }),
  );
  assert.equal(model.kind, "today");
});

test("deriveHeroModel: active plan with null dates → null durationDays", () => {
  const model = deriveHeroModel(
    mkPayload({
      activePlan: { ...PLAN_SUMMARY, startDate: null, endDate: null },
    }),
  );
  assert.equal(model.kind, "plan");
  if (model.kind === "plan") assert.equal(model.durationDays, null);
});

// ── planDurationDays ────────────────────────────────────────────────────────

test("planDurationDays: inclusive span (+1)", () => {
  // Mon → Fri is 4 calendar-day gaps but 5 inclusive days.
  assert.equal(
    planDurationDays("2026-05-18T00:00:00.000Z", "2026-05-22T00:00:00.000Z"),
    5,
  );
});

test("planDurationDays: single-day plan → 1", () => {
  assert.equal(
    planDurationDays("2026-05-18T00:00:00.000Z", "2026-05-18T00:00:00.000Z"),
    1,
  );
});

test("planDurationDays: missing bound → null", () => {
  assert.equal(planDurationDays(null, "2026-05-22T00:00:00.000Z"), null);
  assert.equal(planDurationDays("2026-05-18T00:00:00.000Z", null), null);
  assert.equal(planDurationDays(null, null), null);
});

test("planDurationDays: unparseable date → null", () => {
  assert.equal(planDurationDays("not-a-date", "2026-05-22T00:00:00.000Z"), null);
});
