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

// WS9 3f-4d Part 1c (D-WS9-124) — the one-line "what's on the plate" sub-text.
const DESCRIPTION = "Crispy tenders with a tangy honey-mustard and a green salad.";

test("D-WS9-124: MealRow renders description as a one-line sub-text when present", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(MealRow, {
        meal: { ...MEAL, description: DESCRIPTION },
        onPress: () => {},
        onCookNow: () => {},
        onAddToPlan: () => {},
      }),
    );
  });

  const descNode = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === DESCRIPTION,
  )[0];
  assert.ok(descNode, "description sub-text node found");
  assert.equal(descNode.props.numberOfLines, 1, "description clamps to one line");

  renderer.unmount();
});

test("D-WS9-124: MealRow omits the sub-text line entirely when description is null", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(MealRow, {
        meal: { ...MEAL, description: null },
        onPress: () => {},
        onCookNow: () => {},
        onAddToPlan: () => {},
      }),
    );
  });

  // No Text node should carry the description string, and no empty placeholder
  // node stands in its place — the render omits the line rather than blanking it.
  const descNodes = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === DESCRIPTION,
  );
  assert.equal(descNodes.length, 0, "no description node when description is null");

  renderer.unmount();
});

// WS9 3f-4d Part 1e (D-WS9-126) — the SIDES-ONLY sub-line. `dishTitles` is the
// server's already-filtered output: side dishes only, non-empty ONLY for a
// multi-dish meal that has ≥1 side (the main is excluded and the multi-dish gate
// is enforced server-side). So MealRow shows the line whenever dishTitles is
// non-empty, and falls back to `description` when it's empty.
async function renderRow(meal: MealListItem): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(MealRow, {
        meal,
        onPress: () => {},
        onCookNow: () => {},
        onAddToPlan: () => {},
      }),
    );
  });
  return renderer;
}

const SIDES_LINE = "Honey Mustard Slaw · Roasted Potatoes";

test("D-WS9-126: MealRow shows the sides sub-line (joined), main already excluded", async () => {
  const renderer = await renderRow({
    ...MEAL,
    dishTitles: ["Honey Mustard Slaw", "Roasted Potatoes"],
  });
  const node = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === SIDES_LINE,
  )[0];
  assert.ok(node, "sides sub-line node found");
  assert.equal(node.props.numberOfLines, 1, "sides line clamps to one line");
  renderer.unmount();
});

test("D-WS9-126: MealRow shows the single side of a 2-dish meal", async () => {
  const renderer = await renderRow({ ...MEAL, dishTitles: ["Warm Store-Bought Roti"] });
  const nodes = renderer.root.findAll(
    (n) =>
      typeof n.props?.children === "string" &&
      n.props.children === "Warm Store-Bought Roti",
  );
  assert.ok(nodes.length >= 1, "a 2-dish meal shows its one side");
  renderer.unmount();
});

test("D-WS9-126: MealRow shows NO sub-line when dishTitles is empty (single-dish / all-main)", async () => {
  const renderer = await renderRow({ ...MEAL, description: null, dishTitles: [] });
  // Only the meta line uses ` · `; assert no OTHER ` · `-joined line rendered.
  const nodes = renderer.root.findAll(
    (n) =>
      typeof n.props?.children === "string" &&
      n.props.children.includes(" · ") &&
      !n.props.children.includes("min"),
  );
  assert.equal(nodes.length, 0, "no sub-line when there are no sides");
  renderer.unmount();
});

test("D-WS9-126: sides line REPLACES description on a multi-dish meal (precedence)", async () => {
  const renderer = await renderRow({
    ...MEAL,
    description: DESCRIPTION,
    dishTitles: ["Honey Mustard Slaw", "Roasted Potatoes"],
  });
  const dishNode = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === SIDES_LINE,
  );
  const descNode = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === DESCRIPTION,
  );
  assert.ok(dishNode.length >= 1, "sides line shown on multi-dish meal");
  assert.equal(descNode.length, 0, "description suppressed when the sides line shows");
  renderer.unmount();
});

test("D-WS9-126: empty dishTitles falls back to the description line", async () => {
  const renderer = await renderRow({
    ...MEAL,
    description: DESCRIPTION,
    dishTitles: [],
  });
  const descNode = renderer.root.findAll(
    (n) => typeof n.props?.children === "string" && n.props.children === DESCRIPTION,
  );
  assert.ok(descNode.length >= 1, "empty dishTitles falls back to the description line");
  renderer.unmount();
});
