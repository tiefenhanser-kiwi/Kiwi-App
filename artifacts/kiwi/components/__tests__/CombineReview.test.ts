// WS7-6 G1 — greyed-Save fix. The Mode-C review surface (where Save lives) now
// hosts the meal-name input + the saveAttempted-gated inline error, so a user
// who reaches it without naming the meal can fix it in place instead of facing
// a dead greyed button.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text, TextInput } from "react-native";

import { CombineReview } from "../CombineReview";
import type { SavedDish } from "../../lib/types";

function makeDish(overrides: Partial<SavedDish> = {}): SavedDish {
  return {
    id: "dish-1",
    name: "Roasted Broccoli",
    type: "main",
    ingredients: [{ quantity: 2, unit: "cups", name: "broccoli" }],
    caloriesPerServing: 110,
    proteinGPerServing: 4,
    carbsGPerServing: 8,
    fatGPerServing: 7,
    mealUseCount: 0,
    estimatedTimeMinutes: 25,
    ...overrides,
  };
}

function nameInput(root: TestRenderer.ReactTestInstance) {
  return root
    .findAllByType(TextInput)
    .find((t) => t.props.testID === "combine-review-name");
}

function textLeaves(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

test("name input is present on the review surface, pre-filled from state", () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CombineReview, {
        savedDishes: [makeDish()],
        selectedDishIds: ["dish-1"],
        onBack: () => {},
        mealName: "Veggie Night",
        setMealName: () => {},
        nameError: false,
      }),
    );
  });

  const input = nameInput(renderer.root);
  assert.ok(input, "name input missing from the review surface");
  assert.equal(input!.props.value, "Veggie Night");
  // No error badge when the name is present.
  assert.ok(
    !textLeaves(renderer.root).includes("Add a meal name to save."),
    "error badge should be hidden when a name is present",
  );
  renderer.unmount();
});

test("nameError surfaces the inline 'Add a meal name to save.' badge", () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CombineReview, {
        savedDishes: [makeDish()],
        selectedDishIds: ["dish-1"],
        onBack: () => {},
        mealName: "",
        setMealName: () => {},
        nameError: true,
      }),
    );
  });

  assert.ok(nameInput(renderer.root), "name input still present when invalid");
  assert.ok(
    textLeaves(renderer.root).includes("Add a meal name to save."),
    "inline name error badge missing",
  );
  renderer.unmount();
});

test("typing in the name input calls setMealName", () => {
  let typed = "";
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CombineReview, {
        savedDishes: [makeDish()],
        selectedDishIds: ["dish-1"],
        onBack: () => {},
        mealName: "",
        setMealName: (v: string) => {
          typed = v;
        },
        nameError: false,
      }),
    );
  });

  act(() => {
    nameInput(renderer.root)!.props.onChangeText("Taco Night");
  });
  assert.equal(typed, "Taco Night");
  renderer.unmount();
});

test("renders the selected dish names for review", () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CombineReview, {
        savedDishes: [
          makeDish(),
          makeDish({ id: "dish-2", name: "Garlic Rice" }),
        ],
        selectedDishIds: ["dish-1", "dish-2"],
        onBack: () => {},
        mealName: "Dinner",
        setMealName: () => {},
        nameError: false,
      }),
    );
  });

  const joined = textLeaves(renderer.root).join(" | ");
  assert.ok(joined.includes("Roasted Broccoli"), "dish 1 name missing");
  assert.ok(joined.includes("Garlic Rice"), "dish 2 name missing");
  renderer.unmount();
});
