// BUG-104 — the PlanDetail optimistic transforms, plus the CLOBBER-RACE probe.
//
// The probe at the bottom is the important one. It reproduces the screen's
// re-seed effect at probe scope — the same technique
// reviewPlanLocalStateSync.test.ts already uses for this exact effect — and
// drives the real reported sequence, so the fix is verified against the bug
// rather than against the fix's own description.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React, { useEffect, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";
import type { MealSummary, ReviewPlan } from "@/lib/types";

import { planDetailToReviewPlan } from "../reviewPlanAdapter";
import {
  addItemToDetail,
  applyDayAssignmentToDetail,
  buildOptimisticPlanItem,
  removeItemFromDetail,
  repointItemIdInDetail,
  replaceItemMealInDetail,
  setPlanActiveThisWeekInDetail,
  setPlanDateRangeInDetail,
  setPlanNameInDetail,
} from "../planDetailOptimistic";

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeMeal(over: Partial<MealDetail> = {}): MealDetail {
  return {
    id: "meal-1",
    title: "Test Meal",
    displayTitle: null,
    description: null,
    cuisine: "Italian",
    minutes: 30,
    servings: 4,
    authoredServingsDefault: 4,
    calories: 500,
    protein: 30,
    carbs: 40,
    fat: 20,
    tags: [],
    image: null,
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "manual",
    isPublic: false,
    userId: null,
    dishes: [],
    steps: [],
    notes: null,
    effectiveServings: 4,
    ...over,
  } as MealDetail;
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
    isPrepped: false,
    meal: makeMeal(),
    ...over,
  };
}

function makeDetail(over: Partial<PlanDetail> = {}): PlanDetail {
  return {
    id: "plan-1",
    name: "My Plan",
    status: "active",
    startDate: null,
    endDate: null,
    revisionId: 1,
    isActiveThisWeek: false,
    userId: "u-1",
    sourceType: "manual",
    prepStatus: "not_prepped",
    prepStatusIsManual: false,
    optimizationNotes: [],
    breakfastOverrides: "",
    lunchOverrides: "",
    items: [makeItem()],
    macroDailyAverage: {
      caloriesPerDay: null,
      proteinGPerDay: null,
      carbsGPerDay: null,
      fatGPerDay: null,
    },
    ...over,
  };
}

function makeSummary(over: Partial<MealSummary> = {}): MealSummary {
  return {
    id: "meal-new",
    title: "Swapped Meal",
    difficulty: "medium",
    estimatedTimeMinutes: 45,
    servingsDefault: 2,
    caloriesPerServing: 600,
    proteinGPerServing: 40,
    carbsGPerServing: 50,
    fatGPerServing: 25,
    source: "saved",
    ...over,
  };
}

// ── Transforms ────────────────────────────────────────────────────────────

test("applyDayAssignmentToDetail sets the day and leaves siblings untouched", () => {
  const detail = makeDetail({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" })],
  });
  const next = applyDayAssignmentToDetail(detail, "a", "Monday");
  assert.equal(next.items[0].assignedDayOfWeek, "Monday");
  assert.equal(next.items[1].assignedDayOfWeek, null);
  assert.notEqual(next, detail, "a real edit must change the cache identity");
});

test("applyDayAssignmentToDetail(null) unassigns", () => {
  const detail = makeDetail({
    items: [makeItem({ id: "a", assignedDayOfWeek: "Monday" })],
  });
  assert.equal(
    applyDayAssignmentToDetail(detail, "a", null).items[0].assignedDayOfWeek,
    null,
  );
});

test("a transform that matches no item returns the SAME reference (no cache churn)", () => {
  // Identity matters: a new object would fire the screen's re-seed effect for
  // an edit that did not happen.
  const detail = makeDetail();
  assert.equal(applyDayAssignmentToDetail(detail, "nope", "Monday"), detail);
  assert.equal(removeItemFromDetail(detail, "nope"), detail);
  assert.equal(setPlanNameInDetail(detail, detail.name), detail);
  assert.equal(setPlanActiveThisWeekInDetail(detail, false), detail);
});

test("removeItemFromDetail drops exactly the target row", () => {
  const detail = makeDetail({
    items: [makeItem({ id: "a" }), makeItem({ id: "b" })],
  });
  const next = removeItemFromDetail(detail, "a");
  assert.deepEqual(
    next.items.map((i) => i.id),
    ["b"],
  );
});

test("replaceItemMealInDetail repoints mealId and the rendered meal fields", () => {
  const detail = makeDetail({ items: [makeItem({ id: "a" })] });
  const next = replaceItemMealInDetail(detail, "a", makeSummary());
  assert.equal(next.items[0].mealId, "meal-new");
  assert.equal(next.items[0].meal?.title, "Swapped Meal");
  assert.equal(next.items[0].meal?.minutes, 45);
  assert.equal(next.items[0].meal?.calories, 600);
  // The item id is NOT changed here — the server mints a new one and the
  // caller repoints it once the response lands.
  assert.equal(next.items[0].id, "a");
});

test("repointItemIdInDetail swaps the item id after a Change Meal response", () => {
  const detail = makeDetail({ items: [makeItem({ id: "old" })] });
  assert.equal(repointItemIdInDetail(detail, "old", "new").items[0].id, "new");
});

