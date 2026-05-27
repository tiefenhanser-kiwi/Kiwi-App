// WS7-4-D c14 — regression test for the Plan Review screen's local-state
// re-seed behavior. Pre-c14 the screen's `useEffect(() => { if (data &&
// !reviewPlan) seed }, [data, reviewPlan])` guarded with `!reviewPlan` so
// local state was only seeded once on initial fetch. After any item mutation
// the server refetch returned new itemIds (Q-P0-3 atomic swap from Change
// Meal, or real server ids replacing add-meal stubs), but local state held
// the stale ids — the next day-pill / compost / change-meal tap sent the
// dead id to the server and surfaced as uncaught `ApiError("item not
// found")` in Hans's 2026-05-27 device test.
//
// The fix drops the `!reviewPlan` guard. This test exercises the exact
// useState + useEffect pattern at probe scope (the screen file pulls in a
// deep tree of Expo / RN components that's not worth mounting for one
// useEffect's worth of behavior) and asserts:
//   1. Initial fetch seeds local state from the server payload.
//   2. A second fetch with a changed itemId re-seeds, surfacing the new id.
//   3. A second fetch with an added item re-seeds, surfacing the new row.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React, { useEffect, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";
import type { ReviewPlan } from "@/lib/types";

import { planDetailToReviewPlan } from "../reviewPlanAdapter";

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeMeal(over: Partial<MealDetail> = {}): MealDetail {
  return {
    id: "meal-1",
    title: "Test Meal",
    cuisine: "Italian",
    minutes: 30,
    servings: 4,
    calories: 500,
    protein: 30,
    carbs: 40,
    fat: 20,
    tags: [],
    image: null,
    description: null,
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "user",
    isPublic: false,
    userId: "user-1",
    dishes: [],
    steps: [],
    notes: null,
    ...over,
  };
}

function makeItem(over: Partial<PlanDetailItem> = {}): PlanDetailItem {
  return {
    id: "item-1",
    mealId: "meal-1",
    positionIndex: 0,
    assignedDayOfWeek: null,
    assignedDate: null,
    servingsOverride: null,
    isBreakfast: false,
    isLunch: false,
    isDinner: true,
    notes: null,
    meal: makeMeal(),
    ...over,
  };
}

function makeDetail(over: Partial<PlanDetail> = {}): PlanDetail {
  return {
    id: "plan-1",
    name: "Test Plan",
    status: "active",
    startDate: null,
    endDate: null,
    revisionId: 1,
    isActiveThisWeek: false,
    userId: "user-1",
    sourceType: "user",
    prepStatus: "not_prepped",
    optimizationNotes: [],
    breakfastOverrides: "",
    lunchOverrides: "",
    items: [],
    macroDailyAverage: {
      caloriesPerDay: 2000,
      proteinGPerDay: 120,
      carbsGPerDay: 200,
      fatGPerDay: 70,
    },
    ...over,
  };
}

// Mirrors the post-c14 pattern in app/plan/[id].tsx — drops the pre-c14
// `!reviewPlan` guard so every planData identity change re-seeds local state
// from the freshly-refetched server payload. The probe writes the current
// reviewPlan into a sink ref each render so the test reads it without an
// observer-effect (which would itself trigger an extra render cycle).
function Probe({
  planData,
  sink,
}: {
  planData: PlanDetail | undefined;
  sink: { current: ReviewPlan | null };
}): null {
  const [reviewPlan, setReviewPlan] = useState<ReviewPlan | null>(null);
  useEffect(() => {
    if (planData) {
      setReviewPlan(planDetailToReviewPlan(planData));
    }
  }, [planData]);
  sink.current = reviewPlan;
  return null;
}

let activeRenderer: TestRenderer.ReactTestRenderer | null = null;

beforeEach(() => {
  activeRenderer = null;
});

