// THX-4 (D-WS9-324) — the "Turkey · [−] 14 lb [+]" stepper on the meal screen.
// A component for IngredientsSectionHeading's reason: inline on app/meal/[id].tsx
// (outside the test glob, D-WS9-164) the range, the step and the Reset would be
// unguardable.

import assert from "node:assert/strict";
import { after, test } from "node:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).require = undefined;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { BIRD_WEIGHT_NOTE, BirdWeightStepper } from "../BirdWeightStepper";

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
const byTestId = (id: string) => (n: Node) => n.props?.testID === id;
const one = (tree: Node, id: string) => findAll(tree, byTestId(id))[0];

const WHOLE = { min: 8, max: 20, step: 0.5, default: 14 };

function render(props: Partial<React.ComponentProps<typeof BirdWeightStepper>> = {}) {
  const steps: Array<1 | -1> = [];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(BirdWeightStepper, {
        value: 14,
        range: WHOLE,
        onStep: (d: 1 | -1) => steps.push(d),
        ...props,
      }),
    );
  });
  return { tree: tree.toJSON() as unknown as Node, steps };
}

test("Turkey · 14 lb, and the one line under it", () => {
  const { tree } = render();
  const text = gatherText(tree);
  assert.ok(text.includes("Turkey"));
  assert.deepEqual(gatherText(one(tree, "bird-weight-value")), ["14 lb"]);
  assert.ok(text.includes(BIRD_WEIGHT_NOTE));
  assert.equal(BIRD_WEIGHT_NOTE, "Roast time and thaw day follow the weight.");
});

test("− and + report one step each way", () => {
  const { tree, steps } = render();
  act(() => (one(tree, "bird-weight-minus").props!.onPress as () => void)());
  act(() => (one(tree, "bird-weight-plus").props!.onPress as () => void)());
  assert.deepEqual(steps, [-1, 1]);
  assert.equal(one(tree, "bird-weight-minus").props?.disabled, false);
  assert.equal(one(tree, "bird-weight-plus").props?.disabled, false);
});

test("the ends of the range disable their button (whole 8–20, spatchcock 8–16)", () => {
  assert.equal(one(render({ value: 20 }).tree, "bird-weight-plus").props?.disabled, true);
  assert.equal(one(render({ value: 8 }).tree, "bird-weight-minus").props?.disabled, true);
  const spatch = render({ value: 16, range: { min: 8, max: 16, step: 0.5, default: 14 } }).tree;
  assert.equal(one(spatch, "bird-weight-plus").props?.disabled, true);
  assert.equal(one(spatch, "bird-weight-minus").props?.disabled, false);
});

test("a half pound reads as one ('14½ lb'), the servings rule's quarter too ('11¼ lb')", () => {
  assert.deepEqual(gatherText(one(render({ value: 14.5 }).tree, "bird-weight-value")), ["14½ lb"]);
  assert.deepEqual(gatherText(one(render({ value: 11.25 }).tree, "bird-weight-value")), ["11¼ lb"]);
});

test("Reset only when the screen offers it (a weight is set), and it reports", () => {
  assert.equal(one(render().tree, "bird-weight-reset"), undefined);
  let resets = 0;
  const { tree } = render({ onReset: () => (resets += 1) });
  const reset = one(tree, "bird-weight-reset");
  assert.ok(reset);
  assert.deepEqual(gatherText(reset), ["Reset"]);
  act(() => (reset.props!.onPress as () => void)());
  assert.equal(resets, 1);
});
