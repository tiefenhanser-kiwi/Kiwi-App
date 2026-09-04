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
import { Colors, Palette } from "@/constants/tokens";
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

const NOOP = () => {};

interface Handlers {
  onPrepWeek?: () => void;
  onSelectMeal?: (mealId: string, planItemId: string) => void;
  onMakePlan?: () => void;
  onCookThisWeek?: (planId: string) => void;
  promotingPlanId?: string | null;
  // WS9 Prep Selected Meals.
  onPrepSelected?: () => void;
  onToggleMealSelected?: (mealId: string) => void;
  selectedMealIds?: ReadonlySet<string>;
}

function render(model: HubModel, handlers: Handlers = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(PrepCookHubView, {
        model,
        onPrepWeek: handlers.onPrepWeek ?? NOOP,
        onSelectMeal: handlers.onSelectMeal ?? NOOP,
        onMakePlan: handlers.onMakePlan ?? NOOP,
        onCookThisWeek: handlers.onCookThisWeek ?? NOOP,
        promotingPlanId: handlers.promotingPlanId ?? null,
        onPrepSelected: handlers.onPrepSelected ?? NOOP,
        onToggleMealSelected: handlers.onToggleMealSelected ?? NOOP,
        selectedMealIds: handlers.selectedMealIds ?? new Set<string>(),
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
  // "Cook a meal" is now a text prompt over the meal list (D-WS7-158), and the
  // Prep-the-Week lane remains a CTA.
  assert.ok(texts.includes("Cook a meal"), `missing Cook prompt: ${texts}`);
  assert.ok(
    texts.includes("Pick a meal from your plan and cook"),
    `missing Cook prompt body: ${texts}`,
  );
  assert.ok(texts.includes("Prep the Week"), `missing Prep lane CTA: ${texts}`);
  // Meal rows + pills.
  assert.ok(texts.includes("Done Meal"), `missing meal title: ${texts}`);
  assert.ok(texts.includes("Prepped ✓"), `missing prepped pill: ${texts}`);

  renderer.unmount();
});

test("Hub: 'Cook a meal' is a non-pressable text prompt (no CTA button); D-WS7-158", () => {
  // The old "Cook a meal" lane was a button-CTA; the redesign drops the button
  // and reframes the meal list as the tap target. Assert no pressable carries
  // the "Cook a meal" label (the prompt is plain text; the rows route instead).
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
    "Sunday",
  );
  const selected: Array<[string, string]> = [];
  const renderer = render(model, {
    onSelectMeal: ((m: string, p: string) => {
      selected.push([m, p]);
    }) as never,
  });
  const tree = renderer.toJSON() as RenderedNode | null;

  // No pressable is labelled "Cook a meal" — it is a heading, not a CTA.
  const cta = findPressableByText(tree, "Cook a meal");
  assert.equal(cta, null, "'Cook a meal' should no longer be a pressable CTA");

  // The meal row is the tap target and still routes with both ids.
  const row = findPressableByText(tree, "Tap Target");
  assert.ok(row, "meal row not found");
  act(() => {
    (row!.props!.onPress as () => void)();
  });
  assert.deepEqual(selected[0], ["meal-x", "pi-x"]);
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

  // ⚠️ WS9 BUG-199 §2B — this used to assert the CTA was NOT a Pressable at all,
  // because the disabled state rendered a plain <View>. The CTA is now
  // <Button variant="primary" disabled>, which renders a real Pressable carrying
  // RN's `disabled` prop — so the old assertion pinned an IMPLEMENTATION (View
  // vs disabled Pressable) rather than the behaviour it was written to protect.
  //
  // Rewritten to assert the behaviour directly, which is a STRONGER guard: it
  // now actually fires the handler. The old shape checked `prepped === 0`
  // without ever pressing anything, so it would have passed even if the button
  // were fully live.
  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Week is prepped",
  );
  assert.ok(cta, "the disabled CTA still renders (as a disabled Button)");
  assert.equal(
    (cta as { props?: { disabled?: boolean } }).props?.disabled,
    true,
    "the disabled CTA must carry RN's disabled prop, not just look dimmed",
  );
  (cta as { props: { onPress: () => void } }).props.onPress();
  assert.equal(prepped, 0, "pressing a prepped week must not fire onPrepWeek");
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

// ── WS9 BUG-199 §2B — the Prep-the-Week CTA is the app's PRIMARY treatment ───
// Hans: "I was asking for the primary CTA to get the same terracotta with white
// text treatment that was just applied elsewhere." It was a cream-filled block
// with a muted-sage label — the secondary/ghost look.
//
// ⚠️ THIS READS THE RENDERED STYLE, NOT A LITERAL RESTATED FROM TOKENS. A guard
// that asserts "#C24F25" === "#C24F25" stays green while the component points
// somewhere else entirely — that exact shape shipped and stayed green under a
// verified mutation earlier in BUG-199. The expected values below come from
// Palette.button.primary (what the primitive uses); the CONNECTION being tested
// is that this CTA actually routes through it.
test("BUG-199 §2B: the Prep-the-Week CTA renders the primary fill + white label", () => {
  const model = buildPrepCookHubModel(
    plan({ items: [item({ id: "a", isPrepped: false })] }),
    "Sunday",
  );
  const renderer = render(model, { onPrepWeek: () => {} });
  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Prep the Week",
  );
  assert.ok(cta, "Prep the Week CTA not found");

  // ⚠️ This harness's Pressable passes `style` through UNRESOLVED — it stays the
  // `({ pressed }) => [...]` function rather than a flattened array — so it has
  // to be invoked before anything can be read off it. Reading `props.style`
  // directly yields a function and every lookup on it is `undefined`, which
  // reads exactly like "the style is missing" rather than "the style is lazy".
  const raw = (cta as { props: { style: unknown } }).props.style;
  const resolved = typeof raw === "function" ? raw({ pressed: false }) : raw;
  const style = Object.assign(
    {},
    ...[resolved].flat(Infinity).filter((x) => x && typeof x === "object"),
  ) as Record<string, unknown>;

  assert.equal(
    style.backgroundColor,
    Palette.button.primary.background,
    "the CTA must carry the primary terracotta fill, not a cream one",
  );

  // ⚠️ The RING. The terracotta fill measures 1.1033:1 against this lane's
  // sage[600] surface — the LABEL reads fine (4.7308) but the button's SHAPE has
  // no luminance step against the card, and terracotta-on-sage is red-on-green,
  // the pair that collapses under red-green colour blindness. The white ring
  // carries the boundary by luminance instead: 5.2197 vs the lane, 4.7308 vs the
  // fill. Deleting it leaves a button whose edge only some users can see.
  assert.equal(
    style.borderColor,
    Palette.button.primary.text,
    "the CTA needs a light ring — its fill does not separate from the sage lane",
  );
  assert.ok(
    (style.borderWidth as number) > 0,
    "a borderColor with no borderWidth draws nothing",
  );
  renderer.unmount();
});

