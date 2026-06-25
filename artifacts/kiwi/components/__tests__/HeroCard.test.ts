// WS7-8 #1 — HeroCard routing-contract tests. Pins that the TODAY branch hands
// back full plan-item context (planId + planItemId + mealId) for Meal Detail,
// while the ACTIVE-PLAN branch hands back only planId for Plan Detail — the two
// must stay distinct so a today card never lands on the plan and vice-versa.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { HeroCard } from "../HeroCard";
import type { HeroModel } from "@/lib/home/heroState";
import type { MealListItem } from "@/lib/api/meals";

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function firstPressable(node: RenderedNode | string | null): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  const props = (node.props ?? {}) as { onPress?: unknown };
  if (props.onPress) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = firstPressable(c);
      if (hit) return hit;
    }
  }
  return null;
}

const MEAL: MealListItem = {
  id: "meal-1",
  title: "Salmon Teriyaki",
  cuisine: "Japanese",
  minutes: 30,
  servings: 4,
  calories: 540,
  protein: 38,
  carbs: 32,
  fat: 24,
  tags: ["seafood"],
  image: null,
};

interface Spies {
  plan: string[];
  today: Array<[string, string, string]>;
  empty: number;
}

function renderCard(model: HeroModel) {
  const spies: Spies = { plan: [], today: [], empty: 0 };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(HeroCard, {
        model,
        onPressPlan: (planId: string) => spies.plan.push(planId),
        onPressToday: (planId: string, planItemId: string, mealId: string) =>
          spies.today.push([planId, planItemId, mealId]),
        onPressEmpty: () => {
          spies.empty += 1;
        },
      }),
    );
  });
  return { renderer, spies };
}

test("HeroCard today branch → Meal Detail context (planId, planItemId, mealId)", () => {
  const model: HeroModel = {
    kind: "today",
    planId: "plan-1",
    planItemId: "item-1",
    meal: MEAL,
  };
  const { renderer, spies } = renderCard(model);
  const press = firstPressable(renderer.toJSON() as RenderedNode | null);
  assert.ok(press, "today card not pressable");
  act(() => (press!.props!.onPress as () => void)());

  // The three ids Meal Detail destructures: id (meal), planId, planItemId.
  assert.deepEqual(spies.today, [["plan-1", "item-1", "meal-1"]]);
  // The today card must NOT fall through to the plan handler.
  assert.deepEqual(spies.plan, []);
  renderer.unmount();
});

test("HeroCard active-plan branch → Plan Detail (planId only, not the today handler)", () => {
  const model: HeroModel = {
    kind: "plan",
    planId: "plan-9",
    name: "Spice It Up",
    durationDays: 7,
  };
  const { renderer, spies } = renderCard(model);
  const press = firstPressable(renderer.toJSON() as RenderedNode | null);
  assert.ok(press, "plan card not pressable");
  act(() => (press!.props!.onPress as () => void)());

  assert.deepEqual(spies.plan, ["plan-9"]);
  assert.deepEqual(spies.today, [], "plan branch must not fire onPressToday");
  renderer.unmount();
});

test("HeroCard empty branch → onPressEmpty", () => {
  const { renderer, spies } = renderCard({ kind: "empty" });
  const press = firstPressable(renderer.toJSON() as RenderedNode | null);
  assert.ok(press, "empty card not pressable");
  act(() => (press!.props!.onPress as () => void)());
  assert.equal(spies.empty, 1);
  assert.deepEqual(spies.plan, []);
  assert.deepEqual(spies.today, []);
  renderer.unmount();
});