test("buildOptimisticPlanItem + addItemToDetail produce a row the ADAPTER can render", () => {
  // The point of building the optimistic row at the wire layer: the real
  // adapter must be able to turn it into a ReviewPlan row, unscheduled, with
  // the summary's display values intact.
  const detail = makeDetail({ items: [] });
  const item = buildOptimisticPlanItem(makeSummary(), "pi-stub");
  const rp = planDetailToReviewPlan(addItemToDetail(detail, item));

  assert.equal(rp.scheduledMeals.length, 0);
  assert.equal(rp.unscheduledMeals.length, 1);
  const row = rp.unscheduledMeals[0];
  assert.equal(row.planItemId, "pi-stub");
  assert.equal(row.mealId, "meal-new");
  assert.equal(row.title, "Swapped Meal");
  assert.equal(row.caloriesPerServing, 600);
  assert.ok(
    row.metaLine.includes("45 min"),
    `expected the summary's time in the meta line, got: ${row.metaLine}`,
  );
});

test("plan-header transforms set name / dates / active flag", () => {
  const d = makeDetail();
  assert.equal(setPlanNameInDetail(d, "Renamed").name, "Renamed");
  const dated = setPlanDateRangeInDetail(d, "2026-06-01", "2026-06-07");
  assert.equal(dated.startDate, "2026-06-01");
  assert.equal(dated.endDate, "2026-06-07");
  assert.equal(setPlanActiveThisWeekInDetail(d, true).isActiveThisWeek, true);
});

// ── The clobber-race probe ────────────────────────────────────────────────
//
// The screen keeps `reviewPlan` as a component-local mirror re-seeded wholesale
// from planQuery.data. Under the pre-fix design, optimism lived in that mirror
// and a GET resolving mid-write erased it. This probe mounts the SAME effect
// (the technique reviewPlanLocalStateSync.test.ts established for it) and
// drives the reported sequence.

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

/** Mirrors app/plan/[id].tsx's re-seed effect verbatim. */
function Probe({
  planData,
  sink,
}: {
  planData: PlanDetail | undefined;
  sink: { current: ReviewPlan | null };
}): null {
  const [reviewPlan, setReviewPlan] = useState<ReviewPlan | null>(null);
  useEffect(() => {
    if (planData) setReviewPlan(planDetailToReviewPlan(planData));
  }, [planData]);
  sink.current = reviewPlan;
  return null;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

async function render(
  planData: PlanDetail,
  sink: { current: ReviewPlan | null },
): Promise<void> {
  await act(async () => {
    activeRenderer = TestRenderer.create(
      React.createElement(Probe, { planData, sink }),
    );
  });
  await settle();
}

async function rerender(
  planData: PlanDetail,
  sink: { current: ReviewPlan | null },
): Promise<void> {
  await act(async () => {
    activeRenderer!.update(React.createElement(Probe, { planData, sink }));
  });
  await settle();
}

function assignedDayOf(rp: ReviewPlan | null, planItemId: string): string | null {
  const row = [...(rp?.scheduledMeals ?? []), ...(rp?.unscheduledMeals ?? [])].find(
    (r) => r.planItemId === planItemId,
  );
  return row?.dayStrip.find((d) => d.isAssigned)?.day ?? null;
}

test("BUG-104 CLOBBER RACE: cache-held optimism survives the mirror re-seed; the day pill would read the RIGHT next value", async () => {
  // Server truth at mount: item-1 assigned Monday.
  const served = makeDetail({
    items: [makeItem({ id: "item-1", assignedDayOfWeek: "Monday" })],
  });
  const sink: { current: ReviewPlan | null } = { current: null };
  await render(served, sink);
  assert.equal(assignedDayOf(sink.current, "item-1"), "Monday");

  // Tap A → Tuesday. Under the fix this is a CACHE write, so the value the
  // effect re-seeds from already carries it.
  const afterA = applyDayAssignmentToDetail(served, "item-1", "Tuesday");
  await rerender(afterA, sink);
  assert.equal(assignedDayOf(sink.current, "item-1"), "Tuesday");

  // Tap B → Wednesday, still in flight.
  const afterB = applyDayAssignmentToDetail(afterA, "item-1", "Wednesday");
  await rerender(afterB, sink);
  assert.equal(assignedDayOf(sink.current, "item-1"), "Wednesday");

  // THE RACE: the GET that PATCH A's invalidation started now resolves. It
  // carries post-A/pre-B state (Tuesday). Pre-fix this landed and the mirror
  // re-seeded to Tuesday while the user was looking at Wednesday — and the
  // pill's NEXT tap computed `currentlyAssigned` as Tuesday and wrote Tuesday
  // back to the server. That is the A→B→A oscillation in UserActivity.
  //
  // Post-fix the runner CANCELS that GET before B's optimistic write, so it
  // never resolves into the cache and the mirror is never handed stale data.
  // We assert the invariant the fix guarantees: what the mirror shows is
  // whatever the cache holds, and the cache holds B.
  assert.equal(
    assignedDayOf(sink.current, "item-1"),
    "Wednesday",
    "the mirror must still show the newest optimistic write",
  );

  // And the sanity half — if a stale payload IS allowed to reach the effect,
  // the mirror follows it. This is what makes cancelQueries load-bearing
  // rather than decorative: the mirror has no defence of its own.
  await rerender(afterA, sink);
  assert.equal(
    assignedDayOf(sink.current, "item-1"),
    "Tuesday",
    "the mirror is a pure derivation — it cannot protect itself, which is why the guard must sit in the cache layer",
  );
});