// ── WS9 Prep Selected Meals — the Hub's second CTA + per-row selection ───────

// Resolve a Pressable's lazy `style` prop into a flat object. Same mechanics the
// BUG-199 §2B guard above documents: this harness passes `style` through as the
// UNRESOLVED `({ pressed }) => [...]` function, so it must be invoked before
// anything can be read off it.
function resolvedStyle(node: RenderedNode): Record<string, unknown> {
  const raw = (node as { props: { style?: unknown } }).props.style;
  const out = typeof raw === "function" ? (raw as (s: unknown) => unknown)({ pressed: false }) : raw;
  return Object.assign(
    {},
    ...[out].flat(Infinity).filter((x) => x && typeof x === "object"),
  ) as Record<string, unknown>;
}

// D-WS9-207 Part 2 — helpers for the rewritten hierarchy guard.
function findAllByType(
  node: RenderedNode | string | null,
  type: string,
  out: RenderedNode[] = [],
): RenderedNode[] {
  if (node == null || typeof node === "string") return out;
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAllByType(c, type, out);
  }
  return out;
}

/** The first node whose RESOLVED style paints the given background. */
function findByBackground(
  node: RenderedNode | string | null,
  color: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  if (resolvedStyle(node).backgroundColor === color) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findByBackground(c, color);
      if (hit) return hit;
    }
  }
  return null;
}

function findAllByRole(
  node: RenderedNode | string | null,
  role: string,
  out: RenderedNode[] = [],
): RenderedNode[] {
  if (node == null || typeof node === "string") return out;
  const props = (node.props ?? {}) as { accessibilityRole?: string };
  if (props.accessibilityRole === role) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAllByRole(c, role, out);
  }
  return out;
}

function twoMealPlan() {
  return plan({
    items: [
      item({ id: "pi1", mealId: "m1", meal: meal({ id: "m1", title: "Lemon Chicken" }) }),
      item({ id: "pi2", mealId: "m2", meal: meal({ id: "m2", title: "Beef Tacos" }) }),
    ],
  });
}

