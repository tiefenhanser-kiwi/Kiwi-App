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

// ⚠️ WS9-2 2e (BUG-091) — these two tests CHANGED. The card gained a third
// press target: the meal block itself, which was dead before. The old
// assertions counted pressables (2) and destructured them positionally
// ([primary, footer]) — both of which a new target invalidates.
//
// They are updated by naming what each target IS, not by relaxing the count.
// The LABELLED-action count is still asserted at two, so the thing the original
// test protected — Grocery list / Prep & Cook must not creep back onto this
// card (2c §7.5) — is still protected, and now cannot be satisfied by an
// unlabelled target sneaking in either.

/** Press targets keyed by accessibilityLabel, so no test depends on order. */
function pressableByLabel(root: Json, label: string): Json | undefined {
  return pressables(root).find((p) => p.props.accessibilityLabel === label);
}

test("today: exposes exactly TWO labelled actions — Start cooking, then View plan", () => {
  const root = render({ model: TODAY });
  const t = texts(root);
  assert.ok(t.includes("Start cooking"));
  assert.ok(t.includes("View plan"));
  // Exactly two targets carry an action LABEL; the third is the meal block.
  const labelled = pressables(root).filter((p) =>
    ["Start cooking", "View plan"].includes(texts(p).join("")),
  );
  assert.equal(
    labelled.length,
    2,
    "Grocery list / Prep & Cook are deliberately NOT on this card (2c §7.5)",
  );
  assert.equal(
    pressables(root).length,
    3,
    "two labelled actions + the BUG-091 meal-block tap target",
  );
});

test("today: Start cooking fires onCook, View plan fires onPress", () => {
  const fired: string[] = [];
  const root = render({
    model: TODAY,
    onCook: () => fired.push("cook"),
    onPress: () => fired.push("plan"),
    onOpenMeal: () => fired.push("meal"),
  });
  // Located by their text, NOT by position — adding the meal target shifted the
  // indices the old destructure relied on.
  const primary = pressables(root).find(
    (p) => texts(p).join("") === "Start cooking",
  );
  const footer = pressables(root).find(
    (p) => texts(p).join("") === "View plan",
  );
  assert.ok(primary && footer, "both labelled actions found");

  act(() => {
    (primary!.props.onPress as () => void)();
  });
  act(() => {
    (footer!.props.onPress as () => void)();
  });

  assert.deepEqual(fired, ["cook", "plan"], "neither fires the meal tap");
});

// ── BUG-091: the card body opens the plan-instance meal detail ──────────────

test("BUG-091: the meal block is a press target and fires onOpenMeal", () => {
  // Before this, the card rendered two working buttons and a dead body — a card
  // that looks like a meal and does nothing when you tap the meal.
  let fired = 0;
  const root = render({ model: TODAY, onOpenMeal: () => (fired += 1) });
  const target = pressableByLabel(root, "Open Salmon Teriyaki");
  assert.ok(target, "meal-block tap target not found");
  act(() => {
    (target!.props.onPress as () => void)();
  });
  assert.equal(fired, 1);
});

test("BUG-091: the meal tap target does NOT contain the other two actions", () => {
  // Structural guarantee rather than a bet on how RN resolves nested press
  // responders: if "Start cooking" ever became a DESCENDANT of the body target,
  // whether it still fires depends on gesture bubbling. It must be a sibling.
  const root = render({ model: TODAY });
  const target = pressableByLabel(root, "Open Salmon Teriyaki");
  assert.ok(target);
  const inner = texts(target!);
  assert.ok(
    !inner.includes("Start cooking"),
    "Start cooking must be a SIBLING of the tap target, not inside it",
  );
  assert.ok(
    !inner.includes("View plan"),
    "View plan must be a SIBLING of the tap target, not inside it",
  );
  // It does carry the meal identity — that is the region a user aims at.
  assert.ok(inner.includes("Salmon Teriyaki"));
  assert.ok(inner.includes("Tonight"));
});

test("BUG-091: the PLAN state gets no body tap — it has no meal to open", () => {
  // Its whole surface would otherwise duplicate its single "View plan" action.
  const root = render({ model: PLAN, onOpenMeal: () => {} });
  assert.equal(
    pressables(root).length,
    1,
    "plan state keeps exactly its one action",
  );
  assert.equal(
    pressables(root)[0].props.accessibilityLabel,
    undefined,
    "and it is not the meal tap target",
  );
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
