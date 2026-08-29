// WS9 L2b — PlanReviewMealRow R2 action-collapse tests (D-WS9-018).
// The row went from 5 inline actions (View · Change Meal · Change Recipe ·
// Find Similar · Compost) to 4 + card-body View:
//   Edit → /meal-builder in plan context (BUG-180; 3f repoints to D-WS9-004)
//   Swap for Different Meal → onChangeMeal (3d repoints to the merged swap sheet)
//   Swap for Similar Meal   → onFindSimilar (3d repoints to the merged swap sheet)
//   Remove from plan        → onCompost (still a soft-delete)
// Change Recipe is GONE (R-3d-2). The suite is logic-only, so this render test
// is the guard against a wrong action wire — a live regression on Plan Review.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  __setRouterForTests,
  __resetRouterForTests,
} from "expo-router";

import {
  DAY_PILL_LOCKOUT_MS,
  PlanReviewMealRow,
} from "../PlanReviewMealRow";
import type { ReviewPlanMealRow } from "@/lib/types";

let pushedRoutes: Array<{ pathname: string; params: Record<string, string> }>;

beforeEach(() => {
  pushedRoutes = [];
  __setRouterForTests({
    push: (target: { pathname: string; params: Record<string, string> }) => {
      pushedRoutes.push(target);
    },
  });
});

afterEach(() => {
  pushedRoutes = [];
  __resetRouterForTests();
});

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function collectText(node: RenderedNode | string | null | undefined): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(collectText) : [];
}

/** All literal text strings present anywhere in the tree. */
function allText(tree: RenderedNode | null): string[] {
  return collectText(tree);
}

/** The nearest onPress-bearing node whose descendant text === label. */
function findPressableByText(
  tree: RenderedNode | null,
  label: string,
): RenderedNode | null {
  function find(node: RenderedNode | string | null): RenderedNode | null {
    if (node == null || typeof node === "string") return null;
    if ((node.props as { onPress?: unknown } | undefined)?.onPress) {
      if (collectText(node).includes(label)) return node;
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const hit = find(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  return find(tree);
}

const ROW: ReviewPlanMealRow = {
  planItemId: "pi-1",
  mealId: "meal-1",
  title: "Lemon Herb Salmon",
  metaLine: "Easy · 30 min · serves 4",
  caloriesPerServing: 520,
  proteinGPerServing: 38,
  carbsGPerServing: 40,
  fatGPerServing: 18,
  dayStrip: [
    { day: "Sunday", isAssigned: false },
    { day: "Monday", isAssigned: true },
    { day: "Tuesday", isAssigned: false },
    { day: "Wednesday", isAssigned: false },
    { day: "Thursday", isAssigned: false },
    { day: "Friday", isAssigned: false },
    { day: "Saturday", isAssigned: false },
  ],
};

async function render(overrides: Record<string, unknown> = {}) {
  const calls = {
    changeMeal: [] as Array<[string, string]>,
    findSimilar: [] as Array<[string, string, string]>,
    compost: [] as Array<[string, string]>,
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanReviewMealRow, {
        row: ROW,
        planId: "plan-1",
        onChangeMeal: (planItemId: string, mealId: string) =>
          calls.changeMeal.push([planItemId, mealId]),
        onFindSimilar: (planItemId: string, mealId: string, title: string) =>
          calls.findSimilar.push([planItemId, mealId, title]),
        onCompost: (planItemId: string, title: string) =>
          calls.compost.push([planItemId, title]),
        ...overrides,
      }),
    );
  });
  return { renderer, calls, tree: renderer.toJSON() as RenderedNode | null };
}

test("D-WS9-127: the meal title renders on up to three lines so a long title is not truncated to indistinguishability", async () => {
  const longTitle =
    "Air Fryer Crispy Chicken Tenders with Honey Mustard and a Simple Green Salad";
  const { renderer } = await render({ row: { ...ROW, title: longTitle } });
  const titleNode = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === longTitle,
  )[0];
  assert.ok(titleNode, "title node found");
  // WS9 3f-4d Part 1f (D-WS9-127) — row variant grew 2 → 3 lines via the DisplayTitle primitive.
  assert.equal(titleNode.props.numberOfLines, 3, "meal title allows three lines");
  renderer.unmount();
});

test("PlanReviewMealRow: renders exactly the 4 R2 actions, and Change Recipe is gone", async () => {
  const { renderer, tree } = await render();
  const texts = allText(tree);

  for (const label of [
    "Edit",
    "Swap for Different Meal",
    "Swap for Similar Meal",
    "Remove from plan",
  ]) {
    assert.ok(texts.includes(label), `expected action "${label}" to render`);
  }

  // The retired 5-action labels must not survive Layer 2.
  for (const gone of ["View", "Change Meal", "Change Recipe", "Find Similar", "Compost"]) {
    assert.ok(!texts.includes(gone), `retired action "${gone}" should be gone`);
  }
  renderer.unmount();
});

