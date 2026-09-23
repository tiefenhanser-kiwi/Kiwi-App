// components/PasswordField — the show/hide toggle.
//
// Two kinds of claim here, deliberately:
//
//   BEHAVIOUR, through a real render: the field starts hidden, the toggle
//   flips secureTextEntry AND the accessibility label AND the icon, and flips
//   back. A test that only checked the icon would pass while the password
//   stayed masked.
//
//   SOURCE-LEVEL, for the five call sites: app/** is outside the test glob
//   (D-WS9-164), so the only way to pin "every password input on every screen
//   is this component" is to read the files — the bulkIntakeHeadingOwner /
//   orderOnlineWiring precedent. A bare `secureTextEntry` anywhere in app/**
//   is a screen that got missed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { PasswordField } from "../PasswordField";

type Node = {
  type?: string;
  props?: Record<string, unknown>;
  children?: Node[] | null;
};

function findAll(node: Node | null, pred: (n: Node) => boolean): Node[] {
  if (!node || typeof node !== "object") return [];
  const hits = pred(node) ? [node] : [];
  const kids = Array.isArray(node.children) ? node.children : [];
  return kids.reduce<Node[]>((acc, k) => acc.concat(findAll(k, pred)), hits);
}

const isInput = (n: Node) => n.type === "rn-text-input";
const isToggle = (n: Node) => n.props?.testID === "password-visibility-toggle";

function render(props: Record<string, unknown> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(PasswordField, {
        value: "hunter2",
        onChangeText: () => {},
        placeholder: "Password",
        ...props,
      } as never),
    );
  });
  return {
    tree: () => renderer.toJSON() as unknown as Node,
    press: () => {
      const t = findAll(renderer.toJSON() as unknown as Node, isToggle)[0];
      act(() => {
        (t.props?.onPress as () => void)();
      });
    },
  };
}

test("starts hidden: secureTextEntry true, label offers to Show", () => {
  const r = render();
  assert.equal(findAll(r.tree(), isInput)[0].props?.secureTextEntry, true);
  const toggle = findAll(r.tree(), isToggle)[0];
  assert.equal(toggle.props?.accessibilityLabel, "Show password");
  assert.equal(toggle.props?.accessibilityRole, "button");
});

test("the toggle flips secureTextEntry and the label, and flips back", () => {
  const r = render();

  r.press();
  assert.equal(
    findAll(r.tree(), isInput)[0].props?.secureTextEntry,
    false,
    "shown: the password is readable",
  );
  assert.equal(
    findAll(r.tree(), isToggle)[0].props?.accessibilityLabel,
    "Hide password",
    "the label must describe what the NEXT tap does",
  );

  r.press();
  assert.equal(findAll(r.tree(), isInput)[0].props?.secureTextEntry, true);
  assert.equal(
    findAll(r.tree(), isToggle)[0].props?.accessibilityLabel,
    "Show password",
  );
});

test("the caller's props reach the input, and its style is kept", () => {
  const r = render({
    autoComplete: "new-password",
    textContentType: "newPassword",
    returnKeyType: "next",
    editable: false,
    style: { borderWidth: 1 },
  });
  const input = findAll(r.tree(), isInput)[0].props!;
  assert.equal(input.autoComplete, "new-password");
  assert.equal(input.textContentType, "newPassword");
  assert.equal(input.returnKeyType, "next");
  assert.equal(input.editable, false);
  // The caller's style survives; the component only adds room for the icon.
  assert.deepEqual((input.style as unknown[])[0], { borderWidth: 1 });
});

// ── the five call sites ────────────────────────────────────────────────────

const SITES = [
  "app/(auth)/sign-in.tsx",
  "app/(auth)/sign-up.tsx",
  "app/(auth)/reset-password.tsx",
  "app/(tabs)/profile.tsx",
] as const;

test("every password input in app/** is a PasswordField — no bare secureTextEntry left", () => {
  for (const f of SITES) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(
      src,
      /\n\s*secureTextEntry\b/,
      `${f} still has a raw secureTextEntry input`,
    );
    assert.match(
      src,
      /import \{ PasswordField \} from "@\/components\/PasswordField";/,
      `${f} does not import PasswordField`,
    );
  }
  // reset-password has TWO (new + confirm); the others one each = 5.
  const total = SITES.reduce(
    (n, f) => n + (readFileSync(f, "utf8").match(/<PasswordField\b/g) ?? []).length,
    0,
  );
  assert.equal(total, 5, "all five sites converted");
});

test("sign-up's password field keeps its ref — the Next key focus chain", () => {
  const src = readFileSync("app/(auth)/sign-up.tsx", "utf8");
  // A wrapper that swallowed the ref would break this silently: the field
  // above it calls passwordRef.current?.focus() on submit.
  assert.match(src, /<PasswordField\s+ref=\{passwordRef\}/);
  assert.match(src, /onSubmitEditing=\{\(\) => passwordRef\.current\?\.focus\(\)\}/);
});