test("WS9: the Prep Selected Meals CTA is DISABLED until a meal is ticked", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  let pressed = 0;
  const renderer = render(model, { onPrepSelected: () => { pressed++; } });
  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Prep Selected Meals",
  );
  assert.ok(cta, "Prep Selected Meals CTA not found");
  // Read the LIVE prop, and prove the disable actually suppresses the handler
  // rather than merely dimming the button.
  assert.equal((cta as { props: { disabled?: boolean } }).props.disabled, true);
  act(() => {
    (cta as { props: { onPress: () => void } }).props.onPress();
  });
  assert.equal(pressed, 0, "a disabled CTA must not fire a paid AI call");
  renderer.unmount();
});

test("WS9: with a meal ticked the CTA enables and fires onPrepSelected", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  let pressed = 0;
  const renderer = render(model, {
    selectedMealIds: new Set(["m2"]),
    onPrepSelected: () => { pressed++; },
  });
  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Prep Selected Meals",
  );
  assert.ok(cta);
  // Button forwards `disabled || loading`, so an enabled button reports
  // `undefined` rather than `false` — assert "not disabled", then prove it by
  // actually firing.
  assert.notEqual((cta as { props: { disabled?: boolean } }).props.disabled, true);
  act(() => {
    (cta as { props: { onPress: () => void } }).props.onPress();
  });
  assert.equal(pressed, 1);
  renderer.unmount();
});

test("WS9: the hint line counts the LIVE selection against the week", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  const none = render(model, {});
  assert.ok(
    flat(none.toJSON() as RenderedNode | null).includes("Tick the meals below"),
    "empty-selection hint missing",
  );
  none.unmount();

  const one = render(model, { selectedMealIds: new Set(["m1"]) });
  assert.ok(
    flat(one.toJSON() as RenderedNode | null).includes("1 of 2 selected"),
    "selection count must be derived from the model + the live set",
  );
  one.unmount();

  const both = render(model, { selectedMealIds: new Set(["m1", "m2"]) });
  assert.ok(
    flat(both.toJSON() as RenderedNode | null).includes("2 of 2 selected"),
  );
  both.unmount();
});

test("WS9: a selected id that is not on this week's list cannot enable the CTA", () => {
  // A stale tick left over from a plan edit must not arm a paid call for a meal
  // the user can no longer see. The count is filtered through model.meals.
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  const renderer = render(model, { selectedMealIds: new Set(["m-gone"]) });
  const cta = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Prep Selected Meals",
  );
  assert.ok(cta);
  assert.equal((cta as { props: { disabled?: boolean } }).props.disabled, true);
  renderer.unmount();
});

test("WS9: ticking a row's checkbox selects that meal and does NOT launch Cook Mode", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  const toggled: string[] = [];
  const cooked: string[] = [];
  const renderer = render(model, {
    onToggleMealSelected: (id) => toggled.push(id),
    onSelectMeal: (mealId) => cooked.push(mealId),
  });
  const boxes = findAllByRole(renderer.toJSON() as RenderedNode | null, "checkbox");
  assert.equal(boxes.length, 2, "one tick per this-week meal row");
  act(() => {
    (boxes[1] as { props: { onPress: () => void } }).props.onPress();
  });
  // The row's own onPress (Cook Mode) must not have fired from the same gesture.
  assert.deepEqual(toggled, ["m2"]);
  assert.deepEqual(cooked, []);
  renderer.unmount();
});

// D-WS9-207 Part 2 (Sept 4) — the tick now carries a label. It has to, because
// the CTA it feeds moved up into the sage lane and no longer sits beside it.
// The label must be INSIDE the checkbox's own Pressable: a caption outside it
// would be a word you can tap and have nothing happen, on a row whose other tap
// target launches Cook Mode.
test("WS9: each tick carries a 'Prep This Meal' label INSIDE its own tap target", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  const toggled: string[] = [];
  const renderer = render(model, {
    onToggleMealSelected: (id: string) => toggled.push(id),
  });
  const tree = renderer.toJSON() as RenderedNode | null;

  // One label per meal row, not one for the screen.
  const labels = gatherText(tree).filter((t) => t === "Prep This Meal");
  assert.equal(
    labels.length,
    model.meals.length,
    `expected one label per meal row (${model.meals.length}), got ${labels.length}`,
  );

  // ⚠️ Read from the CHECKBOX outward, not from the label inward:
  // findPressableByText returns the OUTERMOST pressable containing the text,
  // which on this row is the Cook-Mode row itself — it would pass even if the
  // label sat outside the tick entirely. Each accessibilityRole="checkbox"
  // target must contain the words.
  const boxes = findAllByRole(tree, "checkbox");
  assert.equal(boxes.length, model.meals.length, "one checkbox per meal row");
  for (const box of boxes) {
    assert.ok(
      gatherText(box).includes("Prep This Meal"),
      "a tick target does not contain its own label",
    );
  }
  // …and pressing that target selects rather than opening Cook Mode.
  act(() => {
    ((boxes[0].props as { onPress: () => void }).onPress)();
  });
  assert.equal(toggled.length, 1, "pressing the tick toggled the selection");
  renderer.unmount();
});

