// WS7-6 G3 Scope A — surface #3 chooser. Asserts the create-mode cards render
// in the shared convention order (Ask Kiwi FIRST, then Create manually) and
// that each routes to the right builder entry. The deferred push (a 150ms
// slide-out delay) is awaited with a real timer.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";
import {
  __setRouterForTests,
  __resetRouterForTests,
} from "expo-router";

import { AddDishChooserSheet } from "../AddDishChooserSheet";

function textLeaves(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("AddDishChooserSheet: create cards render Ask-Kiwi-first", async () => {
  __resetRouterForTests();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(AddDishChooserSheet, {
        visible: true,
        onClose: () => {},
      }),
    );
  });

  const leaves = textLeaves(renderer.root);
  const askKiwi = leaves.findIndex((t) => t === "Ask Kiwi");
  const manual = leaves.findIndex((t) => t === "Create manually");

  assert.ok(askKiwi >= 0, "Ask Kiwi card missing");
  assert.ok(manual >= 0, "Create manually card missing");
  assert.ok(askKiwi < manual, "Ask Kiwi should precede Create manually");

  renderer.unmount();
  __resetRouterForTests();
});

test("AddDishChooserSheet: Ask Kiwi routes to the dish-side Mode-A screen", async () => {
  let pushed: { pathname?: string } | null = null;
  let closed = 0;
  __setRouterForTests({
    push: (href: { pathname?: string }) => {
      pushed = href;
    },
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(AddDishChooserSheet, {
        visible: true,
        onClose: () => {
          closed += 1;
        },
      }),
    );
  });

  const card = renderer.root
    .findAllByType(Pressable)
    .find((p) => p.props.testID === "add-dish-ask-kiwi");
  assert.ok(card, "ask-kiwi card not found");
  await act(async () => {
    card!.props.onPress({});
  });

  assert.equal(closed, 1, "onClose should fire immediately on tap");
  // Push is deferred 150ms so the sheet can finish sliding out.
  await act(async () => {
    await wait(200);
  });
  assert.equal(
    pushed?.pathname,
    "/ask-kiwi-dish",
    "Ask Kiwi should route to /ask-kiwi-dish",
  );

  renderer.unmount();
  __resetRouterForTests();
});

test("AddDishChooserSheet: Create manually routes to the dish builder", async () => {
  let pushed: { pathname?: string } | null = null;
  __setRouterForTests({
    push: (href: { pathname?: string }) => {
      pushed = href;
    },
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(AddDishChooserSheet, {
        visible: true,
        onClose: () => {},
      }),
    );
  });

  const card = renderer.root
    .findAllByType(Pressable)
    .find((p) => p.props.testID === "add-dish-create-manually");
  assert.ok(card, "create-manually card not found");
  await act(async () => {
    card!.props.onPress({});
    await wait(200);
  });
  assert.equal(pushed?.pathname, "/dish-builder", "Create manually should route to /dish-builder");

  renderer.unmount();
  __resetRouterForTests();
});
