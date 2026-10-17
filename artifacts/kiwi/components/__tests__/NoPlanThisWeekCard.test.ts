// FIX-3 / BUG-118 — the "no plan for this week" card on Home.
//
// The decision (when it shows) is pinned in lib/home/__tests__/homeSections.test.ts.
// This file pins the copy against hard-coded literals (not the exported
// constants — the HomeErrorState precedent) and that each action fires its own
// handler.

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

function render(props: Parameters<typeof NoPlanThisWeekCard>[0]) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(NoPlanThisWeekCard, props));
  });
  return tree;
}

const noop = () => {};

test("BUG-118: the card carries the drafted copy, verbatim", () => {
  const texts = flat(
    render({ onGoToPlans: noop, onSeeFeatured: noop, onCookSomethingUp: noop }).toJSON() as RenderedNode | null,
  );
  for (const literal of [
    "No plan for this week yet",
    "Pick one of your plans, try a featured plan, or have Kiwi cook something up.",
    "Go to Plans",
    "See featured",
    "Cook something up",
  ]) {
    assert.ok(texts.includes(literal), `missing "${literal}": ${texts}`);
  }
});

test("BUG-118: each action fires its own handler, once", () => {
  const calls: string[] = [];
  const tree = render({
    onGoToPlans: () => calls.push("plans"),
    onSeeFeatured: () => calls.push("featured"),
    onCookSomethingUp: () => calls.push("cook"),
  });
  const press = (testID: string) => {
    const node = tree.root.find(
      (n) => n.props.testID === testID && typeof n.props.onPress === "function",
    );
    act(() => node.props.onPress());
  };
  press("home-no-plan-go-to-plans");
  press("home-no-plan-see-featured");
  press("home-no-plan-cook-up");
  assert.deepEqual(calls, ["plans", "featured", "cook"]);
});
