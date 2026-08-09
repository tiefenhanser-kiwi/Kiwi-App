// WS9 L2b — PlanReviewMealRow R2 action-collapse tests (D-WS9-018).
// The row went from 5 inline actions (View · Change Meal · Change Recipe ·
// Find Similar · Compost) to 4 + card-body View:
//   Edit → Meal Detail (existing edit path; 3f repoints to the ingredient editor)
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

import { PlanReviewMealRow } from "../PlanReviewMealRow";
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

test("PlanReviewMealRow: Edit opens Meal Detail (existing edit path, 3f repoints later)", async () => {
  const { renderer, tree } = await render();
  const btn = findPressableByText(tree, "Edit");
  assert.ok(btn, "Edit action not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });
  assert.equal(pushedRoutes.length, 1);
  assert.equal(pushedRoutes[0].pathname, "/meal/[id]");
  assert.equal(pushedRoutes[0].params.id, "meal-1");
  assert.equal(pushedRoutes[0].params.planItemId, "pi-1");
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
