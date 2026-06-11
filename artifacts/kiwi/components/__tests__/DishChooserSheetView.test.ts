// WS7-6 C-fix Block 4 — presentational sheet pieces.
//   - DishChooserHeader: the three add-method cards render in the reordered
//     order (Ask Kiwi → Add Simple Dish → Create from Scratch) ABOVE the My
//     Dishes section, and the sort dropdown greys `last_cooked`.
//   - DishChooserRow: renders the name, the full per-serving macro line, and
//     the real "Used in N meals" label.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text, TextInput } from "react-native";

import {
  DishChooserHeader,
  DishChooserRow,
} from "../DishChooserSheetView";
import { SortDropdown } from "../SortDropdown";
import type { SavedDish } from "../../lib/types";

// DFS-ordered list of every Text leaf's string content.
function textLeaves(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

function makeDish(overrides: Partial<SavedDish> = {}): SavedDish {
  return {
    id: "dish-1",
    name: "Roasted Broccoli",
    type: "main",
    ingredients: [],
    caloriesPerServing: 110,
    proteinGPerServing: 4,
    carbsGPerServing: 8,
    fatGPerServing: 7,
    mealUseCount: 3,
    estimatedTimeMinutes: 25,
    ...overrides,
  };
}

test("DishChooserHeader: add-method cards render reordered, above My Dishes", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DishChooserHeader, {
        sortKey: "alpha",
        onSortChange: () => {},
        onSubmitAsk: () => {},
        onSubmitSimpleDish: () => {},
        onCreateFromScratch: () => {},
      }),
    );
  });

  const leaves = textLeaves(renderer.root);
  const idx = (s: string) => leaves.findIndex((t) => t === s);

  const askKiwi = idx("Ask Kiwi");
  const simple = idx("Add Simple Dish");
  const scratch = idx("Create from scratch");
  const myDishes = idx("My Dishes");

  assert.ok(askKiwi >= 0, "Ask Kiwi card missing");
  assert.ok(simple >= 0, "Add Simple Dish card missing");
  assert.ok(scratch >= 0, "Create from scratch card missing");
  assert.ok(myDishes >= 0, "My Dishes section missing");

  // Reordered: Ask Kiwi → Add Simple Dish → Create from Scratch → My Dishes.
  assert.ok(askKiwi < simple, "Ask Kiwi should precede Add Simple Dish");
  assert.ok(simple < scratch, "Add Simple Dish should precede Create from scratch");
  assert.ok(scratch < myDishes, "Create from scratch should precede My Dishes");

  renderer.unmount();
});

// WS7-6 G3 Scope C — the Ask Kiwi card is now a NAVIGATION target: tapping it
// fires onSubmitAsk (which the Meal Builder mount routes to ask-kiwi-dish).
// Crucially it must NOT mount an inline TextInput inside this header — that
// embedded field (the header is the FlatList's scroll surface) was the
// runaway-scroll bug. The header here renders no TextInput at all.
test("DishChooserHeader: Ask Kiwi is a nav card (fires onSubmitAsk, no embedded input)", async () => {
  let asked = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DishChooserHeader, {
        sortKey: "alpha",
        onSortChange: () => {},
        onSubmitAsk: () => {
          asked += 1;
        },
        onSubmitSimpleDish: () => {},
        onCreateFromScratch: () => {},
      }),
    );
  });

  // No TextInput is mounted by the header (the simple-dish input only appears
  // after expanding that card — collapsed by default).
  assert.equal(
    renderer.root.findAllByType(TextInput).length,
    0,
    "header should mount no inline TextInput (the Ask Kiwi embedded field is gone)",
  );

  const askCard = renderer.root
    .findAllByType(Pressable)
    .find((p) => p.props.testID === "dish-chooser-ask-kiwi");
  assert.ok(askCard, "ask-kiwi nav card not found");
  await act(async () => {
    askCard!.props.onPress({});
  });
  assert.equal(asked, 1, "tapping the Ask Kiwi card should fire onSubmitAsk");

  renderer.unmount();
});

test("DishChooserHeader: greys last_cooked on the sort dropdown", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DishChooserHeader, {
        sortKey: "alpha",
        onSortChange: () => {},
        onSubmitAsk: () => {},
        onSubmitSimpleDish: () => {},
        onCreateFromScratch: () => {},
      }),
    );
  });

  const dropdown = renderer.root.findByType(SortDropdown);
  assert.deepEqual(dropdown.props.disabledKeys, ["last_cooked"]);
  assert.equal(dropdown.props.labelOverrides?.times_cooked, "Most used");

  renderer.unmount();
});

test("DishChooserHeader: Create from scratch fires its callback", async () => {
  let fired = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DishChooserHeader, {
        sortKey: "alpha",
        onSortChange: () => {},
        onSubmitAsk: () => {},
        onSubmitSimpleDish: () => {},
        onCreateFromScratch: () => {
          fired += 1;
        },
      }),
    );
  });

  const card = renderer.root
    .findAllByType(Pressable)
    .find((p) => p.props.testID === "dish-chooser-create-from-scratch");
  assert.ok(card, "create-from-scratch card not found");
  await act(async () => {
    card!.props.onPress({});
  });
  assert.equal(fired, 1);

  renderer.unmount();
});

test("DishChooserRow: renders name, full macro line, and 'Used in N meals'", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DishChooserRow, {
        dish: makeDish(),
        onPress: () => {},
      }),
    );
  });

  const joined = textLeaves(renderer.root).join(" | ");
  assert.ok(joined.includes("Roasted Broccoli"), "name missing");
  assert.ok(
    joined.includes("110 cal · 4g P · 8g C · 7g F"),
    `macro line missing: ${joined}`,
  );
  assert.ok(joined.includes("Used in 3"), "use-count missing");
  assert.ok(joined.includes("meals"), "use-count plural missing");

  renderer.unmount();
});

test("DishChooserRow: zero-calorie dish renders the macro line with zeros (real data)", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DishChooserRow, {
        dish: makeDish({
          name: "Garlic Green Beans",
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          mealUseCount: 0,
        }),
        onPress: () => {},
      }),
    );
  });

  const joined = textLeaves(renderer.root).join(" | ");
  assert.ok(joined.includes("0 cal · 0g P · 0g C · 0g F"), `zeros missing: ${joined}`);
  // mealUseCount 0 → no "Used in" label.
  assert.ok(!joined.includes("Used in"), "0-use dish should not show the label");

  renderer.unmount();
});
