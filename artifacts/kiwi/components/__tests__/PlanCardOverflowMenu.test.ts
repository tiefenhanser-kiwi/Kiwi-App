// WS9 3d Part 1d — PlanCardOverflowMenu behavior tests (D-WS9-001 / D-WS9-008).
// Pins the "⋯" host contract:
//   - renders nothing when neither handler is supplied;
//   - renders the trigger and keeps the menu closed until pressed;
//   - opening shows Use again + Compost when both handlers are present;
//   - choosing an item fires its handler (after the slide-out defer);
//   - an item is hidden when its handler is omitted.
//
// Harness mirrors the sibling sheet tests: react-test-renderer under the
// IS_REACT_ACT_ENVIRONMENT flag, RN primitives via the physical stub (Modal
// renders null when visible=false, so closed-menu items are genuinely absent).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";

import {
  PlanCardOverflowMenu,
  type PlanCardOverflowMenuProps,
} from "../PlanCardOverflowMenu";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textLeavesOf(node: TestRenderer.ReactTestInstance): string[] {
  return node.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

async function render(
  props: PlanCardOverflowMenuProps,
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanCardOverflowMenu, props),
    );
  });
  return renderer;
}

async function openMenu(r: TestRenderer.ReactTestRenderer) {
  const trigger = r.root.findAllByType(Pressable)[0];
  await act(async () => {
    trigger.props.onPress();
  });
}

test("PlanCardOverflowMenu: renders nothing when no handlers supplied", async () => {
  const r = await render({});
  assert.equal(r.toJSON(), null, "no handlers → no trigger");
  r.unmount();
});

test("PlanCardOverflowMenu: renders trigger, menu closed until pressed", async () => {
  const r = await render({ onCompost: () => {}, onUseAgain: () => {} });
  assert.ok(
    r.root.findAllByType(Pressable).length >= 1,
    "trigger pressable should render",
  );
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(!joined.includes("Compost"), `menu items hidden while closed: ${joined}`);
  assert.ok(!joined.includes("Use again"), `menu items hidden while closed: ${joined}`);
  r.unmount();
});

test("PlanCardOverflowMenu: opening shows Use again + Compost", async () => {
  const r = await render({ onCompost: () => {}, onUseAgain: () => {} });
  await openMenu(r);
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(joined.includes("Use again"), `Use again should render: ${joined}`);
  assert.ok(joined.includes("Compost"), `Compost should render: ${joined}`);
  r.unmount();
});

test("PlanCardOverflowMenu: choosing Compost fires onCompost", async () => {
  let composted = 0;
  const r = await render({
    onCompost: () => {
      composted++;
    },
    onUseAgain: () => {},
  });
  await openMenu(r);
  const item = r.root
    .findAllByType(Pressable)
    .find((p) => textLeavesOf(p).some((t) => t.includes("Compost")));
  assert.ok(item, "Compost item pressable not found");
  await act(async () => {
    item!.props.onPress();
    // The host defers the handler 150ms so the sheet can slide out first.
    await wait(220);
  });
  assert.equal(composted, 1, "onCompost fired once");
  r.unmount();
});

test("PlanCardOverflowMenu: hides Use again when onUseAgain omitted", async () => {
  const r = await render({ onCompost: () => {} });
  await openMenu(r);
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(joined.includes("Compost"), `Compost should render: ${joined}`);
  assert.ok(
    !joined.includes("Use again"),
    `Use again must be hidden when handler omitted: ${joined}`,
  );
  r.unmount();
});
