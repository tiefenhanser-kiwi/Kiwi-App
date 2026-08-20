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
import { Colors } from "@/constants/tokens";

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
// ⚠️ WS9-2 2e Part 4 Item 3 — they CHANGED AGAIN, and this time the RULING
// under them moved, not just the markup. The stacked full-width buttons are
// gone (the filled "Start cooking", the full-bleed "View plan" footer, and the
// plan state's outlined "View plan" primary) and both states now render one 2×2
// action panel. So "exactly two labelled actions" is no longer the contract.
//
// What replaces it is STRICTER, not looser:
//   • the exact cell roster is pinned, by name, on both states;
//   • "View plan" must appear EXACTLY ONCE — which is the same duplication the
//     original test forbade, now enforced against the panel instead of a footer;
//   • every cell must fire its OWN handler and no other.

/** Press targets keyed by accessibilityLabel, so no test depends on order. */
function pressableByLabel(root: Json, label: string): Json | undefined {
  return pressables(root).find((p) => p.props.accessibilityLabel === label);
}

/** A panel cell located by its rendered label. */
function cell(root: Json, label: string): Json | undefined {
  return pressables(root).find((p) => texts(p).join("") === label);
}

/** The four cell labels, in render order. */
function cellLabels(root: Json): string[] {
  const wanted = new Set([
    "Start Cooking",
    "Prep and Cook",
    "Grocery List",
    "Order Online",
    "View plan",
  ]);
  return pressables(root)
    .map((p) => texts(p).join(""))
    .filter((s) => wanted.has(s));
}

// ⚠️ Part 4 fix pass Item 1 — the today roster SHRANK to two, and these
// assertions move with it. Not a relaxation: the roster is still pinned by name
// AND order, and two new tests below pin the absences explicitly, which the old
// four-cell assertion could not have expressed.
test("today: the panel is exactly TWO cells — Start Cooking · View plan", () => {
  const root = render({ model: TODAY });
  assert.deepEqual(cellLabels(root), ["Start Cooking", "View plan"]);
  assert.equal(
    pressables(root).length,
    3,
    "two panel cells + the BUG-091 meal-block tap target",
  );
});

test("today: the PLAN-SCOPED cells are absent — they would read as meal-scoped", () => {
  // "Order Online" beside tonight's dinner suggests ordering tonight's dinner.
  // Both actions stay one tap away behind "View plan"; neither belongs on a
  // card whose identity block is a single meal.
  const t = texts(render({ model: TODAY }));
  assert.ok(!t.includes("Grocery List"), "Grocery List is plan-scoped");
  assert.ok(!t.includes("Order Online"), "Order Online is plan-scoped");
});

test("Item 1: the two branches are ASYMMETRIC, and that is the contract", () => {
  // The cards differ in height by a whole panel row. If some later change
  // "re-balances" them — a filler cell, a spacer, restoring the two cells —
  // this is what should stop it.
  assert.equal(cellLabels(render({ model: TODAY })).length, 2);
  assert.equal(cellLabels(render({ model: PLAN })).length, 4);
});

test("today: the stacked full-width buttons are GONE, and View plan is not doubled", () => {
  // The card used to carry a filled "Start cooking" AND a full-bleed "View
  // plan" footer. Both are superseded by the panel. Rendering the footer
  // alongside the panel's own "View plan" cell would put the same action on the
  // card twice — the exact defect the pre-Part-4 version of this test guarded.
  const t = texts(render({ model: TODAY }));
  assert.equal(
    t.filter((s) => s === "View plan").length,
    1,
    "a footer View plan under a panel View plan is the same action twice",
  );
  assert.ok(
    !t.includes("Start cooking"),
    "the old full-width button's label is gone; the cell reads 'Start Cooking'",
  );
});

