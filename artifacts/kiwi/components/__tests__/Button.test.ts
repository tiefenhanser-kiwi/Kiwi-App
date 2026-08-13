// WS9-2 2e Phase 1 (D-WS9-157) — Button `size`.
//
// This primitive had NO test file despite being the app's single button and
// having just grown a new prop. The prop's whole contract is "`md` is what
// every existing caller already got", so that equivalence is what this file
// pins: if a future edit retunes `md`, it silently moves pixels on every
// button in the app, and only a test that compares md-vs-no-prop catches it.
//
// The react-native stub passes `style` through verbatim, and Button hands
// Pressable a FUNCTION of ({ pressed }) — so the tests invoke it rather than
// reading a static object.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { Button } from "../Button";
import { Radius, Spacing, Typography } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function render(props: React.ComponentProps<typeof Button>): Json {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Button, props));
  });
  return tree.toJSON() as unknown as Json;
}

function flatten(style: unknown): Record<string, unknown> {
  const parts = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...parts.filter(Boolean));
}

/** The Pressable's resolved (unpressed) style. */
function rootStyle(node: Json): Record<string, unknown> {
  const s = node.props.style as (a: { pressed: boolean }) => unknown;
  assert.equal(typeof s, "function", "Button hands Pressable a style function");
  return flatten(s({ pressed: false }));
}

/** The label <Text>'s flattened style. */
function labelStyle(node: Json): Record<string, unknown> {
  function find(n: Json | string | null): Json | null {
    if (n == null || typeof n === "string") return null;
    if (n.type === "rn-text") return n;
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        const hit = find(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  const text = find(node);
  assert.ok(text, "label Text node found");
  return flatten(text!.props.style);
}

// ── the default must not have moved ─────────────────────────────────────────

test("size defaults to md, and md reproduces the pre-2e values exactly", () => {
  const s = rootStyle(render({ label: "Prep and Cook" }));
  assert.equal(s.paddingVertical, 14);
  assert.equal(s.paddingHorizontal, Spacing[4]); // 16
  assert.equal(labelStyle(render({ label: "Prep and Cook" })).fontSize, Typography.fontSize.lg); // 17
});

test("omitting `size` and passing size='md' are identical — every existing consumer is unchanged", () => {
  const implicit = render({ label: "Grocery List" });
  const explicit = render({ label: "Grocery List", size: "md" });
  assert.deepEqual(rootStyle(implicit), rootStyle(explicit));
  assert.deepEqual(labelStyle(implicit), labelStyle(explicit));
});

test("the variant palettes are untouched by the size prop", () => {
  // A size change must not reach colour. primary stays filled-with-no-border;
  // ghost keeps its 1px border at either size.
  for (const size of ["md", "sm"] as const) {
    const primary = rootStyle(render({ label: "x", variant: "primary", size }));
    assert.equal(primary.borderWidth, 0);
    const ghost = rootStyle(render({ label: "x", variant: "ghost", size }));
    assert.equal(ghost.borderWidth, 1);
  }
});

// ── sm ──────────────────────────────────────────────────────────────────────

test("size='sm' is smaller on BOTH axes — height and type", () => {
  const md = render({ label: "Compost", size: "md" });
  const sm = render({ label: "Compost", size: "sm" });

  assert.ok(
    (rootStyle(sm).paddingVertical as number) < (rootStyle(md).paddingVertical as number),
    "sm must be shorter",
  );
  assert.ok(
    (rootStyle(sm).paddingHorizontal as number) <
      (rootStyle(md).paddingHorizontal as number),
    "sm must be narrower",
  );
  assert.ok(
    (labelStyle(sm).fontSize as number) < (labelStyle(md).fontSize as number),
    "sm must carry smaller type — a shorter button with 17px text is not 'visually smaller'",
  );
});

test("sm is the SAME button at lower volume — radius, weight and face are shared", () => {
  const md = render({ label: "Compost", size: "md" });
  const sm = render({ label: "Compost", size: "sm" });

  assert.equal(rootStyle(sm).borderRadius, Radius.lg);
  assert.equal(rootStyle(md).borderRadius, Radius.lg);
  assert.equal(labelStyle(sm).fontWeight, labelStyle(md).fontWeight);
  assert.equal(labelStyle(sm).fontFamily, labelStyle(md).fontFamily);
  assert.equal(labelStyle(sm).fontFamily, Typography.face.sans[600]);
});

test("a caller `style` still wins over the size metrics", () => {
  const s = rootStyle(render({ label: "x", size: "sm", style: { paddingVertical: 40 } }));
  assert.equal(s.paddingVertical, 40);
});
