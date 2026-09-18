// WS9 row 5 Block 2 — every meal slot renders the meal's image through
// TreatedImage: a url mounts ONE image element carrying that uri over the
// gradient; null mounts NO image element and the gradient alone. The gradient
// is the ruled terminal state for a meal that never gets a photo (D-WS9-230 /
// D-WS9-246), so the null case must never grow a spinner, a glyph or a label.
//
// The slots pinned here are the ones this block wired or re-routed: the Pick
// card (was `source={null}`), MealRowBody (was a raw <Image> over a flat sage
// square), PlanReviewMealRow (raw <Image>), DishRow (raw <Image>). The three
// sheets and the Hub row use the identical TreatedImage call and are exercised
// by their own suites mounting.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { ImageTreatment } from "@/constants/tokens";
import type { DishListItem } from "@/lib/api/dishes";
import type { ShelfMeal } from "@/lib/api/wizard";
import type { ReviewPlanMealRow } from "@/lib/types";
import { DishRow } from "../DishRow";
import { MealPickCard } from "../MealPickCard";
import { MealRowBody } from "../MealRowBody";
import { PlanReviewMealRow } from "../PlanReviewMealRow";

// The host element TreatedImage mounts for a photo. The test stubs render a
// react-native Image as "rn-image" (stubs/react-native.mjs).
const IMAGE_HOST = "rn-image";
const GRADIENT_HOST = "rn-linear-gradient";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};
type Tree = Json | string | null | (Json | string)[];

function walk(node: Tree): Json[] {
  if (node == null || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((c) => walk(c));
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}

function render(el: React.ReactElement): Json[] {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(el);
  });
  return walk(tree.toJSON() as unknown as Tree);
}

function images(nodes: Json[]) {
  return nodes.filter((n) => n.type === IMAGE_HOST);
}
function gradients(nodes: Json[]) {
  return nodes.filter((n) => n.type === GRADIENT_HOST);
}
/** The TreatedImage wrapper: the view whose style stack carries the thumb's
 *  fixed width. Lets a test pin the SIZE a slot asked for. */
function wrapWidths(nodes: Json[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    const style = n.props.style;
    const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
    for (const s of flat) {
      if (s && typeof s === "object" && typeof (s as { width?: unknown }).width === "number") {
        out.push((s as { width: number }).width);
      }
    }
  }
  return out;
}

const URL = "https://storage.googleapis.com/kiwi-prod-508416-images/meals/meal-1.jpg";

// ── fixtures ────────────────────────────────────────────────────────────────

function shelfMeal(extra: Partial<ShelfMeal> = {}): ShelfMeal {
  return {
    id: "meal-1",
    title: "Lemon Herb Salmon",
    description: "Bright and quick.",
    cuisineType: "Mediterranean",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    activeTimeMinutes: 15,
    macrosPerServing: { calories: 520, protein: 38, carbs: 40, fat: 18 },
    tags: [],
    dishCount: 2,
    isNewToYou: false,
    isPlaylist: false,
    isPinned: false,
    matchesCuisine: true,
    source: "shelf",
    ...extra,
  };
}

function reviewRow(extra: Partial<ReviewPlanMealRow> = {}): ReviewPlanMealRow {
  return {
    planItemId: "pi-1",
    mealId: "meal-1",
    title: "Lemon Herb Salmon",
    metaLine: "Easy · 30 min · serves 4",
    dayStrip: [],
    ...extra,
  };
}

function dish(extra: Partial<DishListItem> = {}): DishListItem {
  return {
    id: "dish-1",
    title: "Garlic Rice",
    minutes: 20,
    servings: 4,
    difficulty: "easy",
    calories: 210,
    protein: 4,
    carbs: 44,
    fat: 2,
    tags: [],
    image: null,
    mealUseCount: 0,
    ...extra,
  };
}

// ── MealPickCard (Part A — was source={null}) ───────────────────────────────

test("MealPickCard: the shelf row's imageUrl mounts one image with that uri", () => {
  const nodes = render(
    React.createElement(MealPickCard, {
      meal: shelfMeal({ imageUrl: URL }),
      selected: false,
      capMinutes: null,
      onToggle: () => {},
    }),
  );
  const imgs = images(nodes);
  assert.equal(imgs.length, 1);
  assert.deepEqual(imgs[0].props.source, { uri: URL });
  assert.equal(gradients(nodes).length, 1, "the ramp is still painted under the photo");
  assert.ok(wrapWidths(nodes).includes(ImageTreatment.thumb.row), "sized by the row token");
});

test("MealPickCard: a null imageUrl (user-authored meal) mounts the ramp and NO image", () => {
  const nodes = render(
    React.createElement(MealPickCard, {
      meal: shelfMeal({ imageUrl: null }),
      selected: false,
      capMinutes: null,
      onToggle: () => {},
    }),
  );
  assert.equal(images(nodes).length, 0);
  assert.equal(gradients(nodes).length, 1);
});

// ── MealRowBody (Part B — was a raw <Image> over a flat sage square) ─────────

test("MealRowBody: `image` renders through TreatedImage at the row size", () => {
  const nodes = render(
    React.createElement(MealRowBody, { title: { title: "Lemon Herb Salmon" }, meta: "30 min", image: URL }),
  );
  const imgs = images(nodes);
  assert.equal(imgs.length, 1);
  assert.deepEqual(imgs[0].props.source, { uri: URL });
  assert.equal(gradients(nodes).length, 1);
  assert.ok(wrapWidths(nodes).includes(ImageTreatment.thumb.row));
});

test("MealRowBody: null image → the ramp only (the old flat sage square is gone)", () => {
  const nodes = render(
    React.createElement(MealRowBody, { title: { title: "Lemon Herb Salmon" }, meta: "30 min", image: null }),
  );
  assert.equal(images(nodes).length, 0);
  assert.equal(gradients(nodes).length, 1);
});

// ── PlanReviewMealRow (Part B — was a raw <Image>) ──────────────────────────

test("PlanReviewMealRow: thumbnailUrl renders through TreatedImage; absent → ramp only", () => {
  const withUrl = render(
    React.createElement(PlanReviewMealRow, { row: reviewRow({ thumbnailUrl: URL }), planId: "plan-1" }),
  );
  assert.equal(images(withUrl).length, 1);
  assert.deepEqual(images(withUrl)[0].props.source, { uri: URL });
  assert.ok(wrapWidths(withUrl).includes(ImageTreatment.thumb.row));

  const without = render(
    React.createElement(PlanReviewMealRow, { row: reviewRow(), planId: "plan-1" }),
  );
  assert.equal(images(without).length, 0);
  assert.equal(gradients(without).length, 1);
});

// ── DishRow (Part B — dishes have no images today; the slot is ready) ───────

test("DishRow: null image → ramp only at the compact size; a url would mount the image", () => {
  const noop = () => {};
  const without = render(
    React.createElement(DishRow, { dish: dish(), onPress: noop, onCookNow: noop, onAddToMeal: noop }),
  );
  assert.equal(images(without).length, 0);
  assert.equal(gradients(without).length, 1);
  assert.ok(wrapWidths(without).includes(ImageTreatment.thumb.compact));

  const withUrl = render(
    React.createElement(DishRow, { dish: dish({ image: URL }), onPress: noop, onCookNow: noop, onAddToMeal: noop }),
  );
  assert.equal(images(withUrl).length, 1);
  assert.deepEqual(images(withUrl)[0].props.source, { uri: URL });
});
