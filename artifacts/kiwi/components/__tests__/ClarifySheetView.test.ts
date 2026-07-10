// WS7-8b Block C (BUG-026) — the clarify sheet is now keyboard-avoiding and
// scrollable so the "Other…" free-text input is reachable when the soft
// keyboard is up. This pins the container shape (mirrors the sibling
// DishChooserSheetView pattern: KeyboardAvoidingView behavior + a scroll
// container with keyboardShouldPersistTaps="handled") and the free-text
// reachability + resolve wiring, since the layout regression was a bare
// Modal→View with no keyboard avoidance and no scroll surface.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
} from "react-native";

import { ClarifySheetView } from "../ClarifySheetView";
import type { GroceryListItem } from "../../lib/types";

function textLeaves(root: TestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

function makeItem(overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: "item-1",
    name: "milk",
    quantity: "1",
    sectionKey: "dairy_eggs",
    isUniversalStaple: false,
    isRecurringItem: false,
    isAmbiguous: true,
    ambiguityOptions: ["Whole milk", "Oat milk", "Almond milk"],
    isOptional: false,
    isCompleted: false,
    ...overrides,
  };
}

const baseProps = {
  visible: true,
  item: makeItem(),
  index: 0,
  total: 3,
  otherOpen: false,
  onToggleOther: () => {},
  otherText: "",
  onChangeOtherText: () => {},
  onResolve: (_v: string) => {},
  onSkip: () => {},
  onLeaveAsIs: () => {},
  onClose: () => {},
};

test("ClarifySheetView: mounts a KeyboardAvoidingView + scroll container (BUG-026)", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ClarifySheetView, baseProps),
    );
  });

  // The bare Modal→View regression had neither of these; the fix mirrors
  // DishChooserSheetView.
  const kav = renderer.root.findByType(KeyboardAvoidingView);
  assert.ok(kav, "expected a KeyboardAvoidingView wrapping the sheet");
  // behavior is platform-conditional (padding on iOS, height elsewhere).
  assert.equal(
    kav.props.behavior,
    Platform.OS === "ios" ? "padding" : "height",
  );

  const scroll = renderer.root.findByType(ScrollView);
  assert.equal(
    scroll.props.keyboardShouldPersistTaps,
    "handled",
    "scroll container must keep taps alive so a chip/Confirm tap lands with the keyboard up",
  );

  renderer.unmount();
});

test("ClarifySheetView: renders progress, item name, and each ambiguity chip", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ClarifySheetView, {
        ...baseProps,
        index: 1,
        total: 4,
      }),
    );
  });

  const joined = textLeaves(renderer.root).join(" | ");
  assert.ok(joined.includes("2 of 4"), `progress missing: ${joined}`);
  assert.ok(joined.includes("milk"), "item name missing");
  assert.ok(joined.includes("Whole milk"), "chip 'Whole milk' missing");
  assert.ok(joined.includes("Oat milk"), "chip 'Oat milk' missing");
  assert.ok(joined.includes("Other…"), "the Other free-text affordance missing");

  renderer.unmount();
});

test("ClarifySheetView: the 'Other…' free-text input is reachable when expanded", async () => {
  // Collapsed: no TextInput.
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ClarifySheetView, {
        ...baseProps,
        otherOpen: false,
      }),
    );
  });
  assert.equal(
    renderer.root.findAllByType(TextInput).length,
    0,
    "collapsed sheet should mount no free-text input",
  );
  renderer.unmount();

  // Expanded: the free-text input mounts (inside the scroll+kbAvoid surface,
  // so it's reachable with the keyboard up — the whole point of BUG-026).
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ClarifySheetView, {
        ...baseProps,
        otherOpen: true,
        otherText: "goat milk",
      }),
    );
  });
  const inputs = renderer.root.findAllByType(TextInput);
  assert.equal(inputs.length, 1, "expanded sheet should mount the free-text input");
  assert.equal(inputs[0].props.value, "goat milk");
  renderer.unmount();
});

test("ClarifySheetView: tapping a chip resolves to that option", async () => {
  let resolved: string | null = null;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ClarifySheetView, {
        ...baseProps,
        onResolve: (v: string) => {
          resolved = v;
        },
      }),
    );
  });

  const chip = renderer.root
    .findAllByType(Pressable)
    .find((p) => {
      const label = textLeaves(p).join("");
      return label === "Oat milk";
    });
  assert.ok(chip, "Oat milk chip not found");
  await act(async () => {
    chip!.props.onPress({});
  });
  assert.equal(resolved, "Oat milk");

  renderer.unmount();
});
