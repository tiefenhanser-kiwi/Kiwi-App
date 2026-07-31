// WS7-5c Block B (mobile) — WizardPlanMealCard render contract tests.
//
// Pins the load-bearing behavior of the Plan Details validation view:
//   - Default state is COLLAPSED — Hans's ruling. A 5-day plan otherwise
//     drops a wall of text on the user before they've decided to keep it.
//     The header (meal title + cuisine / time / servings) is visible;
//     the ingredient list + per-dish macros are NOT.
//   - Tapping the header expands the card → ingredients + per-dish
//     macros render. preparationNote + isOptional are surfaced.
//   - **No steps rendered** anywhere — Plan Details is a validation view,
//     not a cookbook (Block A split steps out of the details payload).
//     A dish whose schema-parsed shape lacks `steps` renders cleanly.
//   - Two cards on the same screen are independent: expanding one
//     doesn't collapse another (matches Hans's "validation" framing
//     where users compare meals side-by-side).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { WizardPlanMealCard } from "../WizardPlanMealCard";
import type { WizardExpandEnrichedMeal } from "@/lib/api/wizard";

// Stepless meal — mirrors the Block A details-stage response shape.
// `steps` is intentionally absent on the dish; the schema now permits it
// (lib/api/wizard.ts) and this card must render fine without it.
const STEPLESS_MEAL: WizardExpandEnrichedMeal = {
  title: "Ribollita",
  cuisineType: "Italian",
  estimatedTimeMinutes: 45,
  difficulty: "medium",
  servings: 4,
  dishes: [
    {
      title: "Ribollita",
      role: "main",
      positionIndex: 0,
      ingredients: [
        { name: "Cannellini beans", quantity: 2, unit: "cups" },
        {
          name: "Tuscan kale",
          quantity: 1,
          unit: "bunch",
          preparationNote: "stems removed",
        },
        {
          name: "Pecorino",
          quantity: 0.25,
          unit: "cup",
          isOptional: true,
        },
      ],
      macros: {
        caloriesPerServing: 420,
        proteinGPerServing: 22,
        carbsGPerServing: 56,
        fatGPerServing: 12,
      },
    },
  ],
};

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

// Render output threads interpolated children as separate string nodes,
// which makes naive `join(" ")` produce double-spaces around numbers
// (e.g. "Day " + "1" + " · " + "Ribollita" → "Day  1  ·  Ribollita").
// Collapse runs of whitespace before substring-matching so assertions
// can read like the rendered copy without spec-of-spec spacing rules.
function flat(node: RenderedNode | null): string {
  return gatherText(node).join(" ").replace(/\s+/g, " ").trim();
}

function findHeaderPressable(tree: RenderedNode | null): RenderedNode | null {
  // The header Pressable is the outer interactive wrapper whose subtree
  // contains the "Day N · <title>" header text and has an onPress prop.
  function walk(node: RenderedNode | string | null): RenderedNode | null {
    if (node == null || typeof node === "string") return null;
    const props = (node.props ?? {}) as { onPress?: unknown };
    if (props.onPress && node.type === "rn-pressable") return node;
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(tree);
}

test("WizardPlanMealCard renders the meal summary in the collapsed (default) state", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(WizardPlanMealCard, {
        meal: STEPLESS_MEAL,
        index: 0,
      }),
    );
  });
  const tree = renderer.toJSON() as RenderedNode | null;
  const texts = flat(tree);

  // Header is visible (collapsed-state summary).
  assert.ok(texts.includes("Day 1 · Ribollita"), `missing header: ${texts}`);
  assert.ok(
    texts.includes("Italian · 45 min · serves 4"),
    `missing meta line: ${texts}`,
  );

  // Body content (ingredients, per-dish macros) is NOT rendered yet.
  assert.ok(
    !texts.includes("Cannellini beans"),
    "ingredients should be hidden when collapsed",
  );
  assert.ok(
    !texts.includes("Ingredients"),
    "ingredients section label should be hidden when collapsed",
  );
  assert.ok(
    !texts.includes("420 cal"),
    "per-dish macros should be hidden when collapsed",
  );
  renderer.unmount();
});

