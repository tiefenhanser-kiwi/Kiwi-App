// WS9 3f-4c (BUG-065) — the shared Recipes → Meals list row renders its title on
// two lines, so long titles that share a prefix stay distinguishable (rows grow;
// density decisions wait for real images).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { MealRow } from "../MealRow";
import type { MealListItem } from "@/lib/api/meals";

const LONG_TITLE =
  "Air Fryer Crispy Chicken Tenders with Honey Mustard and a Simple Green Salad";

const MEAL: MealListItem = {
  id: "m-1",
  title: LONG_TITLE,
  cuisine: "American",
  minutes: 30,
  servings: 4,
  authoredServingsDefault: 4,
  calories: 500,
  protein: 30,
  carbs: 40,
  fat: 18,
  tags: [],
  image: null,
};

test("BUG-065: MealRow renders the title on two lines", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(MealRow, {
        meal: MEAL,
        onPress: () => {},
        onCookNow: () => {},
        onAddToPlan: () => {},
      }),
    );
  });

  const titleNode = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === LONG_TITLE,
  )[0];
  assert.ok(titleNode, "title node found");
  assert.equal(titleNode.props.numberOfLines, 2, "meal title allows two lines");

  renderer.unmount();
});
