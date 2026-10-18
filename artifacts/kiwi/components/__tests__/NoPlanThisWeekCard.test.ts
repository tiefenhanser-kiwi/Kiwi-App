// FIX-3 / BUG-118 — the "no plan for this week" card on Home.
//
// The decision (when it shows) is pinned in lib/home/__tests__/homeSections.test.ts.
// This file pins the copy against hard-coded literals (not the exported
// constants — the HomeErrorState precedent).
//
// FIX-5 — the card is a message, not a menu: Hans's copy, and nothing on it to
// press (the paths it names are on Home below it).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { NoPlanThisWeekCard } from "../NoPlanThisWeekCard";

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

function render() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(NoPlanThisWeekCard));
  });
  return tree;
}

test("FIX-5: the card carries Hans's copy, verbatim", () => {
  const texts = flat(render().toJSON() as RenderedNode | null);
  for (const literal of [
    "No plan set for this week yet",
    "Get a plan in seconds with Kiwi, choose a Featured Plan, or use one of your saved plans.",
  ]) {
    assert.ok(texts.includes(literal), `missing "${literal}": ${texts}`);
  }
  // FIX-3's copy and button labels are gone.
  for (const gone of ["No plan for this week yet", "Go to Plans", "See featured", "Cook something up"]) {
    assert.ok(!texts.includes(gone), `still says "${gone}": ${texts}`);
  }
});

test("FIX-5: a message, not a menu — nothing on the card is pressable", () => {
  const tree = render();
  const pressable = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === "function" ||
      typeof n.props.onPressIn === "function" ||
      n.props.accessibilityRole === "button" ||
      n.props.role === "button",
  );
  assert.equal(pressable.length, 0, `pressable nodes: ${pressable.map((n) => String(n.props.testID ?? n.type)).join(", ")}`);
});