// WS9 BUG-180 — INVERTED, not deleted. This test asserted `/meal/[id]`, which
// was a correct test of the code as shipped: Edit really did open Meal Detail.
// It changes because that was the bug — a button labelled Edit opened a READ
// view, and the identical push a card-body tap already makes, so the control
// duplicated its neighbour instead of doing anything.
test("PlanReviewMealRow: Edit opens the meal EDIT surface in plan context", async () => {
  const { renderer, tree } = await render();
  const btn = findPressableByText(tree, "Edit");
  assert.ok(btn, "Edit action not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });
  assert.equal(pushedRoutes.length, 1);
  assert.equal(pushedRoutes[0].pathname, "/meal-builder");
  // `mealId`, NOT `id`. meal-builder reads mealId from useLocalSearchParams; an
  // `id` param lands it in fresh-create mode with no meal loaded.
  assert.equal(pushedRoutes[0].params.mealId, "meal-1");
  assert.equal(pushedRoutes[0].params.id, undefined, "must not send `id`");
  // All three together are what set isEditFromPlanContext, which drives the
  // PRD §2.5 edit-from-plan vs. global-save prompt. Any one missing and the
  // builder takes the library-edit path instead.
  assert.equal(pushedRoutes[0].params.planId, "plan-1");
  assert.equal(pushedRoutes[0].params.planItemId, "pi-1");
  renderer.unmount();
});

test("PlanReviewMealRow: Edit and the card-body tap now go to DIFFERENT surfaces", async () => {
  // The defect in one assertion: before BUG-180 these produced identical
  // pushes. Edit edits; tapping the card views.
  const { renderer, tree } = await render();
  const editBtn = findPressableByText(tree, "Edit");
  await act(async () => {
    (editBtn!.props!.onPress as () => void)();
  });
  const editPush = pushedRoutes[0];
  const title = findPressableByText(tree, "Lemon Herb Salmon");
  assert.ok(title, "card-body pressable not found");
  await act(async () => {
    (title!.props!.onPress as () => void)();
  });
  const tapPush = pushedRoutes[1];
  assert.equal(editPush.pathname, "/meal-builder");
  assert.equal(tapPush.pathname, "/meal/[id]");
  assert.notEqual(editPush.pathname, tapPush.pathname);
  renderer.unmount();
});

test("PlanReviewMealRow: Swap for Different Meal fires onChangeMeal, not a route", async () => {
  const { renderer, calls, tree } = await render();
  const btn = findPressableByText(tree, "Swap for Different Meal");
  assert.ok(btn, "Swap for Different Meal action not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });
  assert.deepEqual(calls.changeMeal, [["pi-1", "meal-1"]]);
  assert.equal(pushedRoutes.length, 0, "swap must not navigate — parent owns the sheet");
  renderer.unmount();
});

test("PlanReviewMealRow: Swap for Similar Meal fires onFindSimilar with title", async () => {
  const { renderer, calls, tree } = await render();
  const btn = findPressableByText(tree, "Swap for Similar Meal");
  assert.ok(btn, "Swap for Similar Meal action not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });
  assert.deepEqual(calls.findSimilar, [["pi-1", "meal-1", "Lemon Herb Salmon"]]);
  assert.equal(pushedRoutes.length, 0);
  renderer.unmount();
});

test("PlanReviewMealRow: Remove from plan fires onCompost (soft-delete)", async () => {
  const { renderer, calls, tree } = await render();
  const btn = findPressableByText(tree, "Remove from plan");
  assert.ok(btn, "Remove from plan action not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });
  assert.deepEqual(calls.compost, [["pi-1", "Lemon Herb Salmon"]]);
  renderer.unmount();
});

// ── WS9 3c (D-WS9-032) readOnly / draft mode ──────────────────────────────
// A draft row's meal has no real server id, so every edit affordance is either
// hidden (Cook Now + the action buttons) or routed to onReadOnlyEdit (row tap,
// day pills) instead of navigating to a route that would 404. The default-false
// prop keeps the saved-plan tests above unchanged.

// Renders the SAME ROW fixture (real-looking ids, one assigned day) but in
// readOnly mode with an onReadOnlyEdit guard spy.
async function renderReadOnly() {
  let guardCalls = 0;
  const assignDayCalls: Array<[string, string | null]> = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanReviewMealRow, {
        row: ROW,
        planId: "plan-1",
        readOnly: true,
        onReadOnlyEdit: () => {
          guardCalls += 1;
        },
        onAssignDay: (planItemId: string, day: string | null) =>
          assignDayCalls.push([planItemId, day]),
      }),
    );
  });
  return {
    renderer,
    tree: renderer.toJSON() as RenderedNode | null,
    getGuardCalls: () => guardCalls,
    assignDayCalls,
  };
}

