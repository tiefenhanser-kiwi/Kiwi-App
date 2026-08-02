// WS7-6 G1 — Mode A presentational body (components/AskKiwiView.tsx).
//   - renders the input + submit CTA
//   - submit is disabled when the parent says so (empty-input gate)
//   - pressing an enabled submit fires onSubmit
//   - error text surfaces when provided (input-preserved failure path)

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text, TextInput } from "react-native";

import { AskKiwiView, type AskKiwiViewProps } from "../AskKiwiView";

function baseProps(overrides: Partial<AskKiwiViewProps> = {}): AskKiwiViewProps {
  return {
    text: "",
    onChangeText: () => {},
    servings: 4,
    onServingsChange: () => {},
    submitDisabled: true,
    onSubmit: () => {},
    errorMessage: null,
    ...overrides,
  };
}

function render(props: AskKiwiViewProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  // act is async-safe; the body has no effects but keep the convention.
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(AskKiwiView, props));
  });
  return renderer;
}

function submitButton(root: TestRenderer.ReactTestInstance) {
  return root
    .findAllByType(Pressable)
    .find((p) => p.props.testID === "ask-kiwi-submit");
}

test("renders the free-text input and the Ask Kiwi CTA", () => {
  const renderer = render(baseProps());
  const input = renderer.root
    .findAllByType(TextInput)
    .find((t) => t.props.testID === "ask-kiwi-input");
  assert.ok(input, "free-text input missing");
  assert.ok(submitButton(renderer.root), "submit CTA missing");
  const texts = renderer.root.findAllByType(Text).map((t) => t.props.children);
  assert.ok(
    texts.some((c) => c === "Ask Kiwi for a meal"),
    "title missing",
  );
  renderer.unmount();
});

test("submit disabled when submitDisabled is true (empty input gate)", () => {
  const renderer = render(baseProps({ submitDisabled: true }));
  assert.equal(submitButton(renderer.root)!.props.disabled, true);
  renderer.unmount();
});

test("pressing an enabled submit fires onSubmit exactly once", () => {
  let fired = 0;
  const renderer = render(
    baseProps({
      text: "chicken piccata",
      submitDisabled: false,
      onSubmit: () => {
        fired += 1;
      },
    }),
  );
  const btn = submitButton(renderer.root)!;
  // Button passes `disabled || loading` through, so an enabled button's
  // Pressable `disabled` is falsy (undefined), not literal false.
  assert.ok(!btn.props.disabled, "enabled submit should not be disabled");
  act(() => {
    btn.props.onPress();
  });
  assert.equal(fired, 1);
  renderer.unmount();
});

test("error message renders when provided (failure keeps input visible)", () => {
  const renderer = render(
    baseProps({ text: "kept text", errorMessage: "Kiwi couldn't parse that." }),
  );
  const err = renderer.root
    .findAllByType(Text)
    .find((t) => t.props.testID === "ask-kiwi-error");
  assert.ok(err, "error text missing");
  assert.equal(err!.props.children, "Kiwi couldn't parse that.");
  // The input still holds the user's text.
  const input = renderer.root
    .findAllByType(TextInput)
    .find((t) => t.props.testID === "ask-kiwi-input");
  assert.equal(input!.props.value, "kept text");
  renderer.unmount();
});
