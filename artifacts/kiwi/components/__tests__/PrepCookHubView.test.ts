// WS7-8b Block 2 — Prep & Cook Hub render contract tests.
//
// Pins the Hub's load-bearing surfaces (PRD §13.3 / design spec §2.1):
//   - header (plan name + italic-dash subtitle) + effective prep indicator
//   - two action lanes; "Prep the Week" disables/badges when fully prepped
//   - "This week's meals" rows with the per-meal prep pill, including that
//     "Mostly prepped" is READ from the plan-level partial rollup
//   - today's-meal callout, meal-row → onSelectMeal
//   - the real "no plan this week" empty state (null branch)

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { PrepCookHubView } from "../PrepCookHubView";
import {
  buildPrepCookHubModel,
  type HubModel,
} from "@/lib/cooking/hubModel";
import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";

// ── Tree helpers (shared pattern with PlanRow / WizardPlanMealCard tests) ────

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function gatherText(
  node: RenderedNode | string | null | undefined,
  out: string[] = [],
): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) gatherText(c, out);
  }
  return out;
}

function flat(node: RenderedNode | null): string {
  return gatherText(node).join(" ").replace(/\s+/g, " ").trim();
}

function findPressableByText(
  node: RenderedNode | string | null,
  text: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  const props = (node.props ?? {}) as { onPress?: unknown };
  if (props.onPress && gatherText(node).join(" ").includes(text)) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findPressableByText(c, text);
      if (hit) return hit;
    }
  }
  return null;
}

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

const NOOP = () => {};

interface Handlers {
  onCookAMeal?: () => void;
  onPrepWeek?: () => void;
  onSelectMeal?: (mealId: string, planItemId: string) => void;
  onMakePlan?: () => void;
  onCookThisWeek?: (planId: string) => void;
  promotingPlanId?: string | null;
}

function render(model: HubModel, handlers: Handlers = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(PrepCookHubView, {
        model,
        onCookAMeal: handlers.onCookAMeal ?? NOOP,
        onPrepWeek: handlers.onPrepWeek ?? NOOP,
        onSelectMeal: handlers.onSelectMeal ?? NOOP,
        onMakePlan: handlers.onMakePlan ?? NOOP,
        onCookThisWeek: handlers.onCookThisWeek ?? NOOP,
        promotingPlanId: handlers.promotingPlanId ?? null,
      }),
    );
  });
  return renderer;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("Hub renders header, prep indicator, both lanes, and a meal row with its pill", () => {
  const model = buildPrepCookHubModel(
    plan({
      name: "Mediterranean Week",
      prepStatus: "partial",
      items: [
        item({ id: "a", isPrepped: true, meal: meal({ title: "Done Meal" }) }),
        item({ id: "b", isPrepped: false, meal: meal({ title: "Todo Meal" }) }),
      ],
    }),
    "Sunday",
  );
  const renderer = render(model);
  const texts = flat(renderer.toJSON() as RenderedNode | null);

  // Header + subtitle.
  assert.ok(texts.includes("Mediterranean Week"), `missing plan name: ${texts}`);
  assert.ok(texts.includes("2 meals this week"), `missing subtitle: ${texts}`);
  // Effective prep indicator (partial).
  assert.ok(texts.includes("Mostly prepped"), `missing indicator: ${texts}`);
  // Two lanes.
  assert.ok(texts.includes("Cook a meal"), `missing Cook lane CTA: ${texts}`);
  assert.ok(texts.includes("Prep the Week"), `missing Prep lane CTA: ${texts}`);
  // Meal rows + pills.
  assert.ok(texts.includes("Done Meal"), `missing meal title: ${texts}`);
  assert.ok(texts.includes("Prepped ✓"), `missing prepped pill: ${texts}`);

  renderer.unmount();
});

