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

import Welcome from "../../app/(auth)/welcome";

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
