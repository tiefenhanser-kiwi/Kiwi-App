// WS9 3d Part 3b-2 — ToastProvider behavior tests. Pins the app-level toast
// host contract:
//   - showToast renders the message (and an Undo action for the undo variant);
//   - the informational variant auto-dismisses → onDismiss (not onAction);
//   - pressing Undo fires onAction and NOT onDismiss;
//   - starting a second toast COMMITS the first (its onDismiss fires) rather
//     than dropping it;
//   - hideToast dismisses the current toast.
//
// Harness mirrors the sibling context tests: react-test-renderer under the
// IS_REACT_ACT_ENVIRONMENT flag, RN primitives via the physical stub, real
// timers with a short durationMs. A Capture child grabs the imperative useToast
// API (like AppContext.mutators' `app`).

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";

import { ToastProvider, useToast, type ToastOptions } from "../ToastProvider";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let api: { showToast: (o: ToastOptions) => void; hideToast: () => void } | null =
  null;

function Capture() {
  api = useToast();
  return null;
}

function textLeavesOf(node: TestRenderer.ReactTestInstance): string[] {
  return node.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ToastProvider, null, React.createElement(Capture)),
    );
  });
  return renderer;
}

beforeEach(() => {
  api = null;
});

test("showToast renders the message; informational variant has no action", async () => {
  const r = await mount();
  await act(async () => {
    api!.showToast({ message: "Saved.", durationMs: 10_000 });
  });
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(joined.includes("Saved."), `message should render: ${joined}`);
  assert.equal(r.root.findAllByType(Pressable).length, 0, "no action pressable");
  await act(async () => {
    api!.hideToast();
  });
  r.unmount();
});

test("informational toast auto-dismisses → onDismiss (not onAction)", async () => {
  const r = await mount();
  let dismiss = 0;
  await act(async () => {
    api!.showToast({
      message: "x",
      durationMs: 40,
      onDismiss: () => {
        dismiss++;
      },
    });
  });
  await act(async () => {
    await wait(120);
  });
  assert.equal(dismiss, 1, "onDismiss fires once on timeout");
  r.unmount();
});

test("Undo press fires onAction and NOT onDismiss", async () => {
  const r = await mount();
  let action = 0;
  let dismiss = 0;
  await act(async () => {
    api!.showToast({
      message: "Item removed.",
      actionLabel: "Undo",
      durationMs: 40,
      onAction: () => {
        action++;
      },
      onDismiss: () => {
        dismiss++;
      },
    });
  });
  const btn = r.root.findAllByType(Pressable)[0];
  await act(async () => {
    btn.props.onPress();
  });
  await act(async () => {
    await wait(120);
  });
  assert.equal(action, 1, "onAction fires once");
  assert.equal(dismiss, 0, "onDismiss must not fire after Undo");
  r.unmount();
});

test("starting a second toast commits the first (its onDismiss fires)", async () => {
  const r = await mount();
  let firstDismiss = 0;
  await act(async () => {
    api!.showToast({
      message: "first",
      durationMs: 10_000,
      onDismiss: () => {
        firstDismiss++;
      },
    });
  });
  await act(async () => {
    api!.showToast({ message: "second", durationMs: 10_000 });
  });
  assert.equal(firstDismiss, 1, "the first toast's onDismiss (commit) fired on replace");
  const joined = textLeavesOf(r.root).join(" | ");
  assert.ok(joined.includes("second"), `second toast should be showing: ${joined}`);
  assert.ok(!joined.includes("first"), `first toast should be gone: ${joined}`);
  await act(async () => {
    api!.hideToast();
  });
  r.unmount();
});

test("hideToast dismisses the current toast (onDismiss fires once)", async () => {
  const r = await mount();
  let dismiss = 0;
  await act(async () => {
    api!.showToast({
      message: "x",
      durationMs: 10_000,
      onDismiss: () => {
        dismiss++;
      },
    });
  });
  await act(async () => {
    api!.hideToast();
  });
  assert.equal(dismiss, 1);
  assert.equal(r.toJSON() === null || !textLeavesOf(r.root).join("").includes("x"), true);
  r.unmount();
});