test("PlanReviewMealRow readOnly: Cook Now and the 4 edit actions are hidden", async () => {
  const { renderer, tree } = await renderReadOnly();
  const texts = allText(tree);
  for (const gone of [
    "Cook Now",
    "Edit",
    "Swap for Different Meal",
    "Swap for Similar Meal",
    "Remove from plan",
  ]) {
    assert.ok(!texts.includes(gone), `readOnly must hide "${gone}"`);
  }
  renderer.unmount();
});

test("PlanReviewMealRow readOnly: tapping the title fires the guard, not a route", async () => {
  const { renderer, tree, getGuardCalls } = await renderReadOnly();
  const title = findPressableByText(tree, "Lemon Herb Salmon");
  assert.ok(title, "title pressable not found");
  await act(async () => {
    (title!.props!.onPress as () => void)();
  });
  assert.equal(getGuardCalls(), 1);
  assert.equal(pushedRoutes.length, 0, "readOnly row must not navigate");
  renderer.unmount();
});

test("PlanReviewMealRow readOnly: tapping a day pill fires the guard, not onAssignDay", async () => {
  const { renderer, tree, getGuardCalls, assignDayCalls } =
    await renderReadOnly();
  // "M" is Monday's short label — unique in the strip (S/T repeat).
  const dayPill = findPressableByText(tree, "M");
  assert.ok(dayPill, "Monday day pill not found");
  await act(async () => {
    (dayPill!.props!.onPress as () => void)();
  });
  assert.equal(getGuardCalls(), 1);
  assert.deepEqual(assignDayCalls, [], "readOnly day pill must not assign");
  renderer.unmount();
});

// ── WS9-2 2e Phase 4 (D-WS9-159) composted / INERT rows ─────────────────────
// A composted plan is a SOFT delete: the meals stay VISIBLE so the user can see
// what was in the plan and decide whether to bring it back, but nothing on the
// row may act. That is `readOnly` with NO onReadOnlyEdit — a draft's guard
// EXPLAINS why editing is off ("save it to your library"); a composted plan has
// nothing to explain and no action to offer.
//
// This is the other half of the guard that lib/plans/__tests__/planReviewSurface
// pins: that file decides `rowsReadOnly` is true here, and this file proves what
// `rowsReadOnly` without a handler actually DOES.

async function renderInert() {
  const calls = {
    changeMeal: [] as unknown[],
    findSimilar: [] as unknown[],
    compost: [] as unknown[],
    assignDay: [] as unknown[],
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanReviewMealRow, {
        row: ROW,
        planId: "plan-1",
        readOnly: true,
        // NO onReadOnlyEdit — this is the composted wiring.
        onChangeMeal: (...a: unknown[]) => calls.changeMeal.push(a),
        onFindSimilar: (...a: unknown[]) => calls.findSimilar.push(a),
        onCompost: (...a: unknown[]) => calls.compost.push(a),
        onAssignDay: (...a: unknown[]) => calls.assignDay.push(a),
      }),
    );
  });
  return { renderer, calls, tree: renderer.toJSON() as RenderedNode | null };
}

test("PlanReviewMealRow inert: the meal is still VISIBLE — title and meta render", async () => {
  // Load-bearing: the whole reason a composted plan renders its meal list is so
  // the user can see what was in it. An inert row must not be an EMPTY row.
  const { renderer, tree } = await renderInert();
  const texts = allText(tree);
  assert.ok(texts.includes("Lemon Herb Salmon"), "meal title must still render");
  assert.ok(
    texts.includes("Easy · 30 min · serves 4"),
    "meta line must still render",
  );
  renderer.unmount();
});

test("PlanReviewMealRow inert: no edit affordance renders at all", async () => {
  const { renderer, tree } = await renderInert();
  const texts = allText(tree);
  for (const gone of [
    "Cook Now",
    "Edit",
    "Swap for Different Meal",
    "Swap for Similar Meal",
    "Remove from plan",
  ]) {
    assert.ok(!texts.includes(gone), `a composted row must not offer "${gone}"`);
  }
  renderer.unmount();
});

