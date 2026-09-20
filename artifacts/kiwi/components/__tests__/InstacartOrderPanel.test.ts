// Row 8 Block 2 — the flag gate. Flag false → the coming-soon line and NO
// button (a dead affordance is removed, not restyled — D-WS9-099); flag true →
// the CTA with the expectation line under it, and the error line only when
// there is one.

import assert from "node:assert/strict";
import { after, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// InstacartButton require()s its logo; stand in for Metro's asset registry.
(globalThis as { require?: unknown }).require = () => 1;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { InstacartOrderPanel } from "../InstacartOrderPanel";
import {
  INSTACART_COMING_SOON_COPY,
  INSTACART_EXPECTATION_COPY,
  INSTACART_UNREACHABLE_COPY,
} from "@/lib/instacartOrder";

after(() => {
  delete (globalThis as { require?: unknown }).require;
});

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function findAll(node: Node | string | null, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) for (const c of node.children) findAll(c, pred, out);
  return out;
}

function gatherText(node: Node | string | null, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) for (const c of node.children) gatherText(c, out);
  return out;
}

function render(props: React.ComponentProps<typeof InstacartOrderPanel>): Node {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(InstacartOrderPanel, props));
  });
  return tree.toJSON() as unknown as Node;
}

const byTestId = (id: string) => (n: Node) => n.props?.testID === id;
const isPressable = (n: Node) => n.type === "rn-pressable";

test("flag false: the coming-soon line, no button, nothing pressable", () => {
  const tree = render({ enabled: false, busy: false, error: null, onPress: () => {} });
  assert.deepEqual(gatherText(tree), [INSTACART_COMING_SOON_COPY]);
  assert.equal(findAll(tree, isPressable).length, 0);
  assert.equal(findAll(tree, byTestId("instacart-cta")).length, 0);
  assert.equal(findAll(tree, byTestId("instacart-coming-soon")).length, 1);
  assert.equal(INSTACART_COMING_SOON_COPY, "Online grocery ordering is coming soon.");
});

test("flag true: the CTA with the expectation line under it; no coming-soon line", () => {
  let presses = 0;
  const tree = render({ enabled: true, busy: false, error: null, onPress: () => void presses++ });
  const cta = findAll(tree, byTestId("instacart-cta"));
  assert.equal(cta.length, 1);
  (cta[0].props?.onPress as () => void)();
  assert.equal(presses, 1);
  assert.deepEqual(gatherText(tree), ["Shop on Instacart", INSTACART_EXPECTATION_COPY]);
  assert.equal(findAll(tree, byTestId("instacart-coming-soon")).length, 0);
  assert.equal(
    INSTACART_EXPECTATION_COPY,
    "Opens Instacart. Matching can take a moment — check the list before you order.",
  );
});

test("flag true + busy: the CTA is in its loading state (inert)", () => {
  const tree = render({ enabled: true, busy: true, error: null, onPress: () => {} });
  const cta = findAll(tree, byTestId("instacart-cta"))[0];
  assert.equal(cta.props?.onPress, undefined);
  assert.deepEqual(cta.props?.accessibilityState, { disabled: true, busy: true });
});

test("flag true + error: Kiwi's copy renders under the expectation line", () => {
  const tree = render({ enabled: true, busy: false, error: INSTACART_UNREACHABLE_COPY, onPress: () => {} });
  assert.deepEqual(gatherText(tree), ["Shop on Instacart", INSTACART_EXPECTATION_COPY, INSTACART_UNREACHABLE_COPY]);
  assert.equal(findAll(tree, byTestId("instacart-error")).length, 1);
});