test("WS9: a ticked checkbox reports checked, an unticked one does not", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  const renderer = render(model, { selectedMealIds: new Set(["m1"]) });
  const boxes = findAllByRole(renderer.toJSON() as RenderedNode | null, "checkbox");
  assert.equal(boxes.length, 2);
  const checked = boxes.map(
    (b) => (b.props as { accessibilityState?: { checked?: boolean } })
      .accessibilityState?.checked,
  );
  assert.deepEqual(checked, [true, false]);
  renderer.unmount();
});

// 🔴 THE HIERARCHY GUARD. Two identical CTAs stacked means neither is primary.
// This reads BOTH buttons' RENDERED fills and asserts they route through
// different Palette entries — it does not restate a hex against itself, and it
// does not pass if the two buttons happen to share a variant.
//
// ⚠️ REWRITTEN, D-WS9-207 Part 2 (Sept 4). The two CTAs are now in the SAME
// lane, so "different position" is no longer available to carry the hierarchy
// and the whole load falls on the weights. The guard therefore got stricter,
// not looser: it pins that the subset CTA is UNFILLED (the lane shows through),
// that it is neither of the two treatments explicitly ruled out — a white fill
// or a white ring — and that both buttons really are inside the sage lane.
test("WS9: Prep the Week stays dominant — filled primary over an UNFILLED peer, both in the sage lane", () => {
  const model = buildPrepCookHubModel(twoMealPlan(), "Sunday");
  const renderer = render(model, { selectedMealIds: new Set(["m1"]) });
  const tree = renderer.toJSON() as RenderedNode | null;

  const primary = findPressableByText(tree, "Prep the Week");
  const secondary = findPressableByText(tree, "Prep Selected Meals");
  assert.ok(primary && secondary);

  const pStyle = resolvedStyle(primary);
  const sStyle = resolvedStyle(secondary);

  // Weight 1: terracotta FILL.
  assert.equal(pStyle.backgroundColor, Palette.button.primary.background);
  // Weight 2: no fill at all, so the sage lane reads through it.
  assert.equal(sStyle.backgroundColor, "transparent");
  assert.notEqual(pStyle.backgroundColor, sStyle.backgroundColor);

  // ⚠️ THE TWO TREATMENTS RULED OUT BY NAME. A white FILL would out-shout the
  // terracotta (neutral[0] on sage[600] is 5.2197:1 against the primary fill's
  // 1.1033:1 hue-only separation). A white RING is the PRIMARY's device, for
  // giving a terracotta fill an edge against sage; on an unfilled button it
  // would just read as a second ring of the same colour.
  assert.notEqual(sStyle.backgroundColor, Palette.button.secondary.background);
  assert.notEqual(sStyle.borderColor, Palette.button.primary.text);
  // Cream edge — the same ink as the lane's own title, 4.8817:1 on sage[600].
  assert.equal(sStyle.borderColor, Palette.text.inverse);
  assert.equal(sStyle.borderColor, "#FBF7EF");

  // …and the label is cream too, not the neutral[900] a `ghost` would give
  // (2.7401:1 on sage[600], under the AA floor).
  const sLabel = findAllByType(secondary, "rn-text")[0];
  assert.ok(sLabel, "the subset CTA renders a label");
  assert.equal(resolvedStyle(sLabel).color, Palette.text.inverse);

  // PLACEMENT: both CTAs are inside the sage[600] lane. Read by walking DOWN
  // from the lane view rather than by trusting document order, so a button that
  // drifts back onto the page goes red here.
  const lane = findByBackground(tree, Colors.sage[600]);
  assert.ok(lane, "the sage lane renders");
  const laneText = flat(lane);
  assert.ok(laneText.includes("Prep the Week"), "primary is in the lane");
  assert.ok(
    laneText.includes("Prep Selected Meals"),
    "the subset CTA is NOT in the sage lane",
  );
  renderer.unmount();
});
