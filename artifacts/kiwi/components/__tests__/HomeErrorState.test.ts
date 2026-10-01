// Sept 29 design review, item 14 — the Home error card.
//
// The DECISION (error ≠ empty, error is exclusive, a hang lands here) is pinned in
// lib/home/__tests__/homeSections.test.ts. This file pins the two things that
// live in the component: Hans's copy, and that the retry actually fires.
//
// ⚠️ WHY THE COPY IS TESTED AT ALL. The three strings are a ruling, quoted
// verbatim, and the component only exists in components/ rather than inline in
// app/(tabs)/index.tsx because app/** is outside the test glob — the
// IngredientsSectionHeading precedent, where a deliberate break inside app/**
// stayed green. Asserting the exported constant against itself would be the
// tautology this repo has already shipped once, so the assertions here compare
// the RENDERED text against hard-coded literals.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { HomeErrorState } from "../HomeErrorState";

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function gatherText(node: RenderedNode | string | null | undefined, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) for (const c of node.children) gatherText(c, out);
  return out;
}

const flat = (n: RenderedNode | null) => gatherText(n).join(" ").replace(/\s+/g, " ").trim();

function findByTestId(node: RenderedNode | string | null, id: string): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  if ((node.props as { testID?: unknown } | undefined)?.testID === id) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findByTestId(c, id);
      if (hit) return hit;
    }
  }
  return null;
}

function render(props: Parameters<typeof HomeErrorState>[0]) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(HomeErrorState, props));
  });
  return tree;
}

test("item 14: the card carries Hans's copy, verbatim", () => {
  const texts = flat(render({ onRetry: () => {} }).toJSON() as RenderedNode | null);
  // Hard-coded literals, NOT the exported constants — an assertion against the
  // constant the component reads would pass against any rewording.
  assert.ok(texts.includes("We couldn't reach Kiwi"), `title missing: ${texts}`);
  assert.ok(
    texts.includes("Check your connection and try again."),
    `body missing: ${texts}`,
  );
  assert.ok(texts.includes("Try again"), `retry label missing: ${texts}`);
});

test("item 14: it says nothing about the user having no plan", () => {
  // The defect was an errored Home implying "you have no plan this week". The
  // replacement must not reintroduce that claim in words either.
  const texts = flat(render({ onRetry: () => {} }).toJSON() as RenderedNode | null).toLowerCase();
  for (const forbidden of ["no plan", "get started", "create", "this week"]) {
    assert.ok(
      !texts.includes(forbidden),
      `an error card must not say "${forbidden}" — that is the empty state's job`,
    );
  }
});

test("item 14: the title is announced as an alert, not merely drawn", () => {
  const tree = render({ onRetry: () => {} }).toJSON() as RenderedNode | null;
  const hasAlert = (node: RenderedNode | string | null): boolean => {
    if (node == null || typeof node === "string") return false;
    if ((node.props as { accessibilityRole?: unknown } | undefined)?.accessibilityRole === "alert")
      return true;
    return Array.isArray(node.children) ? node.children.some(hasAlert) : false;
  };
  assert.ok(hasAlert(tree), "the failure must be announced (item 7's reasoning)");
});

test("item 14: Try again fires onRetry", () => {
  let fired = 0;
  const tree = render({ onRetry: () => void fired++ });
  const btn = findByTestId(tree.toJSON() as RenderedNode | null, "home-error-retry");
  assert.ok(btn, "retry button missing");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(fired, 1);
});

test("item 14: a refetch in flight announces the label it cannot show", () => {
  // Button swaps its <Text> for a spinner while `loading`, so without item 5's
  // accessibilityLabel default the control would announce nothing at exactly the
  // moment the user is waiting on it.
  const tree = render({ onRetry: () => {}, retrying: true });
  const btn = findByTestId(tree.toJSON() as RenderedNode | null, "home-error-retry");
  assert.ok(btn, "retry button missing while retrying");
  const props = btn!.props as { accessibilityLabel?: unknown; accessibilityState?: unknown };
  assert.equal(props.accessibilityLabel, "Try again");
  assert.deepEqual(props.accessibilityState, { disabled: true, busy: true });
  // And the visible label is genuinely gone — otherwise this test proves nothing.
  assert.ok(
    !flat(tree.toJSON() as RenderedNode | null).includes("Try again"),
    "the spinner should have replaced the label (which is why the a11y label matters)",
  );
});
