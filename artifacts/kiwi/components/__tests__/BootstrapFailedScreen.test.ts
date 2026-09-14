// D-WS9-241 B (BUG-258) — the failure screen: ruled copy, the two actions
// wired to their handlers, and a busy state that blocks a double-tap. The
// screen's PLACEMENT (replacing the navigator in app/_layout.tsx) is outside
// the test glob and device-verified.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { BOOTSTRAP_FAILED_COPY, BootstrapFailedScreen } from "../BootstrapFailedScreen";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function collectText(n: Json | string | null, out: string[] = []): string[] {
  if (n == null) return out;
  if (typeof n === "string") {
    out.push(n);
    return out;
  }
  for (const c of n.children ?? []) collectText(c, out);
  return out;
}

function render(props: React.ComponentProps<typeof BootstrapFailedScreen>) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(BootstrapFailedScreen, props));
  });
  return tree;
}

function byTestId(tree: TestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findByProps({ testID: id });
}

const noop = async () => {};

test("renders the ruled copy: heading, body, Try again, Sign out", () => {
  const tree = render({ onRetry: noop, onSignOut: noop });
  const text = collectText(tree.toJSON() as unknown as Json).join("\n");
  assert.equal(BOOTSTRAP_FAILED_COPY.heading, "Can't reach Kiwi");
  assert.equal(BOOTSTRAP_FAILED_COPY.body, "Check your connection and try again.");
  assert.match(text, /Can't reach Kiwi/);
  assert.match(text, /Check your connection and try again\./);
  assert.match(text, /Try again/);
  assert.match(text, /Sign out/);
});

test("Try again is the primary; Sign out is the quiet secondary", () => {
  const tree = render({ onRetry: noop, onSignOut: noop });
  const retry = byTestId(tree, "bootstrap-retry");
  const signOut = byTestId(tree, "bootstrap-sign-out");
  // Button's default variant is "primary"; the prop is only set for the secondary.
  assert.equal(retry.props.variant, undefined);
  assert.equal(signOut.props.variant, "ghost");
});

test("Try again calls onRetry (and nothing else); Sign out calls onSignOut", async () => {
  let retries = 0;
  let signOuts = 0;
  const tree = render({
    onRetry: async () => {
      retries += 1;
    },
    onSignOut: async () => {
      signOuts += 1;
    },
  });

  await act(async () => {
    (byTestId(tree, "bootstrap-retry").props.onPress as () => void)();
  });
  assert.equal(retries, 1);
  assert.equal(signOuts, 0);

  await act(async () => {
    (byTestId(tree, "bootstrap-sign-out").props.onPress as () => void)();
  });
  assert.equal(retries, 1);
  assert.equal(signOuts, 1);
});

test("while a retry is in flight the retry button is loading, Sign out is disabled, and a second tap is ignored", async () => {
  let release!: () => void;
  let retries = 0;
  const tree = render({
    onRetry: () => {
      retries += 1;
      return new Promise<void>((r) => {
        release = r;
      });
    },
    onSignOut: noop,
  });

  await act(async () => {
    (byTestId(tree, "bootstrap-retry").props.onPress as () => void)();
  });
  assert.equal(byTestId(tree, "bootstrap-retry").props.loading, true);
  assert.equal(byTestId(tree, "bootstrap-sign-out").props.disabled, true);

  // Double-tap: the wrapper's `busy` guard drops it before the handler runs.
  await act(async () => {
    (byTestId(tree, "bootstrap-retry").props.onPress as () => void)();
  });
  assert.equal(retries, 1);

  await act(async () => {
    release();
  });
  assert.equal(byTestId(tree, "bootstrap-retry").props.loading, false);
  assert.equal(byTestId(tree, "bootstrap-sign-out").props.disabled, false);
});

test("a rejecting handler is swallowed (warned) and still releases the busy state", async () => {
  const tree = render({
    onRetry: noop,
    onSignOut: async () => {
      throw new Error("storage refused the clear");
    },
  });
  const warned: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  try {
    await act(async () => {
      (byTestId(tree, "bootstrap-sign-out").props.onPress as () => void)();
      await new Promise((r) => setTimeout(r, 0));
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1, "the rejection was reported, not thrown");
  assert.equal(byTestId(tree, "bootstrap-sign-out").props.loading, false);
  assert.equal(byTestId(tree, "bootstrap-retry").props.disabled, false);
});