test("today: every cell fires its OWN handler and no other", () => {
  const fired: string[] = [];
  const root = render({
    model: TODAY,
    onCook: () => fired.push("cook"),
    onPress: () => fired.push("plan"),
    // ⚠️ Still WIRED here even though branch A renders no cell for them. Home
    // cannot know which branch it is feeding, so it passes one prop set for
    // both; nothing on this branch may reach them.
    onGroceryList: () => fired.push("grocery"),
    onOrderOnline: () => fired.push("order"),
    onOpenMeal: () => fired.push("meal"),
  });
  for (const label of ["Start Cooking", "View plan"]) {
    const c = cell(root, label);
    assert.ok(c, `cell not found: ${label}`);
    act(() => {
      (c!.props.onPress as () => void)();
    });
  }
  assert.deepEqual(
    fired,
    ["cook", "plan"],
    "no cell fires the meal tap, a neighbour's handler, or a plan-scoped one",
  );
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

test("BUG-091: the meal tap target does NOT contain any panel cell", () => {
  // Structural guarantee rather than a bet on how RN resolves nested press
  // responders: if a cell ever became a DESCENDANT of the body target, whether
  // it still fires depends on gesture bubbling. Cells must be siblings.
  const root = render({ model: TODAY });
  const target = pressableByLabel(root, "Open Salmon Teriyaki");
  assert.ok(target);
  const inner = texts(target!);
  for (const label of [
    "Start Cooking",
    "Grocery List",
    "Order Online",
    "View plan",
  ]) {
    assert.ok(
      !inner.includes(label),
      `${label} must be a SIBLING of the tap target, not inside it`,
    );
  }
  // It does carry the meal identity — that is the region a user aims at.
  assert.ok(inner.includes("Salmon Teriyaki"));
  assert.ok(inner.includes("Tonight"));
});

// ⚠️ WS9-2 2e Part 4 Item 3 — THIS TEST IS INVERTED, DELIBERATELY.
//
// It used to assert that the PLAN state has NO body tap. That was the correct
// reading of BUG-091 at the time: the destination considered was a MEAL detail,
// this state has no meal, and a body tap would have duplicated the full-width
// "View plan" primary sitting directly beneath it.
//
// Both halves of that reasoning are gone. The destination is Plan Review, not a
// meal, and `planId` has always been plumbed on this branch. The full-width
// primary it would have duplicated has been superseded by the panel. What was
// left on device was a named plan that did nothing when you touched it — the
// same dead-card defect BUG-091 was raised for, on the other branch.
//
// The assertion is rewritten to pin the new intent, not deleted.
test("BUG-091 (second half): the PLAN state's body IS a tap target, to Plan Review", () => {
  let fired = 0;
  const root = render({ model: PLAN, onPress: () => (fired += 1) });
  const target = pressableByLabel(root, "Open Spice It Up");
  assert.ok(target, "plan-state body tap target not found");
  act(() => {
    (target!.props.onPress as () => void)();
  });
  assert.equal(fired, 1, "the body tap routes through onPress → Plan Review");
});

test("BUG-091 (second half): the plan body tap does NOT contain any panel cell", () => {
  // Same structural guarantee as the today state's — siblings, not descendants.
  const root = render({ model: PLAN });
  const target = pressableByLabel(root, "Open Spice It Up");
  assert.ok(target);
  const inner = texts(target!);
  for (const label of [
    "Prep and Cook",
    "Grocery List",
    "Order Online",
    "View plan",
  ]) {
    assert.ok(
      !inner.includes(label),
      `${label} must be a SIBLING of the tap target, not inside it`,
    );
  }
  assert.ok(inner.includes("Spice It Up"));
  assert.ok(inner.includes("This week"));
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

test("plan: the panel is Prep and Cook · Grocery List · Order Online · View plan", () => {
  const root = render({ model: PLAN });
  assert.deepEqual(cellLabels(root), [
    "Prep and Cook",
    "Grocery List",
    "Order Online",
    "View plan",
  ]);
  assert.equal(
    pressables(root).length,
    5,
    "four panel cells + the plan-body tap target",
  );
});

test("plan: View plan is NOT duplicated — the panel superseded the primary", () => {
  // The plan state's whole primary button WAS "View plan". Keeping it beside
  // the panel's own "View plan" cell would be the same action twice, which is
  // what this test has forbidden since 2c Commit 7.
  const t = texts(render({ model: PLAN }));
  assert.equal(t.filter((s) => s === "View plan").length, 1);
  assert.ok(!t.includes("Start cooking"), "the old label is gone entirely");
  assert.ok(
    !t.includes("Start Cooking"),
    "Start Cooking is the TODAY state's contextual cell — it must not leak here",
  );
});

test("plan: every cell fires its OWN handler and no other", () => {
  const fired: string[] = [];
  const root = render({
    model: PLAN,
    onPress: () => fired.push("plan"),
    onPrepAndCook: () => fired.push("prep"),
    onGroceryList: () => fired.push("grocery"),
    onOrderOnline: () => fired.push("order"),
    onCook: () => fired.push("cook"),
  });
  for (const label of [
    "Prep and Cook",
    "Grocery List",
    "Order Online",
    "View plan",
  ]) {
    const c = cell(root, label);
    assert.ok(c, `cell not found: ${label}`);
    act(() => {
      (c!.props.onPress as () => void)();
    });
  }
  assert.deepEqual(
    fired,
    ["prep", "grocery", "order", "plan"],
    "onCook belongs to the today state and must not be reachable here",
  );
});

test("plan: singular day count reads 'day', not 'days'", () => {
  const t = texts(render({ model: { ...PLAN, durationDays: 1 } }));
  assert.ok(t.includes("1 day · nothing set for today"));
});

test("plan: a null duration still says nothing is set for today", () => {
  const t = texts(render({ model: { ...PLAN, durationDays: null } }));
  assert.ok(t.includes("Nothing set for today"));
});

// ── §7.5 is REVERSED — Part 4 Item 3 ────────────────────────────────────────
//
// ⚠️ THIS TEST IS INVERTED, DELIBERATELY. It used to assert that NEITHER state
// offers Grocery list or Prep & Cook, pinning 2c Commit 7 §7.5.
//
// §7.5's reasoning was that on the today state Grocery list is a plan-level
// action and Prep & Cook duplicated Start cooking's intent — sound while the
// two were loose buttons in a row that pointed at nothing in particular. The
// card is now explicitly a PANEL FOR THE PLAN, so plan-level actions are
// exactly what belongs on it, and Prep & Cook is no longer a sibling competing
// with Start Cooking: they are the SAME SLOT on two different states, never
// rendered together.
//
// Kept as a test rather than deleted because the roster is now a contract in
// its own right — a fifth cell, or a missing one, is a regression either way.

// ⚠️ Part 4 fix pass Item 1 — NARROWED FROM "BOTH states" TO THE PLAN STATE.
// §7.5's reversal still stands (these actions ARE back on Home), but only where
// they are in scope. The today state's absences are pinned by their own test
// above, so nothing that this used to guard has gone unguarded.
test("Part 4 Item 3: the PLAN state carries the plan-scoped cells", () => {
  const t = texts(render({ model: PLAN }));
  assert.ok(t.includes("Grocery List"), "Grocery List missing from plan");
  assert.ok(t.includes("Order Online"), "Order Online missing from plan");
});

test("Part 4 Item 3: the FIRST cell is contextual, and the two labels never co-occur", () => {
  // Same slot, same tint, same glyph; the label and destination switch by
  // branch. Rendering both would mean the card was offering two cook entries.
  const today = texts(render({ model: TODAY }));
  assert.ok(today.includes("Start Cooking"));
  assert.ok(!today.includes("Prep and Cook"));

  const plan = texts(render({ model: PLAN }));
  assert.ok(plan.includes("Prep and Cook"));
  assert.ok(!plan.includes("Start Cooking"));
});

test("Part 4 Item 3: NOTHING on this card is a terracotta FILL", () => {
  // Home's only terracotta fill is the Tell Kiwi send button. The panel's
  // primary is a TINT — pale surface, full-strength edge, dark ink. If it ever
  // resolves back to variant="primary", the card regains a fill and Home has
  // two, which is the whole distinction Part 4 Item 2 established.
  for (const model of [TODAY, PLAN]) {
    const filled = findAll(render({ model }), "rn-pressable").filter((n) => {
      const raw = n.props.style;
      const resolved =
        typeof raw === "function"
          ? (raw as (s: { pressed: boolean }) => unknown)({ pressed: false })
          : raw;
      const flat = Object.assign(
        {},
        ...(Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean),
      ) as Record<string, unknown>;
      return flat.backgroundColor === Colors.terracotta[400];
    });
    assert.deepEqual(
      filled,
      [],
      `a terracotta fill leaked onto the ${model.kind} state`,
    );
  }
});

test("Part 4 Item 3: the Grocery List cell shows a busy state and blocks re-taps", () => {
  // Generation is the two-AI-call pipeline and takes 5–15s. Without a busy
  // state the tap is silent for up to fifteen seconds and reads as broken.
  //
  // ⚠️ The busy state is a SPINNER, not a swapped label: Button renders either
  // the ActivityIndicator or the icon+label, never both. A test written against
  // a "Generating…" string would pass only by accident of never running.
  //
  // ⚠️ Part 4 fix pass — PLAN STATE ONLY. Branch A has no grocery cell to be
  // busy; that half moved to the test below.
  const idle = render({ model: PLAN });
  assert.equal(findAll(idle, "rn-activity-indicator").length, 0);
  assert.ok(texts(idle).includes("Grocery List"));

  const busy = render({ model: PLAN, groceryLoading: true });
  assert.equal(
    findAll(busy, "rn-activity-indicator").length,
    1,
    "no busy state on the plan state's grocery cell",
  );
  assert.ok(
    !texts(busy).includes("Grocery List"),
    "the spinner replaces the label rather than sitting beside it",
  );
  // The same flag disables the press, which is what guards the double-tap.
  const c = pressables(busy).find(
    (p) => findAll(p, "rn-activity-indicator").length === 1,
  );
  assert.ok(c, "busy cell not found");
  assert.equal(c!.props.disabled, true);
});

test("Item 1: groceryLoading is INERT on the today state, not orphaned", () => {
  // Home passes one prop set and the model picks the branch, so this flag is
  // wired on both and consumed by one. It must not paint a spinner onto a
  // branch that has no grocery cell — and it must not disable Start Cooking.
  const busy = render({ model: TODAY, groceryLoading: true });
  assert.equal(
    findAll(busy, "rn-activity-indicator").length,
    0,
    "branch A has no cell for this flag to make busy",
  );
  assert.deepEqual(cellLabels(busy), ["Start Cooking", "View plan"]);
  for (const p of pressables(busy)) {
    assert.notEqual(
      p.props.disabled,
      true,
      "a plan-scoped busy flag must not disable a meal-scoped cell",
    );
  }
});
