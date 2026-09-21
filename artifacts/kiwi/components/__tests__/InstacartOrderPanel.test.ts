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

type PanelProps = React.ComponentProps<typeof InstacartOrderPanel>;
// Part D added `items` + `onAddStaple`; the Block 2 cases render an empty
// list (they pin the gate and the copy, not the count).
const BASE: Pick<PanelProps, "items" | "onAddStaple"> = { items: [], onAddStaple: () => {} };

function mount(props: Partial<PanelProps> & Pick<PanelProps, "enabled" | "busy" | "error" | "onPress">) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(InstacartOrderPanel, { ...BASE, ...props }));
  });
  return tree;
}

function render(props: Partial<PanelProps> & Pick<PanelProps, "enabled" | "busy" | "error" | "onPress">): Node {
  return mount(props).toJSON() as unknown as Node;
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
  assert.deepEqual(gatherText(tree), ["Shop on Instacart", "Sends 0 items", INSTACART_EXPECTATION_COPY]);
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
  assert.deepEqual(gatherText(tree), ["Shop on Instacart", "Sends 0 items", INSTACART_EXPECTATION_COPY, INSTACART_UNREACHABLE_COPY]);
  assert.equal(findAll(tree, byTestId("instacart-error")).length, 1);
});

// ── Row 8 Block 3 Part D — the count line and the staples disclosure ────────
// Rendered off the SAME rows the selection test counts (the measured fixture).
// The "N items" half is plain text; only the staples fragment is a control.

import { measuredList } from "@/lib/__tests__/fixtures/instacartMeasuredList";
import type { GroceryListItem } from "@/lib/types";

const textOf = (tree: Node, id: string) => gatherText(findAll(tree, byTestId(id))[0] ?? null).join("");
const staplesTexts = (tree: Node) =>
  findAll(tree, byTestId("instacart-staples")).flatMap((n) =>
    findAll(n, (c) => c.type === "rn-text").map((t) => gatherText(t).join("")),
  );

/** A stateful harness: `onAddStaple` opts the row in and re-renders, the way
 *  the screen's applyItemPatch does. */
function harness(initial: GroceryListItem[]) {
  let items = initial;
  let tree!: TestRenderer.ReactTestRenderer;
  const props = (): PanelProps => ({
    enabled: true,
    busy: false,
    error: null,
    onPress: () => {},
    items,
    onAddStaple: (it) => {
      items = items.map((r) => (r.id === it.id ? { ...r, stapleOptedIn: true } : r));
      rerender();
    },
  });
  const rerender = () => act(() => void tree.update(React.createElement(InstacartOrderPanel, props())));
  act(() => {
    tree = TestRenderer.create(React.createElement(InstacartOrderPanel, props()));
  });
  return {
    json: () => tree.toJSON() as unknown as Node,
    set: (next: GroceryListItem[]) => {
      items = next;
      rerender();
    },
    press: (id: string) => act(() => (findAll(tree.toJSON() as unknown as Node, byTestId(id))[0].props?.onPress as () => void)()),
    items: () => items,
  };
}

test("Part D: the measured list renders 'Sends 54 items · 6 pantry staples not included', collapsed", () => {
  const h = harness(measuredList());
  const tree = h.json();
  assert.equal(textOf(tree, "instacart-count"), "Sends 54 items · 6 pantry staples not included");
  // Collapsed on mount: no disclosure, and the trigger says so.
  assert.equal(findAll(tree, byTestId("instacart-staples")).length, 0);
  const toggle = findAll(tree, byTestId("instacart-staples-toggle"))[0];
  assert.equal(toggle.props?.accessibilityRole, "button");
  assert.deepEqual(toggle.props?.accessibilityState, { expanded: false });
  assert.equal(toggle.props?.accessibilityLabel, "Show the 6 pantry staples not included");
  // Only the fragment is pressable — "Sends 54 items" is plain text.
  const pressables = findAll(findAll(tree, byTestId("instacart-count"))[0], isPressable);
  assert.equal(pressables.length, 1);
  assert.equal(gatherText(pressables[0]).join(""), "6 pantry staples not included");
  // The CTA, then the count, then the expectation line — Block 2's copy stays.
  const texts = gatherText(tree);
  assert.equal(texts[0], "Shop on Instacart");
  assert.ok(texts.includes(INSTACART_EXPECTATION_COPY));
});