afterEach(() => {
  if (activeRenderer) {
    try {
      activeRenderer.unmount();
    } catch {
      // already unmounted
    }
    activeRenderer = null;
  }
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function mountWith(planData: PlanDetail): Promise<{
  sink: { current: ReviewPlan | null };
}> {
  const sink: { current: ReviewPlan | null } = { current: null };
  await act(async () => {
    activeRenderer = TestRenderer.create(
      React.createElement(Probe, { planData, sink }),
    );
  });
  await settle();
  return { sink };
}

async function rerenderWith(planData: PlanDetail, sink: { current: ReviewPlan | null }): Promise<void> {
  await act(async () => {
    activeRenderer!.update(React.createElement(Probe, { planData, sink }));
  });
  await settle();
}

function allRowIds(rp: ReviewPlan): string[] {
  return [...rp.scheduledMeals, ...rp.unscheduledMeals].map((r) => r.planItemId);
}

test("initial fetch seeds local reviewPlan from the server payload", async () => {
  const initial = makeDetail({ items: [makeItem({ id: "item-A" })] });
  const { sink } = await mountWith(initial);

  assert.ok(sink.current, "expected reviewPlan to be seeded after first fetch");
  assert.deepEqual(allRowIds(sink.current), ["item-A"]);
});

test("atomic-swap refetch re-seeds local state with the new itemId (c14 regression: Change Meal → next interaction)", async () => {
  // Pre-swap: server returns item id "A".
  const beforeSwap = makeDetail({ items: [makeItem({ id: "item-A" })] });
  // Post-swap (Q-P0-3 atomic mealId swap on server): same plan, but the
  // server deleted item A and created item B with a fresh id.
  const afterSwap = makeDetail({
    items: [makeItem({ id: "item-B", mealId: "meal-new" })],
  });

  const { sink } = await mountWith(beforeSwap);
  // Pre-c14 the `!reviewPlan` guard locked local state here. Post-c14 the
  // second update propagates: re-render with the post-swap server payload
  // re-seeds reviewPlan with the new itemId.
  await rerenderWith(afterSwap, sink);

  assert.ok(sink.current);
  // The bug: pre-c14 this would still be ["item-A"]. Post-c14 it is the
  // post-swap server id, so subsequent day-pill / compost taps send the
  // live id and the server resolves them.
  assert.deepEqual(allRowIds(sink.current), ["item-B"]);
});

test("add-meal refetch re-seeds with the real server itemId (c14 regression: stub-id from addExistingMealToPlan reconciles)", async () => {
  // Pre-add: plan with one existing item.
  const beforeAdd = makeDetail({ items: [makeItem({ id: "existing-1" })] });
  // Post-add: server returned the new item with a real server-assigned id.
  // Mobile's optimistic addExistingMealToPlan() seeded a `pi-${Date.now()}`
  // stub locally; the refetch must replace the stub with the real id so
  // the user's next day-pill tap on the new row sends the live id.
  const afterAdd = makeDetail({
    items: [
      makeItem({ id: "existing-1" }),
      makeItem({
        id: "server-real-id-2",
        positionIndex: 1,
        mealId: "meal-2",
        meal: makeMeal({ id: "meal-2", title: "Newly Added" }),
      }),
    ],
  });

  const { sink } = await mountWith(beforeAdd);
  await rerenderWith(afterAdd, sink);

  assert.ok(sink.current);
  // Both items present; the second is the server-real id, not a `pi-…` stub.
  assert.deepEqual(
    new Set(allRowIds(sink.current)),
    new Set(["existing-1", "server-real-id-2"]),
  );
});

test("compost refetch removes the deleted row from local state (c14 regression: stale-row-after-compost cannot be re-targeted)", async () => {
  const beforeCompost = makeDetail({
    items: [
      makeItem({ id: "item-keep" }),
      makeItem({ id: "item-toss", positionIndex: 1, mealId: "meal-2" }),
    ],
  });
  // After DELETE /plans/:id/items/item-toss server returns the plan with
  // only item-keep.
  const afterCompost = makeDetail({
    items: [makeItem({ id: "item-keep" })],
  });

  const { sink } = await mountWith(beforeCompost);
  await rerenderWith(afterCompost, sink);

  assert.ok(sink.current);
  // Pre-c14 the composted row stayed in local state; a second tap on its
  // (still-visible) compost button would 404. Post-c14 it disappears.
  assert.deepEqual(allRowIds(sink.current), ["item-keep"]);
});
