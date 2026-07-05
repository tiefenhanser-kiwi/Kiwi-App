// BUG-020 (Option B) — ProgressSegments partial-state + back-compat tests.
// The bar is shared with CookSessionView, so the new optional `partialIndices`
// prop MUST be invisible when omitted (byte-identical to the pre-BUG-020 bar).
// Harness mirrors PrepWeekView.test.ts (react-test-renderer + the node:test RN
// stub, whose StyleSheet.create returns raw style objects so styles are readable).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet } from "react-native";

import { ProgressSegments } from "../cooking/ProgressSegments";
import { Colors } from "@/constants/tokens";

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string> | null;
}

// The component root is the segments row; its children are the N segment Views.
// Return each segment's FLATTENED style object.
function segmentStyles(o: {
  segmentCount: number;
  currentIndex: number;
  partialIndices?: number[];
}): Record<string, unknown>[] {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ProgressSegments, o));
  });
  const root = renderer.toJSON() as RenderedNode | null;
  const segs = (root?.children ?? []) as RenderedNode[];
  return segs.map((seg) => StyleSheet.flatten(seg.props?.style as never));
}

test("back-compat: with NO partialIndices, done segments are solid sage with no opacity (unchanged)", () => {
  const styles = segmentStyles({ segmentCount: 4, currentIndex: 2 });
  // 0,1 done → solid sage, opacity untouched
  for (const i of [0, 1]) {
    assert.equal(styles[i].backgroundColor, Colors.sage[600], `seg ${i} should be sage`);
    assert.equal(styles[i].opacity, undefined, `seg ${i} must not carry a partial opacity`);
  }
  // 2 current (terracotta), 3 upcoming (neutral)
  assert.equal(styles[2].backgroundColor, Colors.terracotta[400]);
  assert.equal(styles[3].backgroundColor, Colors.neutral[300]);
});

test("partial: a done-band index in partialIndices renders sage at reduced opacity (~0.45)", () => {
  const styles = segmentStyles({ segmentCount: 4, currentIndex: 2, partialIndices: [1] });
  // seg 0 stays solid sage
  assert.equal(styles[0].backgroundColor, Colors.sage[600]);
  assert.equal(styles[0].opacity, undefined);
  // seg 1 is partial — SAME sage token (no new color), reduced opacity
  assert.equal(styles[1].backgroundColor, Colors.sage[600]);
  assert.equal(styles[1].opacity, 0.45);
  // current / upcoming untouched
  assert.equal(styles[2].backgroundColor, Colors.terracotta[400]);
  assert.equal(styles[3].backgroundColor, Colors.neutral[300]);
});

test("partial: indices at/after currentIndex are ignored (only the done band can go partial)", () => {
  const styles = segmentStyles({ segmentCount: 4, currentIndex: 2, partialIndices: [2, 3] });
  // 2 is the CURRENT segment → terracotta, never partial
  assert.equal(styles[2].backgroundColor, Colors.terracotta[400]);
  assert.equal(styles[2].opacity, undefined);
  // 3 is upcoming → neutral, never partial
  assert.equal(styles[3].backgroundColor, Colors.neutral[300]);
  assert.equal(styles[3].opacity, undefined);
});

test("partial: an empty partialIndices array behaves like the back-compat path", () => {
  const styles = segmentStyles({ segmentCount: 4, currentIndex: 2, partialIndices: [] });
  assert.equal(styles[0].backgroundColor, Colors.sage[600]);
  assert.equal(styles[0].opacity, undefined);
  assert.equal(styles[1].backgroundColor, Colors.sage[600]);
  assert.equal(styles[1].opacity, undefined);
});