test("Part D: tapping the fragment lists the six by name — names only, no pack text, an Add each", () => {
  const h = harness(measuredList());
  h.press("instacart-staples-toggle");
  const tree = h.json();
  const toggle = findAll(tree, byTestId("instacart-staples-toggle"))[0];
  assert.deepEqual(toggle.props?.accessibilityState, { expanded: true });
  assert.equal(toggle.props?.accessibilityLabel, "Hide the 6 pantry staples not included");
  const names = staplesTexts(tree).filter((t) => t !== "Add");
  assert.deepEqual(names, ["kosher salt", "black pepper", "olive oil", "all-purpose flour", "sugar", "soy sauce"]);
  // The fixture's staples carry purchaseDisplay "1 container (26 oz)" — none of it renders.
  for (const t of staplesTexts(tree)) assert.doesNotMatch(t, /container|oz|\(|\d/);
  const adds = findAll(tree, (n) => typeof n.props?.testID === "string" && n.props.testID.startsWith("instacart-staple-add-"));
  assert.equal(adds.length, 6);
  assert.equal(adds[2].props?.accessibilityLabel, "Add olive oil");
  assert.equal(adds[2].props?.accessibilityRole, "button");
  // Tap again → collapsed.
  h.press("instacart-staples-toggle");
  assert.equal(findAll(h.json(), byTestId("instacart-staples")).length, 0);
});

test("Part D: Add from the disclosure → that name gone, N +1, M −1, the row opted in", () => {
  const h = harness(measuredList());
  h.press("instacart-staples-toggle");
  h.press("instacart-staple-add-staple-olive oil");
  const tree = h.json();
  assert.equal(textOf(tree, "instacart-count"), "Sends 55 items · 5 pantry staples not included");
  assert.ok(!staplesTexts(tree).includes("olive oil"));
  assert.equal(findAll(tree, byTestId("instacart-staples")).length, 1, "stays open for the next one");
  assert.equal(h.items().find((r) => r.id === "staple-olive oil")?.stapleOptedIn, true);
});

test("Part D: checking a row off → N −1", () => {
  const h = harness(measuredList());
  h.set(h.items().map((r) => (r.id === "r01" ? { ...r, isCompleted: true } : r)));
  assert.equal(textOf(h.json(), "instacart-count"), "Sends 53 items · 6 pantry staples not included");
});

test("Part D: adding the last one → M = 0 collapses and removes the fragment; every staple opted in → no fragment at all", () => {
  const h = harness(measuredList());
  h.press("instacart-staples-toggle");
  for (const n of ["kosher salt", "black pepper", "olive oil", "all-purpose flour", "sugar", "soy sauce"]) {
    h.press(`instacart-staple-add-staple-${n}`);
  }
  const tree = h.json();
  assert.equal(textOf(tree, "instacart-count"), "Sends 60 items");
  assert.equal(findAll(tree, byTestId("instacart-staples-toggle")).length, 0);
  assert.equal(findAll(tree, byTestId("instacart-staples")).length, 0);
  // A fresh mount with everything opted in: same — plain text, nothing pressable in the count.
  const all = measuredList().map((r) => (r.isUniversalStaple ? { ...r, stapleOptedIn: true } : r));
  const t2 = render({ enabled: true, busy: false, error: null, onPress: () => {}, items: all });
  assert.equal(textOf(t2, "instacart-count"), "Sends 60 items");
  assert.equal(findAll(findAll(t2, byTestId("instacart-count"))[0], isPressable).length, 0);
});

test("Part D: singulars — '1 item', '1 pantry staple'", () => {
  const one = measuredList().filter((r) => r.id === "r01" || r.id === "staple-sugar");
  const tree = render({ enabled: true, busy: false, error: null, onPress: () => {}, items: one });
  assert.equal(textOf(tree, "instacart-count"), "Sends 1 item · 1 pantry staple not included");
});

test("Part D: coming-soon state renders no count", () => {
  const tree = render({ enabled: false, busy: false, error: null, onPress: () => {}, items: measuredList() });
  assert.deepEqual(gatherText(tree), [INSTACART_COMING_SOON_COPY]);
  assert.equal(findAll(tree, byTestId("instacart-count")).length, 0);
});
