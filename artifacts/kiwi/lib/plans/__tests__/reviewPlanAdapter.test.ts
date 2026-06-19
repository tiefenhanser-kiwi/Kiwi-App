// WS7-3 C4 c1 — adapter tests for planDetailToReviewPlan + mealDetailToRow.
// Pure functions, no React.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";

import {
  planDetailToReviewPlan,
  mealDetailToRow,
} from "../reviewPlanAdapter";

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
    isPrepped: true,
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
    prepStatusIsManual: false,
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

test("planDetailToReviewPlan: empty plan → both clusters empty, safe defaults", () => {
  const result = planDetailToReviewPlan(makeDetail());
  assert.equal(result.id, "plan-1");
  assert.equal(result.name, "Test Plan");
  assert.deepEqual(result.scheduledMeals, []);
  assert.deepEqual(result.unscheduledMeals, []);
  // WS7-4-A c6 — server-provided values (factory defaults match prior C4 hardcoded values).
  assert.equal(result.prepStatus, "not_prepped");
  assert.deepEqual(result.optimizationNotes, []);
  assert.equal(result.breakfastOverrides, "");
  assert.equal(result.lunchOverrides, "");
});

test("planDetailToReviewPlan: real prepStatus + optimizationNotes from server pass through", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      prepStatus: "prepped",
      optimizationNotes: [{ type: "prep", text: "Batch-cook rice Sunday" }],
      breakfastOverrides: "yogurt + berries",
      lunchOverrides: "Sat: leftovers",
    }),
  );
  assert.equal(result.prepStatus, "prepped");
  assert.equal(result.optimizationNotes.length, 1);
  assert.equal(result.optimizationNotes[0].text, "Batch-cook rice Sunday");
  assert.equal(result.breakfastOverrides, "yogurt + berries");
  assert.equal(result.lunchOverrides, "Sat: leftovers");
});

test("planDetailToReviewPlan: scheduled Monday meal lands in scheduled cluster with day strip selected", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          id: "item-mon",
          assignedDayOfWeek: "Monday",
          meal: makeMeal({ title: "Lasagna" }),
        }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals.length, 1);
  assert.equal(result.unscheduledMeals.length, 0);
  const row = result.scheduledMeals[0];
  assert.equal(row.title, "Lasagna");
  const monday = row.dayStrip.find((d) => d.day === "Monday");
  assert.equal(monday?.isAssigned, true);
  const tuesday = row.dayStrip.find((d) => d.day === "Tuesday");
  assert.equal(tuesday?.isAssigned, false);
});

test("planDetailToReviewPlan: null assignedDayOfWeek lands in unscheduled cluster, all-empty day strip", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [makeItem({ assignedDayOfWeek: null })],
    }),
  );
  assert.equal(result.scheduledMeals.length, 0);
  assert.equal(result.unscheduledMeals.length, 1);
  const row = result.unscheduledMeals[0];
  assert.ok(row.dayStrip.every((d) => !d.isAssigned));
});

test("planDetailToReviewPlan: mixed scheduled + unscheduled splits correctly", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({ id: "a", assignedDayOfWeek: "Tuesday" }),
        makeItem({ id: "b", assignedDayOfWeek: null }),
        makeItem({ id: "c", assignedDayOfWeek: "Friday" }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals.length, 2);
  assert.equal(result.unscheduledMeals.length, 1);
});

test("planDetailToReviewPlan: archived meal (item.meal === null) is filtered out of both lists", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({ id: "a", meal: null }),
        makeItem({ id: "b", assignedDayOfWeek: "Wednesday" }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals.length, 1);
  assert.equal(result.unscheduledMeals.length, 0);
});

test("planDetailToReviewPlan: null dates map to undefined", () => {
  const result = planDetailToReviewPlan(
    makeDetail({ startDate: null, endDate: null }),
  );
  assert.equal(result.weekStartDate, undefined);
  assert.equal(result.weekEndDate, undefined);
});

test("planDetailToReviewPlan: present dates carry through", () => {
  const result = planDetailToReviewPlan(
    makeDetail({ startDate: "2026-05-25", endDate: "2026-05-31" }),
  );
  assert.equal(result.weekStartDate, "2026-05-25");
  assert.equal(result.weekEndDate, "2026-05-31");
});

test("planDetailToReviewPlan: cuisine widening — non-empty cuisine carries through", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          assignedDayOfWeek: "Monday",
          meal: makeMeal({ cuisine: "Italian" }),
        }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals[0].cuisine, "Italian");
});

test("planDetailToReviewPlan: cuisine widening — empty cuisine becomes undefined", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          assignedDayOfWeek: "Monday",
          meal: makeMeal({ cuisine: "" }),
        }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals[0].cuisine, undefined);
});

test("planDetailToReviewPlan: macros + image carry through to row", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          assignedDayOfWeek: "Monday",
          meal: makeMeal({
            calories: 540,
            protein: 38,
            carbs: 32,
            fat: 24,
            image: "https://example.com/meal.jpg",
          }),
        }),
      ],
    }),
  );
  const row = result.scheduledMeals[0];
  assert.equal(row.caloriesPerServing, 540);
  assert.equal(row.proteinGPerServing, 38);
  assert.equal(row.carbsGPerServing, 32);
  assert.equal(row.fatGPerServing, 24);
  assert.equal(row.thumbnailUrl, "https://example.com/meal.jpg");
});

test("planDetailToReviewPlan: meta line uses difficulty + minutes + servings from MealDetail", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          assignedDayOfWeek: "Monday",
          meal: makeMeal({ difficulty: "medium", minutes: 45, servings: 6 }),
        }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals[0].metaLine, "Medium · 45 min · serves 6");
});

test("planDetailToReviewPlan: meta line uses servingsOverride when the plan item has one (D-WS7-141 Fix 2)", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          assignedDayOfWeek: "Monday",
          servingsOverride: 8,
          meal: makeMeal({ difficulty: "medium", minutes: 45, servings: 4 }),
        }),
      ],
    }),
  );
  // The bumped per-instance servings (8) wins over the canonical default (4).
  assert.equal(result.scheduledMeals[0].metaLine, "Medium · 45 min · serves 8");
  // The override still rides onto the row for the meal-detail stepper seed.
  assert.equal(result.scheduledMeals[0].servingsOverride, 8);
});

test("planDetailToReviewPlan: meta line falls back to meal.servings when servingsOverride is null (D-WS7-141 Fix 2)", () => {
  const result = planDetailToReviewPlan(
    makeDetail({
      items: [
        makeItem({
          assignedDayOfWeek: "Monday",
          servingsOverride: null,
          meal: makeMeal({ difficulty: "easy", minutes: 30, servings: 5 }),
        }),
      ],
    }),
  );
  assert.equal(result.scheduledMeals[0].metaLine, "Easy · 30 min · serves 5");
});

test("mealDetailToRow: deep-link injection row carries cuisine + macros, empty day strip", () => {
  const row = mealDetailToRow(
    makeMeal({ id: "m-9", title: "Tacos", cuisine: "Mexican" }),
  );
  assert.equal(row.mealId, "m-9");
  assert.equal(row.title, "Tacos");
  assert.equal(row.cuisine, "Mexican");
  assert.ok(row.dayStrip.every((d) => !d.isAssigned));
  assert.ok(row.planItemId.startsWith("pi-"));
});
