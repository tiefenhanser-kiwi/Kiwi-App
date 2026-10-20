// WS9 D-WS9-058 (BUG-331) — the "Ingredients" heading is a CONTROL.
//
// This file exists because of the bug report. Hans: "there's text 'ingredients'
// which is hard to see just above the 'adjust for servings' function. it is
// supposed to expand, but no-ops when I click now." It never expanded — the
// label has been an inert <Text> since WS5-5F. The one thing that must not
// regress is that it is pressable, and inline on app/meal/[id].tsx that would be
// unguardable (app/** is outside the test glob, D-WS9-164).

import assert from "node:assert/strict";
import { after, test } from "node:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).require = undefined;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { IngredientsSectionHeading } from "../IngredientsSectionHeading";

// ── BUG-452 — it must LOOK tappable ─────────────────────────────────────────

// The Pressable stub keeps a style FUNCTION as-is: resolve it unpressed.
const flat = (style: unknown): Record<string, unknown> =>
  typeof style === "function"
    ? flat((style as (s: { pressed: boolean }) => unknown)({ pressed: false }))
    : Array.isArray(style)
    ? Object.assign({}, ...style.flat(Infinity).filter(Boolean).map((x) => flat(x)))
    : ((style as Record<string, unknown>) ?? {});

test("🔴 BUG-452 — a sage pill, not the serif-italic eyebrow", () => {
  const tree = render(() => {});
  const control = findAll(tree, byTestId("meal-ingredients-heading"))[0];
  const box = flat(control.props?.style);
  assert.equal(box.backgroundColor, "#f1f4ec", "sage[50] surface");
  assert.equal(box.borderColor, "#8fa37e", "sage[400] edge");
  const label = findAll(tree, (n) => n.type === "rn-text")[0];
  const type = flat(label.props?.style);
  assert.equal(type.color, "#3a5235", "sage[700] ink");
  assert.notEqual(type.fontStyle, "italic", "no longer the eyebrow's italic");
  // Still SectionLabel's section spacing.
  assert.equal(box.marginTop, 16);
  assert.equal(box.marginBottom, 10);
});

test("🔴 BUG-452 — the chevron sits beside the word, not stranded at the row's far end", () => {
  const tree = render(() => {});
  const control = findAll(tree, byTestId("meal-ingredients-heading"))[0];
  const box = flat(control.props?.style);
  assert.notEqual(box.justifyContent, "space-between");
  assert.equal(box.alignSelf, "flex-start", "the pill hugs its content");
  const kids = (control.children ?? []).filter((c): c is Node => typeof c !== "string");
  assert.deepEqual(
    kids.map((k) => (typeof k.props?.name === "string" ? k.props.name : k.type)),
    ["list", "rn-text", "chevron-right"],
  );
});

after(() => {
  delete (globalThis as { require?: unknown }).require;
});

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function findAll(node: Node | string | null, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) for (const c of node.children) findAll(c, pred, out);
  return out;
}
function gatherText(node: Node | string | null, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) for (const c of node.children) gatherText(c, out);
  return out;
}

function render(onPress: () => void, label?: string): Node {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(IngredientsSectionHeading, { onPress, ...(label ? { label } : {}) }),
    );
  });
  return tree.toJSON() as unknown as Node;
}

const byTestId = (id: string) => (n: Node) => n.props?.testID === id;

test("🔴 BUG-331 — the heading IS a Pressable, and tapping it fires onPress", () => {
  let taps = 0;
  const tree = render(() => {
    taps += 1;
  });
  const control = findAll(tree, byTestId("meal-ingredients-heading"))[0];
  assert.ok(control, "the heading must carry testID meal-ingredients-heading");
  assert.equal(control.type, "rn-pressable", "it must be a Pressable, not a Text");
  assert.equal(typeof control.props?.onPress, "function");
  act(() => (control.props!.onPress as () => void)());
  assert.equal(taps, 1);
});

test("it announces itself as a button, with a label that says what it opens", () => {
  const control = findAll(render(() => {}), byTestId("meal-ingredients-heading"))[0];
  assert.equal(control.props?.accessibilityRole, "button");
  assert.equal(control.props?.accessibilityLabel, "View all ingredients");
  // A 14px eyebrow is a small target; the hit slop is load-bearing.
  assert.equal(control.props?.hitSlop, 8);
});

test("it renders the word (and a caller's own word)", () => {
  // BUG-452 — no longer through SectionLabel: the eyebrow read as inert text.
  // SectionLabel itself is untouched, so its other ten renders are unchanged.
  assert.ok(gatherText(render(() => {})).includes("Ingredients"));
  assert.ok(gatherText(render(() => {}, "What you need")).includes("What you need"));
});

test("a chevron is the affordance — the only thing that says it opens something", () => {
  const tree = render(() => {});
  const icons = findAll(tree, (n) => typeof n.props?.name === "string");
  assert.ok(
    icons.some((n) => n.props?.name === "chevron-right"),
    "the heading needs a visible affordance; the label alone reads as text",
  );
});
