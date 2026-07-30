// WS9 3d Part 1d — Toast behavior tests (D-WS9-001 / D-WS9-011a infra).
// Pins the reusable toast contract:
//   - informational variant: message only, no action button;
//   - undo variant: message + action label;
//   - auto-dismiss fires onDismiss after durationMs (NOT onAction);
//   - action press fires onAction and CANCELS the auto-dismiss (onDismiss
//     never fires for that showing);
//   - unmount mid-timeout does not fire onDismiss (no leaked timer);
//   - visible=false renders nothing.
//
// Harness mirrors the sibling sheet tests: react-test-renderer under the
// IS_REACT_ACT_ENVIRONMENT flag, RN primitives via the physical stub. Real
// timers with a short durationMs + wait() — the file is .test.ts (the package
// `test` script only globs components/__tests__/*.test.ts) and nodes are built
// with React.createElement.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";

import { Toast, type ToastProps } from "../Toast";

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
  props: ToastProps,
): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Toast, props));
  });
  return renderer;
}

test("Toast informational: renders message, no action button", async () => {
  const r = await render({
    visible: true,
    message: "Saved.",
    onDismiss: () => {},
  });
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(joined.includes("Saved."), `message should render: ${joined}`);
  assert.equal(
    r.root.findAllByType(Pressable).length,
    0,
    "informational variant renders no action pressable",
  );
  r.unmount();
});

test("Toast undo: renders message + action label", async () => {
  const r = await render({
    visible: true,
    message: "Item removed.",
    actionLabel: "Undo",
    onAction: () => {},
    onDismiss: () => {},
  });
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(joined.includes("Item removed."), `message: ${joined}`);
  assert.ok(joined.includes("Undo"), `action label: ${joined}`);
  assert.equal(r.root.findAllByType(Pressable).length, 1, "one action pressable");
  r.unmount();
});

test("Toast: auto-dismiss fires onDismiss after durationMs (not onAction)", async () => {
  let dismiss = 0;
  let action = 0;
  const r = await render({
    visible: true,
    message: "x",
    actionLabel: "Undo",
    onAction: () => {
      action++;
    },
    onDismiss: () => {
      dismiss++;
    },
    durationMs: 40,
  });
  await act(async () => {
    await wait(120);
  });
  assert.equal(dismiss, 1, "onDismiss fires exactly once on timeout");
  assert.equal(action, 0, "onAction must not fire on timeout");
  r.unmount();
});

test("Toast: action press fires onAction and cancels the auto-dismiss", async () => {
  let dismiss = 0;
  let action = 0;
  const r = await render({
    visible: true,
    message: "x",
    actionLabel: "Undo",
    onAction: () => {
      action++;
    },
    onDismiss: () => {
      dismiss++;
    },
    durationMs: 40,
  });
  const btn = r.root.findAllByType(Pressable)[0];
  await act(async () => {
    btn.props.onPress();
  });
  // Wait past the auto-dismiss window — it must have been cancelled.
  await act(async () => {
    await wait(120);
  });
  assert.equal(action, 1, "onAction fires once on press");
  assert.equal(dismiss, 0, "onDismiss must not fire after the action cancelled it");
  r.unmount();
});

test("Toast: unmount before timeout does not fire onDismiss (no leaked timer)", async () => {
  let dismiss = 0;
  const r = await render({
    visible: true,
    message: "x",
    onDismiss: () => {
      dismiss++;
    },
    durationMs: 40,
  });
  await act(async () => {
    r.unmount();
  });
  await wait(120);
  assert.equal(dismiss, 0, "a cleared timer must not fire after unmount");
});

test("Toast: visible=false renders nothing", async () => {
  const r = await render({
    visible: false,
    message: "x",
    onDismiss: () => {},
  });
  assert.equal(r.toJSON(), null, "hidden toast renders null");
  r.unmount();
});
