// WS9-2 2c Commit 7 — the Home "this week" card.
//
// The component had no test file. It is now the most structurally load-bearing
// card on Home: it owns its own actions (the utility button row was removed
// from the screen entirely), and its two states differ in what they render AND
// in how many actions they expose. Both are pinned here.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { ActivePlanStrip, type ActivePlanStripModel } from "../ActivePlanStrip";
import type { MealListItem } from "@/lib/api/meals";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

const MEAL: MealListItem = {
  id: "meal-1",
  title: "Salmon Teriyaki",
  cuisine: "Japanese",
  minutes: 30,
  servings: 4,
  authoredServingsDefault: 4,
  calories: 540,
  protein: 38,
  carbs: 32,
  fat: 24,
  tags: ["seafood"],
  image: null,
};

const TODAY: ActivePlanStripModel = {
  kind: "today",
  planId: "plan-1",
  planItemId: "item-1",
  planName: "Spice It Up",
  meal: MEAL,
};

const PLAN: ActivePlanStripModel = {
  kind: "plan",
  planId: "plan-1",
  name: "Spice It Up",
  durationDays: 5,
};

function render(props: React.ComponentProps<typeof ActivePlanStrip>): Json {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(ActivePlanStrip, props));
  });
  return tree.toJSON() as unknown as Json;
}

function findAll(node: Json | (Json | string)[] | string | null, type: string): Json[] {
  if (!node || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, type));
  const here = node.type === type ? [node] : [];
  return [...here, ...findAll(node.children, type)];
}

function texts(root: Json): string[] {
  return findAll(root, "rn-text")
    .map((n) => (n.children ?? []).filter((c) => typeof c === "string").join(""))
    .filter(Boolean);
}

function pressables(root: Json): Json[] {
  return findAll(root, "rn-pressable");
}

// ── today state ─────────────────────────────────────────────────────────────

test("today: renders the Tonight eyebrow, meal title, meta and plan provenance", () => {
  const t = texts(render({ model: TODAY }));
  assert.ok(t.includes("Tonight"));
  assert.ok(t.includes("Salmon Teriyaki"));
  assert.ok(t.includes("30 min · 540 cal"));
  // The provenance line is what connects tonight's meal to the plan the card's
  // actions operate on — the whole reason the card was rebuilt.
  assert.ok(t.includes("from Spice It Up"));
});

test("today: renders the meal thumbnail (restores the call site Commit 5 removed)", () => {
  const root = render({ model: TODAY });
  // TreatedImage always paints its gradient; with Meal.imageUrl null on
  // 1471/1471 rows that gradient IS what ships today.
  assert.equal(findAll(root, "rn-linear-gradient").length, 1);
  assert.equal(
    findAll(root, "rn-image").length,
    0,
    "no photo exists yet — the gradient fallback is the intended render",
  );
});

test("today: a meal WITH a photo mounts an Image over the gradient", () => {
  const root = render({
    model: { ...TODAY, meal: { ...MEAL, image: "https://example.com/m.jpg" } },
  });
  assert.equal(findAll(root, "rn-linear-gradient").length, 1);
  assert.equal(findAll(root, "rn-image").length, 1);
});

test("today: exposes exactly TWO actions — Start cooking, then View plan", () => {
  const t = texts(render({ model: TODAY }));
  assert.ok(t.includes("Start cooking"));
  assert.ok(t.includes("View plan"));
  assert.equal(
    pressables(render({ model: TODAY })).length,
    2,
    "Grocery list / Prep & Cook are deliberately NOT on this card (2c §7.5)",
  );
});

test("today: Start cooking fires onCook, View plan fires onPress", () => {
  const fired: string[] = [];
  const root = render({
    model: TODAY,
    onCook: () => fired.push("cook"),
    onPress: () => fired.push("plan"),
  });
  const [primary, footer] = pressables(root);

  act(() => {
    (primary.props.onPress as () => void)();
  });
  act(() => {
    (footer.props.onPress as () => void)();
  });

  assert.deepEqual(fired, ["cook", "plan"]);
});

test("today: meta degrades gracefully when minutes/calories are absent", () => {
  const t = texts(
    render({ model: { ...TODAY, meal: { ...MEAL, minutes: 0, calories: 0 } } }),
  );
  assert.ok(t.includes("Salmon Teriyaki"));
  assert.ok(!t.some((s) => s.includes("min ·")));
});

// ── plan state ──────────────────────────────────────────────────────────────

test("plan: renders This week, the plan name, and the nothing-set-today line", () => {
  const t = texts(render({ model: PLAN }));
  assert.ok(t.includes("This week"));
  assert.ok(t.includes("Spice It Up"));
  assert.ok(t.includes("5 days · nothing set for today"));
});

test("plan: renders NO image (D-WS9-144 — only the MEAL thumbnail is the exception)", () => {
  const root = render({ model: PLAN });
  assert.equal(findAll(root, "rn-linear-gradient").length, 0);
  assert.equal(findAll(root, "rn-image").length, 0);
});

test("plan: exposes exactly ONE action, and it is NOT duplicated in a footer", () => {
  const root = render({ model: PLAN });
  const t = texts(root);
  assert.equal(
    t.filter((s) => s === "View plan").length,
    1,
    "a footer View plan under a View plan primary is the same action twice",
  );
  assert.equal(pressables(root).length, 1);
  assert.ok(!t.includes("Start cooking"));
});

test("plan: the single action fires onPress", () => {
  let fired = 0;
  const root = render({ model: PLAN, onPress: () => (fired += 1) });
  act(() => {
    (pressables(root)[0].props.onPress as () => void)();
  });
  assert.equal(fired, 1);
});

test("plan: singular day count reads 'day', not 'days'", () => {
  const t = texts(render({ model: { ...PLAN, durationDays: 1 } }));
  assert.ok(t.includes("1 day · nothing set for today"));
});

test("plan: a null duration still says nothing is set for today", () => {
  const t = texts(render({ model: { ...PLAN, durationDays: null } }));
  assert.ok(t.includes("Nothing set for today"));
});

// ── the §7.5 removal, pinned ────────────────────────────────────────────────

test("NEITHER state offers Grocery list or Prep & Cook", () => {
  for (const model of [TODAY, PLAN]) {
    const t = texts(render({ model }));
    assert.ok(!t.some((s) => /grocery/i.test(s)), `grocery leaked into ${model.kind}`);
    assert.ok(!t.some((s) => /prep/i.test(s)), `prep leaked into ${model.kind}`);
  }
});