test("PlanReviewMealRow inert: tapping the row does nothing — no route, no guard", async () => {
  const { renderer, tree } = await renderInert();
  const title = findPressableByText(tree, "Lemon Herb Salmon");
  assert.ok(title, "title pressable not found");
  await act(async () => {
    (title!.props!.onPress as () => void)();
  });
  assert.equal(
    pushedRoutes.length,
    0,
    "an inert row must not navigate to Meal Detail",
  );
  renderer.unmount();
});

test("PlanReviewMealRow inert: day pills do not mutate the schedule", async () => {
  // The 7 pills still RENDER (they show which day the meal sat on — part of
  // 'see what was in the plan'), but they must not reassign anything.
  const { renderer, calls, tree } = await renderInert();
  const dayPill = findPressableByText(tree, "M");
  assert.ok(dayPill, "Monday day pill not found");
  await act(async () => {
    (dayPill!.props!.onPress as () => void)();
  });
  assert.deepEqual(
    calls.assignDay,
    [],
    "a composted plan's day pills must not assign",
  );
  renderer.unmount();
});

test("PlanReviewMealRow inert: no handler fires even though all four are supplied", async () => {
  // The screen still passes its mutators down; readOnly is what makes them
  // unreachable. If readOnly ever stops hiding the action row, this catches it.
  const { renderer, calls } = await renderInert();
  assert.deepEqual(calls.changeMeal, []);
  assert.deepEqual(calls.findSimilar, []);
  assert.deepEqual(calls.compost, []);
  renderer.unmount();
});

// ── BUG-104 — day-pill repeat-tap lockout ──────────────────────────────────
//
// The pills had hitSlop={6}, no debounce and no in-flight disable. Hans's
// device log recorded two PATCHes 54ms apart from one intended tap. A repeat
// inside DAY_PILL_LOCKOUT_MS is now swallowed.
//
// A timestamp lockout rather than an in-flight latch on purpose: the row has no
// handle on the write's completion (onAssignDay returns void), so a latch that
// waited for the row to catch up would WEDGE the pills permanently whenever a
// write failed and rolled back to the pre-tap value.

test("BUG-104: a second day-pill tap inside the lockout window is swallowed", async () => {
  const assignDayCalls: Array<[string, string | null]> = [];
  const { renderer, tree } = await render({
    onAssignDay: (planItemId: string, day: string | null) =>
      assignDayCalls.push([planItemId, day]),
  });
  // "W" is Wednesday's short label — unique in the strip.
  const pill = findPressableByText(tree, "W");
  assert.ok(pill, "Wednesday day pill not found");

  await act(async () => {
    (pill!.props!.onPress as () => void)();
    (pill!.props!.onPress as () => void)();
  });

  assert.deepEqual(
    assignDayCalls,
    [["pi-1", "Wednesday"]],
    "one intended tap must produce exactly one assignment, not two",
  );
  renderer.unmount();
});

test("BUG-104: the lockout is time-based, so a later deliberate tap still works", async () => {
  // Pins that the guard cannot WEDGE. Two taps separated by more than the
  // window both land — the control is never dead, only rate-limited.
  const assignDayCalls: Array<[string, string | null]> = [];
  const { renderer, tree } = await render({
    onAssignDay: (planItemId: string, day: string | null) =>
      assignDayCalls.push([planItemId, day]),
  });
  const pill = findPressableByText(tree, "W");
  assert.ok(pill);

  await act(async () => {
    (pill!.props!.onPress as () => void)();
  });
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, DAY_PILL_LOCKOUT_MS + 25));
  });
  await act(async () => {
    (pill!.props!.onPress as () => void)();
  });

  assert.equal(
    assignDayCalls.length,
    2,
    "a tap after the window must land — a permanently dead pill would be worse than the bug",
  );
  renderer.unmount();
});

test("BUG-104: the day-pill console log is RETAINED (Hans is using it on device)", async () => {
  // The log line distinguishes "the UI fired twice" from "the transport sent
  // twice" — the one open question the code could not settle. It must fire for
  // EVERY tap, including one the lockout then swallows.
  const logged: unknown[][] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const { renderer, tree } = await render({ onAssignDay: () => {} });
    const pill = findPressableByText(tree, "W");
    await act(async () => {
      (pill!.props!.onPress as () => void)();
      (pill!.props!.onPress as () => void)();
    });
    renderer.unmount();
  } finally {
    console.log = realLog;
  }
  const taps = logged.filter((a) => a[0] === "[meal-row] day-pill tapped");
  assert.equal(
    taps.length,
    2,
    "both raw tap events must still be logged even though only one assignment fires",
  );
});
