// WS7-8b Block 2 — Prep & Cook Hub model tests.
//
// Pins the load-bearing prep-status sourcing rule (PRD §13.3): every prep
// signal is READ off the server payload, never recomputed. In particular the
// per-meal "Mostly prepped" pill is gated on the plan-level `partial` rollup,
// not on any checkbox count.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPrepCookHubModel,
  buildPromotablePlans,
  formatPlanDateRange,
  headerPrepIndicator,
  mealPrepPill,
  resolveHubPlanId,
  resolveTodaysMeal,
} from "../hubModel";
import type { PlanDetail, PlanDetailItem, PlanListItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";
import { formatDate } from "@/lib/date";

// ── Fixtures ────────────────────────────────────────────────────────────────

function meal(overrides: Partial<MealDetail> = {}): MealDetail {
  return {
    id: "m1",
    title: "Lemon Chicken",
    cuisine: "",
    minutes: 30,
    servings: 4,
    calories: 500,
    protein: 40,
    carbs: 30,
    fat: 18,
    tags: [],
    image: null,
    description: null,
    difficulty: "medium",
    mealType: "dinner",
    sourceType: "user",
    isPublic: false,
    userId: "u1",
    dishes: [],
    steps: [],
    notes: null,
    ...overrides,
  };
}

function item(overrides: Partial<PlanDetailItem> = {}): PlanDetailItem {
  return {
    id: "pi1",
    mealId: "m1",
    positionIndex: 0,
    assignedDayOfWeek: null,
    assignedDate: null,
    servingsOverride: null,
    isBreakfast: false,
    isLunch: false,
    isDinner: true,
    notes: null,
    isPrepped: false,
    meal: meal(),
    ...overrides,
  };
}

function plan(overrides: Partial<PlanDetail> = {}): PlanDetail {
  return {
    id: "plan-1",
    name: "Cozy Week",
    status: "this_week",
    startDate: null,
    endDate: null,
    revisionId: 1,
    isActiveThisWeek: true,
    userId: "u1",
    sourceType: "user",
    image: null,
    prepStatus: "not_prepped",
    prepStatusIsManual: false,
    optimizationNotes: [],
    breakfastOverrides: "",
    lunchOverrides: "",
    items: [],
    macroDailyAverage: {
      caloriesPerDay: null,
      proteinGPerDay: null,
      carbsGPerDay: null,
      fatGPerDay: null,
    },
    ...overrides,
  };
}

function planListItem(overrides: Partial<PlanListItem> = {}): PlanListItem {
  return {
    id: "pl1",
    name: "Backyard Classics",
    description: null,
    image: null,
    tags: [],
    source: "instance",
    status: "draft",
    startDate: null,
    endDate: null,
    isActiveThisWeek: false,
    ...overrides,
  };
}

// ── mealPrepPill — the cardinal mapping ─────────────────────────────────────

test("mealPrepPill: a prepped meal is sage-tint 'Prepped ✓' regardless of plan status", () => {
  for (const status of ["not_prepped", "partial", "prepped"] as const) {
    const pill = mealPrepPill(true, status);
    assert.equal(pill.label, "Prepped ✓");
    assert.equal(pill.tone, "sage");
  }
});

test("mealPrepPill: a not-prepped meal in a PARTIAL plan is gold 'Mostly prepped' (read from plan, not computed)", () => {
  const pill = mealPrepPill(false, "partial");
  assert.equal(pill.label, "Mostly prepped");
  assert.equal(pill.tone, "gold");
});

test("mealPrepPill: a not-prepped meal in a non-partial plan is neutral 'Not prepped'", () => {
  for (const status of ["not_prepped", "prepped"] as const) {
    const pill = mealPrepPill(false, status);
    assert.equal(pill.label, "Not prepped");
    assert.equal(pill.tone, "neutral");
  }
});

// ── headerPrepIndicator ─────────────────────────────────────────────────────

test("headerPrepIndicator: prepped → status badge, partial → mostly, not_prepped → suggestion", () => {
  const prepped = headerPrepIndicator("prepped");
  assert.equal(prepped.label, "Prepped this week ✓");
  assert.equal(prepped.tone, "sage");
  assert.equal(prepped.isSuggestion, false);

  const partial = headerPrepIndicator("partial");
  assert.equal(partial.label, "Mostly prepped");
  assert.equal(partial.tone, "gold");
  assert.equal(partial.isSuggestion, false);

  const none = headerPrepIndicator("not_prepped");
  assert.equal(none.isSuggestion, true);
  assert.match(none.label, /Start Prep/);
});

// ── resolveTodaysMeal ───────────────────────────────────────────────────────

test("resolveTodaysMeal: matches the day-of-week label and prefers a dinner", () => {
  const lunch = item({
    id: "pi-lunch",
    assignedDayOfWeek: "Tuesday",
    isDinner: false,
    isLunch: true,
    meal: meal({ title: "Soup" }),
  });
  const dinner = item({
    id: "pi-dinner",
    assignedDayOfWeek: "Tuesday",
    isDinner: true,
    meal: meal({ title: "Roast" }),
  });
  const other = item({ id: "pi-wed", assignedDayOfWeek: "Wednesday" });

  const today = resolveTodaysMeal(
    [lunch, dinner, other] as never,
    "Tuesday",
  );
  assert.ok(today);
  assert.equal(today!.planItemId, "pi-dinner");
  assert.equal(today!.title, "Roast");
});

test("resolveTodaysMeal: no meal assigned to today → null", () => {
  const it = item({ assignedDayOfWeek: "Monday" });
  assert.equal(resolveTodaysMeal([it] as never, "Friday"), null);
});

// ── buildPrepCookHubModel ───────────────────────────────────────────────────

test("buildPrepCookHubModel: reads effective prepStatus into the indicator + per-meal pills", () => {
  const detail = plan({
    name: "Mediterranean Week",
    prepStatus: "partial",
    items: [
      item({ id: "a", isPrepped: true, meal: meal({ title: "Done Meal" }) }),
      item({ id: "b", isPrepped: false, meal: meal({ title: "Todo Meal" }) }),
    ],
  });

  const model = buildPrepCookHubModel(detail, "Sunday");
  assert.equal(model.kind, "hub");
  assert.equal(model.planName, "Mediterranean Week");
  assert.equal(model.prepStatus, "partial");
  assert.equal(model.indicator.label, "Mostly prepped");
  // "Prep the Week" stays enabled while only partially prepped.
  assert.equal(model.prepWeekDisabled, false);

  const [done, todo] = model.meals;
  assert.equal(done.pill.label, "Prepped ✓");
  assert.equal(done.pill.tone, "sage");
  // The not-prepped meal inherits "Mostly prepped" from the plan-level partial.
  assert.equal(todo.pill.label, "Mostly prepped");
  assert.equal(todo.pill.tone, "gold");
});

test("buildPrepCookHubModel: a fully prepped week disables the Prep-the-Week lane", () => {
  const detail = plan({
    prepStatus: "prepped",
    items: [item({ id: "a", isPrepped: true })],
  });
  const model = buildPrepCookHubModel(detail, "Sunday");
  assert.equal(model.prepWeekDisabled, true);
  assert.equal(model.indicator.label, "Prepped this week ✓");
});

test("buildPrepCookHubModel: meta line + serves uses the servings override, drops archived items", () => {
  const detail = plan({
    items: [
      item({
        id: "live",
        assignedDayOfWeek: "Thursday",
        servingsOverride: 2,
        meal: meal({ title: "Pasta", minutes: 25, servings: 4 }),
      }),
      item({ id: "archived", meal: null }),
    ],
  });
  const model = buildPrepCookHubModel(detail, "Sunday");
  assert.equal(model.meals.length, 1, "archived (meal === null) item is dropped");
  assert.equal(model.meals[0].metaLine, "Thursday · 25 min · serves 2");
  assert.equal(model.subtitle, "— 1 meal this week");
});

test("buildPrepCookHubModel: passes injected tags through (sourced from the discovery list), defaults to none", () => {
  const detail = plan({ items: [item({ id: "a" })] });
  assert.deepEqual(buildPrepCookHubModel(detail, "Sunday").tags, []);
  assert.deepEqual(
    buildPrepCookHubModel(detail, "Sunday", ["Grill", "Summer"]).tags,
    ["Grill", "Summer"],
  );
});

test("buildPrepCookHubModel: surfaces today's meal when one is assigned to today", () => {
  const detail = plan({
    items: [
      item({ id: "mon", assignedDayOfWeek: "Monday" }),
      item({
        id: "fri",
        assignedDayOfWeek: "Friday",
        meal: meal({ title: "Friday Feast" }),
      }),
    ],
  });
  const model = buildPrepCookHubModel(detail, "Friday");
  assert.ok(model.todaysMeal);
  assert.equal(model.todaysMeal!.title, "Friday Feast");
  assert.equal(model.meals.find((m) => m.planItemId === "fri")!.isToday, true);
});

// ── Empty-state promote helpers ─────────────────────────────────────────────

test("formatPlanDateRange: both dates → range; one → single; neither → null", () => {
  assert.equal(
    formatPlanDateRange("2026-06-15", "2026-06-21"),
    `${formatDate("2026-06-15")} – ${formatDate("2026-06-21")}`,
  );
  assert.equal(
    formatPlanDateRange("2026-06-15", null),
    formatDate("2026-06-15"),
  );
  assert.equal(formatPlanDateRange(null, "2026-06-21"), formatDate("2026-06-21"));
  assert.equal(formatPlanDateRange(null, null), null);
});

test("buildPromotablePlans: instance-only, mapped to name + date range + thumb, order preserved", () => {
  const plans: PlanListItem[] = [
    planListItem({
      id: "a",
      name: "Backyard Classics",
      source: "instance",
      startDate: "2026-06-15",
      endDate: "2026-06-21",
      image: "http://img/a.jpg",
    }),
    // A template row — must be dropped (not promotable until instantiated).
    planListItem({ id: "tmpl", name: "Featured Feast", source: "template" }),
    planListItem({
      id: "b",
      name: "Weeknight Express",
      source: "instance",
      startDate: null,
      endDate: null,
    }),
  ];
  const out = buildPromotablePlans(plans);
  assert.equal(out.length, 2, "template row should be filtered out");
  assert.deepEqual(
    out.map((p) => p.id),
    ["a", "b"],
    "order preserved, instances only",
  );
  assert.equal(out[0].name, "Backyard Classics");
  assert.equal(out[0].thumbnailUrl, "http://img/a.jpg");
  assert.ok(out[0].dateRangeLabel && out[0].dateRangeLabel.includes("–"));
  assert.equal(out[1].dateRangeLabel, null, "undated plan → null range");
  assert.equal(out[1].thumbnailUrl, undefined);
});

test("buildPromotablePlans: no instance plans → empty (empty-of-instances branch)", () => {
  const plans = [
    planListItem({ id: "t1", source: "template" }),
    planListItem({ id: "t2", source: "template" }),
  ];
  assert.deepEqual(buildPromotablePlans(plans), []);
});

test("resolveHubPlanId: promote-then-resolve — null (empty) before promote, the promoted id after", () => {
  // Before promote: no explicit id, no activeThisWeek, list settled → empty.
  assert.deepEqual(resolveHubPlanId("", undefined, false), {
    planId: null,
    resolving: false,
  });
  // The ["plans"] refetch flips activeThisWeek → the Hub resolves to that plan.
  assert.deepEqual(resolveHubPlanId("", "promoted-id", false), {
    planId: "promoted-id",
  });
});

test("resolveHubPlanId: explicit id wins; list still loading → resolving (spinner, not empty)", () => {
  assert.deepEqual(resolveHubPlanId("explicit-1", "active-2", false), {
    planId: "explicit-1",
  });
  assert.deepEqual(resolveHubPlanId("", undefined, true), {
    planId: null,
    resolving: true,
  });
});
