// WS9 D-WS9-208 — the filter chip's selected green.
//
// Hans, Sept 4: "I like the other sage used in onboarding and preferences
// better." This row painted a selected chip sage[700] #3a5235 while every
// preference chip (Palette.chip.selected, via <Chip>) painted sage[600]
// #5C7350. Two greens for one idea — "this filter is on" and "this preference
// is on" are the same state.
//
// This file is net-new: FilterChipRow had no test at all, so the value it
// carries could drift back with nothing noticing — which is precisely how it
// came to differ from the preference chips in the first place.
//
// The assertion reads the RENDERED fill off the selected chip and compares it
// to the value Palette.chip.selected independently resolves to, so it fails
// both if the row's local style moves and if the row stops agreeing with the
// shared chip token. It is not a hex restated against itself: the hex literal
// is written out once as an anchor, and the two live values are checked
// against it and against each other.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  FilterChipRow,
  PLAN_DISCOVERY_FILTER_OPTIONS,
} from "../FilterChipRow";
import { Colors, Palette } from "@/constants/tokens";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function gatherText(node: Node | string | null, out: string[] = []): string[] {
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

function resolvedStyle(node: Node): Record<string, unknown> {
  const raw = (node.props ?? {}).style;
  const out =
    typeof raw === "function"
      ? (raw as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return Object.assign(
    {},
    ...[out].flat(Infinity).filter((x) => x && typeof x === "object"),
  ) as Record<string, unknown>;
}

function findPressableByText(node: Node | string | null, text: string): Node | null {
  if (node == null || typeof node === "string") return null;
  if ((node.props ?? {}).onPress && gatherText(node).join(" ").includes(text)) {
    return node;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findPressableByText(c, text);
      if (hit) return hit;
    }
  }
  return null;
}

function render(selected: string[]) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(FilterChipRow, {
        options: PLAN_DISCOVERY_FILTER_OPTIONS,
        selected: selected as never,
        onToggle: () => {},
      }),
    );
  });
  return tree;
}

const MY_PLANS = PLAN_DISCOVERY_FILTER_OPTIONS[0];
const FEATURED = PLAN_DISCOVERY_FILTER_OPTIONS[1];

test("D-WS9-208: a SELECTED filter chip paints sage[600], the preference-chip green", () => {
  const tree = render([MY_PLANS.key]);
  const chip = findPressableByText(
    tree.toJSON() as unknown as Node,
    MY_PLANS.label,
  );
  assert.ok(chip, "the selected chip renders");
  const style = resolvedStyle(chip!);

  // The live rendered fill, against an independently written anchor.
  assert.equal(style.backgroundColor, "#5C7350");
  assert.equal(style.borderColor, "#5C7350");
  // The same hex the shared chip token resolves to — the agreement is the point.
  assert.equal(Colors.sage[600], "#5C7350");
  assert.equal(style.backgroundColor, Palette.chip.selected.background);

  // And explicitly NOT the darker green it used to carry.
  assert.notEqual(style.backgroundColor, Colors.sage[700]);
  tree.unmount();
});

test("an UNSELECTED chip is untouched by the harmonise", () => {
  const tree = render([MY_PLANS.key]);
  const chip = findPressableByText(
    tree.toJSON() as unknown as Node,
    FEATURED.label,
  );
  assert.ok(chip, "the unselected chip renders");
  const style = resolvedStyle(chip!);
  assert.equal(style.backgroundColor, Palette.background.card);
  assert.equal(style.borderColor, Colors.neutral[300]);
  tree.unmount();
});

test("the white label still clears AA on the new fill", () => {
  // sRGB relative luminance, WCAG 2.x. Recomputed here rather than asserted as
  // a remembered number, so a future fill change is measured, not assumed.
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = c.map((v) =>
      v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const contrast = ratio(Colors.neutral[0], Colors.sage[600]);
  assert.ok(
    contrast >= 4.5,
    `white on sage[600] is ${contrast.toFixed(4)}:1, under the 4.5:1 AA floor`,
  );
  // Pinned so a later fill change that merely scrapes past 4.5 is still visible
  // as a drop from what shipped.
  assert.equal(contrast.toFixed(4), "5.2197");
});
