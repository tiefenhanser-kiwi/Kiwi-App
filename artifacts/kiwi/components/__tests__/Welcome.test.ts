// BUG-264 — the Welcome screen's mark.
//
// app/(auth)/welcome.tsx rendered `assets/images/icon.png`, the RETIRED April
// app icon, months after f0b392c replaced it everywhere else with the Deep
// Kiwi mark. The first screen a new user sees was the one off-brand surface.
// Two things must hold and neither is visible to typecheck: the screen asks the
// asset registry for the Deep Kiwi mark (`kiwi-mark-256.png` — the same mark
// the header uses, at the raster that fits a 96pt slot; the header's 28pt
// ladder tops out at 84px), and it no longer asks for `icon.png`.
//
// app/** is outside the test glob (D-WS9-164), so this lives beside the
// component tests and reaches up into app/(auth)/. The `require` shim is the
// same Metro asset-registry stand-in HomeHeader.test.ts uses — see the note
// there for why it is installed after the hoisted imports.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MARK_ASSET_ID = 2646;
const requiredSpecifiers: string[] = [];
(globalThis as { require?: unknown }).require = (specifier: string) => {
  requiredSpecifiers.push(specifier);
  return MARK_ASSET_ID;
};

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as ReactNative from "react-native";
import * as ExpoRouter from "expo-router";

import Welcome, {
  WELCOME_EXPLORE_LABEL,
  WELCOME_PRIMARY_LABEL,
  WELCOME_SIGN_IN_LABEL,
} from "../../app/(auth)/welcome";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function findAll(node: Node | string | null, type: string, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAll(c, type, out);
  }
  return out;
}

let activeRenderer: TestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeRenderer) {
    const r = activeRenderer;
    activeRenderer = null;
    await act(async () => {
      r.unmount();
    });
  }
  requiredSpecifiers.length = 0;
});

after(() => {
  delete (globalThis as { require?: unknown }).require;
});

async function mountWelcome(): Promise<Node> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Welcome));
  });
  activeRenderer = renderer;
  return renderer.toJSON() as unknown as Node;
}

test("Welcome renders the Deep Kiwi mark (kiwi-mark-256.png) as its hero image", async () => {
  const tree = await mountWelcome();

  const images = findAll(tree, "rn-image");
  assert.equal(images.length, 1, "exactly one <Image> — the hero mark — on Welcome");
  assert.equal(images[0].props?.source, MARK_ASSET_ID);
  assert.ok(
    requiredSpecifiers.some((s) => s.endsWith("/kiwi-mark-256.png")),
    `expected a require of kiwi-mark-256.png, saw: ${JSON.stringify(requiredSpecifiers)}`,
  );
});

test("Welcome no longer references the retired icon.png", async () => {
  await mountWelcome();
  assert.ok(
    !requiredSpecifiers.some((s) => /\/icon\.png$/.test(s)),
    `the retired April icon must not be required; saw: ${JSON.stringify(requiredSpecifiers)}`,
  );
});

test("the hero mark keeps the screen's 96×96 slot", async () => {
  const tree = await mountWelcome();
  const mark = findAll(tree, "rn-image")[0];
  const s = mark.props?.style;
  const style = Object.assign({}, ...(Array.isArray(s) ? s : [s]).filter(Boolean));
  assert.equal(style.width, 96);
  assert.equal(style.height, 96);
});

// ── Resub C1 — Apple Guideline 4 and 5.1.1(v) ──────────────────────────────
//
// Apple's reviewer saw this screen in a 375 × 667 window with the actions cut
// off at the bottom, and could not use anything without an account. The fix is
// a pinned footer holding three actions, one of which opens the Test Kitchen.
// The App Review note quotes the explore label, so it is asserted literally.

const rn = ReactNative as unknown as {
  __setWindowDimensionsForTests(p: { width?: number; height?: number; fontScale?: number }): void;
  __resetWindowDimensionsForTests(): void;
};
const router = ExpoRouter as unknown as {
  __setRouterForTests(impl: Record<string, unknown>): void;
  __resetRouterForTests(): void;
};

function byTestId(node: Node | string | null, id: string): Node | null {
  if (node == null || typeof node === "string") return null;
  if (node.props?.testID === id) return node;
  for (const c of node.children ?? []) {
    const hit = byTestId(c, id);
    if (hit) return hit;
  }
  return null;
}

/** The accessible names of every button under `node`, in render order. */
function buttonLabels(node: Node | null): string[] {
  return findAll(node, "rn-pressable")
    .map((p) => p.props?.accessibilityLabel)
    .filter((l): l is string => typeof l === "string");
}