test("Hub renders plan tags (sourced from the discovery list) between name and subtitle", () => {
  const model = buildPrepCookHubModel(
    plan({ name: "American Backyard Classics", items: [item({ id: "a" })] }),
    "Sunday",
    ["Grill", "Summer", "Crowd-pleaser"],
  );
  const texts = flat(render(model).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Grill"), `missing tag: ${texts}`);
  assert.ok(texts.includes("Summer"), `missing tag: ${texts}`);
  assert.ok(texts.includes("Crowd-pleaser"), `missing tag: ${texts}`);
});

test("Hub pill mapping: prepped meal → 'Prepped ✓'; not-prepped meal in a partial plan → 'Mostly prepped' (read, not computed)", () => {
  const model = buildPrepCookHubModel(
    plan({
      prepStatus: "partial",
      items: [
        item({ id: "a", isPrepped: true, meal: meal({ title: "Alpha" }) }),
        item({ id: "b", isPrepped: false, meal: meal({ title: "Bravo" }) }),
      ],
    }),
    "Sunday",
  );
  const texts = flat(render(model).toJSON() as RenderedNode | null);

  // Both pill states render. "Mostly prepped" appears for Bravo despite no
  // per-meal partial datum — it is inherited from the plan's partial rollup.
  assert.ok(texts.includes("Prepped ✓"));
  assert.ok(texts.includes("Mostly prepped"));
  assert.ok(!texts.includes("Not prepped"), `no neutral pill expected: ${texts}`);
});

test("Hub: a fully prepped week disables the Prep-the-Week CTA and shows the badge", () => {
  let prepped = 0;
  const model = buildPrepCookHubModel(
    plan({
      prepStatus: "prepped",
      items: [item({ id: "a", isPrepped: true })],
    }),
    "Sunday",
  );
  const renderer = render(model, { onPrepWeek: () => (prepped += 1) });
  const texts = flat(renderer.toJSON() as RenderedNode | null);

  assert.ok(texts.includes("Prepped ✓"), "expected prepped badge");
  assert.ok(texts.includes("Week is prepped"), "expected disabled CTA copy");

  // The disabled CTA is a non-pressable view: tapping anything labelled
  // "Week is prepped" must not invoke onPrepWeek.
  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Week is prepped",
  );
  assert.equal(cta, null, "disabled Prep-the-Week should not be pressable");
  assert.equal(prepped, 0);
  renderer.unmount();
});

test("Hub: today's meal callout renders and routes the meal via onSelectMeal", () => {
  const selected: Array<[string, string]> = [];
  const model = buildPrepCookHubModel(
    plan({
      items: [
        item({
          id: "fri",
          mealId: "meal-fri",
          assignedDayOfWeek: "Friday",
          meal: meal({ id: "meal-fri", title: "Friday Feast" }),
        }),
      ],
    }),
    "Friday",
  );
  const renderer = render(model, {
    onSelectMeal: ((m: string, p: string) => {
      selected.push([m, p]);
    }) as never,
  });
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("Cook tonight's dinner: Friday Feast"),
    `missing today callout: ${texts}`,
  );

  const callout = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Cook tonight's dinner",
  );
  assert.ok(callout, "today callout not pressable");
  act(() => {
    (callout!.props!.onPress as () => void)();
  });
  assert.deepEqual(selected[0], ["meal-fri", "fri"]);
  renderer.unmount();
});

test("Hub: tapping a meal row fires onSelectMeal with mealId + planItemId", () => {
  const selected: Array<[string, string]> = [];
  const model = buildPrepCookHubModel(
    plan({
      items: [
        item({
          id: "pi-x",
          mealId: "meal-x",
          assignedDayOfWeek: "Monday",
          meal: meal({ id: "meal-x", title: "Tap Target" }),
        }),
      ],
    }),
    "Sunday", // not Monday → no today callout, so the row is the only target
  );
  const renderer = render(model, {
    onSelectMeal: ((m: string, p: string) => {
      selected.push([m, p]);
    }) as never,
  });
  const row = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Tap Target",
  );
  assert.ok(row, "meal row not found");
  act(() => {
    (row!.props!.onPress as () => void)();
  });
  assert.deepEqual(selected[0], ["meal-x", "pi-x"]);
  renderer.unmount();
});

test("Empty state — no instances at all: only 'Make a plan', no promote list", () => {
  let made = 0;
  const renderer = render(
    { kind: "empty", plans: [] },
    { onMakePlan: () => (made += 1) },
  );
  const texts = flat(renderer.toJSON() as RenderedNode | null);

  assert.ok(
    texts.includes("No plan for this week"),
    `missing empty heading: ${texts}`,
  );
  assert.ok(texts.includes("Make a plan"), `missing empty CTA: ${texts}`);
  // Empty-of-instances: the promote section is omitted entirely.
  assert.ok(
    !texts.includes("Or cook one of your plans"),
    "promote section should be absent with no instance plans",
  );
  assert.ok(
    !texts.includes("Cook this week"),
    "no promote buttons should render with no instance plans",
  );

  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Make a plan",
  );
  assert.ok(cta, "Make a plan not pressable");
  act(() => {
    (cta!.props!.onPress as () => void)();
  });
  assert.equal(made, 1);
  renderer.unmount();
});

