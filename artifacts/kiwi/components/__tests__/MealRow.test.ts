// WS9 3f-4c (BUG-065) / Part 1f (D-WS9-127) — the shared Recipes → Meals list row
// renders its title on up to THREE lines (grew from two when the dish sub-line was
// abandoned), so long composite titles render in full; the row grows only when the
// text needs it. Also covers the Part 1c description sub-text line.

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

test("D-WS9-127: MealRow renders the title on up to three lines", async () => {
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
  assert.equal(titleNode.props.numberOfLines, 3, "meal title allows three lines");

  renderer.unmount();
});

// WS9 3f-4d Part 1c (D-WS9-124) — the one-line "what's on the plate" sub-text.
const DESCRIPTION = "Crispy tenders with a tangy honey-mustard and a green salad.";

test("D-WS9-124 + BUG-158: MealRow renders description as a TWO-line sub-text when present", async () => {
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
  // ⚠️ WS9 BUG-158 AMENDMENT (Sept 2) — TWO, was one. The previous comment here
  // said one line was "deliberate" and warned against harmonising to 2; that
  // recorded the ruling live at the time. Hans has since seen both on device and
  // ruled two for My Recipes: "I think two lines in My Recipes is a good call,
  // maybe 3, but it's a lot of text on the card." TWO, NOT THREE — he named
  // three and declined it in the same sentence.
  // D-WS9-124 was read in canon before this changed: it ruled the AUTHORING of
  // `description` (char caps, prompts, wiring) and never a line count.
  // All three description surfaces are now 2, so there is no divergence left to
  // guard — but this stays pinned so a drift to 1 or 3 is red either way.
  assert.equal(descNode.props.numberOfLines, 2, "description clamps to two lines");

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