test("WizardPlanMealCard expands on tap: ingredients + per-dish macros render", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(WizardPlanMealCard, {
        meal: STEPLESS_MEAL,
        index: 0,
      }),
    );
  });
  const headerBefore = findHeaderPressable(
    renderer.toJSON() as RenderedNode | null,
  );
  assert.ok(headerBefore, "header Pressable not found");

  await act(async () => {
    (headerBefore!.props!.onPress as () => void)();
  });

  const texts = flat(renderer.toJSON() as RenderedNode | null);
  // Dish details now visible.
  assert.ok(texts.includes("Ingredients"), `missing Ingredients label: ${texts}`);
  assert.ok(
    texts.includes("Cannellini beans"),
    `missing ingredient name: ${texts}`,
  );
  // preparationNote + isOptional surface correctly.
  assert.ok(
    texts.includes("stems removed"),
    `missing preparationNote: ${texts}`,
  );
  assert.ok(texts.includes("(optional)"), `missing isOptional flag: ${texts}`);
  // Per-dish macro line — rendered template is the dominant in-app format
  // "X cal · Yg P · Zg C · Wg F (per serving)" (matches dish/[id].tsx,
  // SwapMealSheet, AddMealsSheet, PlanReviewMealRow).
  // Test tolerates intervening whitespace because our naive child-walker
  // collapses sibling text nodes with spaces — the rendered copy itself
  // has no gap between value and unit.
  assert.match(texts, /420\s*cal/, `missing macros calorie value: ${texts}`);
  assert.match(texts, /22\s*g\s*P/, `missing macros protein value: ${texts}`);
  assert.match(texts, /per serving/, `missing per-serving suffix: ${texts}`);
  renderer.unmount();
});

test("WizardPlanMealCard never renders steps — even if a legacy dish carries them", async () => {
  // Belt-and-suspenders: server strips steps from the details payload,
  // but the schema still permits them (forward-compat). The card must
  // ignore steps either way — Plan Details is not a cookbook.
  const mealWithLegacySteps: WizardExpandEnrichedMeal = {
    ...STEPLESS_MEAL,
    dishes: [
      {
        ...STEPLESS_MEAL.dishes[0],
        steps: ["Saute the soffritto.", "Add stock and simmer."],
      },
    ],
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(WizardPlanMealCard, {
        meal: mealWithLegacySteps,
        index: 0,
        // expand it so we know we're looking at the dish body, not the
        // still-hidden collapsed state.
        initiallyExpanded: true,
      }),
    );
  });
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(
    !texts.includes("Steps"),
    `Steps label should not render: ${texts}`,
  );
  assert.ok(
    !texts.includes("Saute the soffritto"),
    `legacy step text should not render: ${texts}`,
  );
  // Confirm we ARE in the expanded path (sanity).
  assert.ok(texts.includes("Cannellini beans"), "expected ingredients visible");
  renderer.unmount();
});

test("WizardPlanMealCard handles a dish with no `steps` field without throwing", async () => {
  // Direct mirror of the Block A details-stage payload: `steps` truly
  // absent from the dish object. Render path must not crash.
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(WizardPlanMealCard, {
        meal: STEPLESS_MEAL,
        index: 0,
        initiallyExpanded: true,
      }),
    );
  });
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Cannellini beans"));
  assert.ok(!texts.includes("Steps"));
  renderer.unmount();
});

test("WizardPlanMealCard cards are independent: tapping one does not affect another", async () => {
  // Two cards rendered as siblings; each owns its own expanded state.
  // Pins the "compare two meals side-by-side" framing — closing one
  // must NOT collapse another the user already opened.
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        "rn-view",
        null,
        React.createElement(WizardPlanMealCard, {
          key: "a",
          meal: { ...STEPLESS_MEAL, title: "Meal A" },
          index: 0,
        }),
        React.createElement(WizardPlanMealCard, {
          key: "b",
          meal: { ...STEPLESS_MEAL, title: "Meal B" },
          index: 1,
        }),
      ),
    );
  });

  // Open the first card.
  const tree = renderer.toJSON() as RenderedNode | null;
  function findPressableByHeaderText(
    node: RenderedNode | string | null,
    header: string,
  ): RenderedNode | null {
    if (node == null || typeof node === "string") return null;
    const props = (node.props ?? {}) as { onPress?: unknown };
    if (props.onPress && node.type === "rn-pressable") {
      if (gatherText(node).some((t) => t.includes(header))) return node;
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const hit = findPressableByHeaderText(c, header);
        if (hit) return hit;
      }
    }
    return null;
  }
  const a = findPressableByHeaderText(tree, "Meal A");
  assert.ok(a, "Meal A header not found");
  await act(async () => {
    (a!.props!.onPress as () => void)();
  });

  // Meal A is expanded; Meal B is still collapsed. The ingredient string
  // "Cannellini beans" should appear exactly once.
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  const occurrences = texts.split("Cannellini beans").length - 1;
  assert.equal(
    occurrences,
    1,
    `expected ingredients visible only under Meal A, saw ${occurrences} occurrence(s)`,
  );
  renderer.unmount();
});