function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

function flat(style: unknown): Record<string, unknown> {
  const parts = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...parts.flat(Infinity).filter(Boolean));
}

test("the footer holds the three actions, in order, and the primary is the trial", async () => {
  const tree = await mountWelcome();
  const footer = byTestId(tree, "welcome-footer");
  assert.ok(footer, "a pinned footer exists");
  assert.deepEqual(buttonLabels(footer), [
    "Start your 14-day free trial",
    "Explore without an account",
    "I already have an account",
  ]);
  assert.equal(WELCOME_PRIMARY_LABEL, "Start your 14-day free trial");
  assert.equal(WELCOME_EXPLORE_LABEL, "Explore without an account");
  assert.equal(WELCOME_SIGN_IN_LABEL, "I already have an account");
  assert.ok(!textOf(tree).includes("Get started"), "the old primary label is gone");
});

test("the actions are NOT inside the scroll area — they cannot scroll off", async () => {
  const tree = await mountWelcome();
  const scroll = byTestId(tree, "welcome-scroll");
  assert.ok(scroll, "the hero and cards scroll");
  assert.deepEqual(buttonLabels(scroll), [], "no action lives in the ScrollView");
  // And the legal line sits with the actions it qualifies.
  assert.match(textOf(byTestId(tree, "welcome-footer")), /By continuing you agree/);
});

test("each action goes where it should — explore opens the Test Kitchen", async () => {
  const pushed: unknown[] = [];
  router.__setRouterForTests({ push: (href: unknown) => pushed.push(href) });
  try {
    const tree = await mountWelcome();
    const footer = byTestId(tree, "welcome-footer");
    for (const id of ["welcome-start-trial", "welcome-explore", "welcome-sign-in"]) {
      const button = byTestId(footer, id);
      assert.ok(button, id);
      await act(async () => {
        (button!.props!.onPress as () => void)();
      });
    }
    assert.deepEqual(pushed, ["/(auth)/sign-up", "/test-kitchen", "/(auth)/sign-in"]);
  } finally {
    router.__resetRouterForTests();
  }
});

test("the footer's text growth is capped so every action stays whole", async () => {
  const tree = await mountWelcome();
  const footer = byTestId(tree, "welcome-footer");
  const labels = findAll(footer, "rn-text").filter((t) =>
    [WELCOME_PRIMARY_LABEL, WELCOME_EXPLORE_LABEL, WELCOME_SIGN_IN_LABEL].includes(textOf(t)),
  );
  assert.equal(labels.length, 3);
  for (const l of labels) {
    assert.equal(l.props?.maxFontSizeMultiplier, 2, textOf(l));
    // A capped label may wrap inside its button rather than overflow it.
    assert.equal(flat(l.props?.style).flexShrink, 1, textOf(l));
  }
  const legal = findAll(footer, "rn-text").find((t) => /By continuing/.test(textOf(t)));
  assert.equal(legal?.props?.maxFontSizeMultiplier, 1.5);
});

test("a 667 pt window gets the compact hero", async () => {
  rn.__setWindowDimensionsForTests({ width: 375, height: 667 });
  try {
    const tree = await mountWelcome();
    const mark = flat(findAll(tree, "rn-image")[0].props?.style);
    assert.equal(mark.width, 64);
    assert.equal(mark.height, 64);
    const texts = findAll(tree, "rn-text");
    const brand = texts.find((t) => textOf(t) === "Kiwi");
    assert.equal(flat(brand?.props?.style).fontSize, 34);
    const tag = texts.find((t) => /Thought to Table/.test(textOf(t)));
    assert.equal(tag?.props?.numberOfLines, 2, "the tagline is held to two lines");
  } finally {
    rn.__resetWindowDimensionsForTests();
  }
});

test("an 812 pt window keeps the full hero", async () => {
  const tall = await mountWelcome();
  assert.equal(flat(findAll(tall, "rn-image")[0].props?.style).width, 96);
  const tallTag = findAll(tall, "rn-text").find((t) => /Thought to Table/.test(textOf(t)));
  assert.equal(tallTag?.props?.numberOfLines, undefined);
});

test("the grocery card names Instacart and any store — no Whole Foods", async () => {
  const tree = await mountWelcome();
  const all = textOf(tree);
  assert.ok(
    all.includes("Kiwi builds your list and sends it to Instacart, or take it to any store."),
  );
  assert.ok(!/Whole Foods/.test(all));
});