test("Empty state — has instances: lists each plan (name + date range) with a 'Cook this week' button", () => {
  const renderer = render({
    kind: "empty",
    plans: [
      { id: "p1", name: "Backyard Classics", dateRangeLabel: "Jun 15 – Jun 21" },
      { id: "p2", name: "Weeknight Express", dateRangeLabel: null },
    ],
  });
  const texts = flat(renderer.toJSON() as RenderedNode | null);

  assert.ok(texts.includes("Or cook one of your plans"), `missing section: ${texts}`);
  assert.ok(texts.includes("Backyard Classics"), `missing plan 1: ${texts}`);
  assert.ok(texts.includes("Jun 15 – Jun 21"), `missing date range: ${texts}`);
  assert.ok(texts.includes("Weeknight Express"), `missing plan 2: ${texts}`);
  // "Make a plan" still present alongside the list.
  assert.ok(texts.includes("Make a plan"), `missing Make a plan: ${texts}`);
  renderer.unmount();
});

test("Empty state — promote-then-resolve: 'Cook this week' fires onCookThisWeek with the plan id", () => {
  const promoted: string[] = [];
  const renderer = render(
    {
      kind: "empty",
      plans: [
        { id: "p1", name: "Backyard Classics", dateRangeLabel: null },
        { id: "p2", name: "Weeknight Express", dateRangeLabel: null },
      ],
    },
    { onCookThisWeek: (id) => promoted.push(id) },
  );

  // Grab the "Cook this week" pressable belonging to the second plan's card.
  // Post-order walk: recurse children first so the SMALLEST subtree containing
  // both the plan name and the label (i.e. that plan's card) wins — otherwise
  // the whole-screen root would match and return the first card's button.
  const tree = renderer.toJSON() as RenderedNode | null;
  function findCookButton(
    node: RenderedNode | string | null,
    planName: string,
  ): RenderedNode | null {
    if (node == null || typeof node === "string") return null;
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const hit = findCookButton(c, planName);
        if (hit) return hit;
      }
    }
    const subtree = gatherText(node).join(" ");
    if (subtree.includes(planName) && subtree.includes("Cook this week")) {
      return findPressableByText(node, "Cook this week");
    }
    return null;
  }
  const btn = findCookButton(tree, "Weeknight Express");
  assert.ok(btn, "Cook this week button not found for the target plan");
  act(() => {
    (btn!.props!.onPress as () => void)();
  });
  assert.deepEqual(promoted, ["p2"]);
  renderer.unmount();
});

test("Empty state — promoting: the in-flight card shows a spinner and the others are disabled", () => {
  const promoted: string[] = [];
  const renderer = render(
    {
      kind: "empty",
      plans: [
        { id: "p1", name: "Backyard Classics", dateRangeLabel: null },
        { id: "p2", name: "Weeknight Express", dateRangeLabel: null },
      ],
    },
    { onCookThisWeek: (id) => promoted.push(id), promotingPlanId: "p1" },
  );
  const tree = renderer.toJSON() as RenderedNode | null;

  // The promoting card's label is replaced by a spinner → exactly one
  // "Cook this week" label remains (the other, still-idle card).
  const texts = flat(tree);
  const labelCount = texts.split("Cook this week").length - 1;
  assert.equal(labelCount, 1, `expected one idle label, saw ${labelCount}`);

  // Tapping the disabled (other) card must NOT fire while a promote is in flight.
  function findDisabledButton(node: RenderedNode | string | null): RenderedNode | null {
    if (node == null || typeof node === "string") return null;
    const props = (node.props ?? {}) as { onPress?: unknown; disabled?: unknown };
    if (props.onPress && props.disabled === true) return node;
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const hit = findDisabledButton(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  const disabled = findDisabledButton(tree);
  assert.ok(disabled, "expected a disabled promote button while one is in flight");
  act(() => {
    (disabled!.props!.onPress as () => void)();
  });
  assert.deepEqual(promoted, [], "disabled card should not fire onCookThisWeek");
  renderer.unmount();
});
