// WS9-2 2c Commit 4 — SectionLabel.
//
// This primitive had NO test file despite being SHARED across 11 renders in 5
// files (3 on Home, 8 on dish detail / meal detail / meal-builder). The 2c
// restyle — left-aligned, high-emphasis, em-dashes dropped — reflows all 11, so
// the treatment is pinned here rather than left to a device eyeball.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { SectionLabel } from "../SectionLabel";
import { Colors, Components } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function render(props: React.ComponentProps<typeof SectionLabel>): Json {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(SectionLabel, props));
  });
  return tree.toJSON() as unknown as Json;
}

function flatStyle(node: Json): Record<string, unknown> {
  const s = node.props.style;
  const parts = Array.isArray(s) ? s : [s];
  return Object.assign({}, ...parts.filter(Boolean));
}

// ── content ─────────────────────────────────────────────────────────────────

test("renders the bare label — NO em-dash decoration", () => {
  const node = render({ label: "this week" });
  assert.deepEqual(node.children, ["this week"]);
});

test("the label is not wrapped, padded or re-cased", () => {
  // Guards against a future 'helpful' transform (uppercase, trailing colon).
  const node = render({ label: "what do you want to eat?" });
  assert.deepEqual(node.children, ["what do you want to eat?"]);
});

test("the dash token is gone from the design system entirely", () => {
  // SectionLabel was its only reader; leaving it would be dead weight.
  assert.equal(
    (Components.sectionLabel as Record<string, unknown>).dash,
    undefined,
  );
});

// ── treatment ───────────────────────────────────────────────────────────────

test("left-aligned, not centered", () => {
  assert.equal(flatStyle(render({ label: "Featured plans" })).textAlign, "left");
});

test("high-emphasis colour, not the muted caption value", () => {
  const style = flatStyle(render({ label: "this week" }));
  assert.equal(style.color, Colors.neutral[800]);
  assert.notEqual(
    style.color,
    Colors.neutral[600],
    "neutral[600] is the LOCKED muted-text role — wrong role for a section heading",
  );
});

test("no horizontal inset — a left-aligned eyebrow sits flush with the cards below", () => {
  assert.equal(
    flatStyle(render({ label: "this week" })).marginHorizontal,
    undefined,
  );
});

// ── margins: the single-owner contract (§4.3) ───────────────────────────────

test("owns the inter-section gap: 16 top / 10 bottom", () => {
  const style = flatStyle(render({ label: "plan something new" }));
  assert.equal(style.marginTop, 16);
  assert.equal(style.marginBottom, 10);
});

test("`first` tightens the top margin for a leading label", () => {
  assert.equal(flatStyle(render({ label: "this week", first: true })).marginTop, 4);
});

// ── props ───────────────────────────────────────────────────────────────────

test("`cook` swaps to the terracotta cook tint", () => {
  const style = flatStyle(render({ label: "tonight", cook: true }));
  assert.equal(style.color, Components.sectionLabel.cookColor);
});

test("a caller `style` wins — this is how TeachingArc re-centers in-card", () => {
  // TeachingArc overrides BOTH margins and (2c) textAlign. If caller style ever
  // stopped winning, the arc's in-card label would silently adopt the scroll
  // rhythm and go left-aligned inside a centered card.
  const style = flatStyle(
    render({
      label: "kitchen made easy",
      style: { marginTop: 0, marginBottom: 8, textAlign: "center" },
    }),
  );
  assert.equal(style.textAlign, "center");
  assert.equal(style.marginTop, 0);
  assert.equal(style.marginBottom, 8);
});
