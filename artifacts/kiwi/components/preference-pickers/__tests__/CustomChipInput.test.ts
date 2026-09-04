// WS9 D-WS9-206 — CustomChipInput, and the RecurringItemsPicker refactor that
// produced it.
//
// WHY THIS FILE EXISTS. The other-allergies field needs a chip-row-over-an-
// add-input, and RecurringItemsPicker already WAS one. §27.2 says extract, not
// re-implement — but RecurringItemsPicker had no render test at all (only
// recurringChipRow.test.ts, which covers the pure composition helper and would
// stay green through any amount of JSX damage). Lifting untested JSX out of a
// shipped picker with nothing watching is how a refactor eats a feature
// quietly, so the extraction brings its own guard.
//
// The invariants pinned are the two BUG-152 bought and the one the extraction
// itself could break:
//   - the chip row sits ABOVE the input (BUG-152: "the added chip lands where
//     the tap did" — the whole point of that fix was proximity)
//   - a custom entry reaches the chip row
//   - RecurringItemsPicker's placeholder colour did NOT move. The extraction
//     defaults it to the app token; only the dietary consumer overrides.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { RecurringItemsPicker } from "../RecurringItemsPicker";
import { CustomChipInput } from "../shared";
import { COMMON_RECURRING_ITEMS } from "@/lib/domain";
import { Palette } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => walk(c))
    : [];
  return [node, ...kids];
}

function texts(root: Json): string[] {
  return walk(root).flatMap((n) =>
    Array.isArray(n.children)
      ? n.children.filter((c): c is string => typeof c === "string")
      : [],
  );
}

function renderPicker(value: string[]) {
  const changes: string[][] = [];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(RecurringItemsPicker, {
        value,
        onChange: (n: string[]) => changes.push(n),
      }),
    );
  });
  return { tree, changes, json: () => tree.toJSON() as unknown as Json };
}

test("RecurringItemsPicker still renders every common item as a chip after the extraction", () => {
  const { json } = renderPicker([]);
  const rendered = texts(json());
  for (const item of COMMON_RECURRING_ITEMS) {
    assert.ok(rendered.includes(item), `common item "${item}" lost its chip`);
  }
});

test("a custom value renders as a chip alongside the commons (BUG-152)", () => {
  const { json } = renderPicker(["lime"]);
  assert.ok(texts(json()).includes("lime"), "custom item lost its chip");
});

test("BUG-152 PROXIMITY — the chip row renders BEFORE the input, not after", () => {
  const { json } = renderPicker(["lime"]);
  const flat = walk(json());
  const inputIndex = flat.findIndex((n) => n.type === "rn-text-input");
  const chipIndex = flat.findIndex((n) => texts(n).includes("lime"));
  assert.ok(inputIndex >= 0, "the add input renders");
  assert.ok(chipIndex >= 0, "the custom chip renders");
  assert.ok(
    chipIndex < inputIndex,
    "the chip row moved BELOW the input — BUG-152's whole fix was that the " +
      "added chip lands where the tap did",
  );
});

test("RecurringItemsPicker's placeholder colour did NOT move in the extraction", () => {
  const { json } = renderPicker([]);
  const input = walk(json()).find((n) => n.type === "rn-text-input")!;
  // The app token, unchanged — #776D5D, 5.0849:1 on the white card. The dietary
  // block overrides to neutral[700]; this one must not have followed it.
  assert.equal(input.props.placeholderTextColor, "#776D5D");
  assert.equal(Palette.text.placeholder, "#776D5D");
});

test("typing then submitting emits the trimmed term through onAdd, once", () => {
  const added: string[] = [];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(CustomChipInput, {
        chips: [],
        value: [],
        onToggle: () => {},
        onAdd: (i: string) => added.push(i),
        placeholder: "Add...",
        addAccessibilityLabel: "Add",
      }),
    );
  });
  const input = walk(tree.toJSON() as unknown as Json).find(
    (n) => n.type === "rn-text-input",
  )!;
  act(() => {
    (input.props.onChangeText as (v: string) => void)("  cinnamon  ");
  });
  act(() => {
    (
      walk(tree.toJSON() as unknown as Json).find(
        (n) => n.type === "rn-text-input",
      )!.props.onSubmitEditing as () => void
    )();
  });
  assert.deepEqual(added, ["cinnamon"]);
});

test("a blank draft adds nothing", () => {
  const added: string[] = [];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(CustomChipInput, {
        chips: [],
        value: [],
        onToggle: () => {},
        onAdd: (i: string) => added.push(i),
        placeholder: "Add...",
        addAccessibilityLabel: "Add",
      }),
    );
  });
  const input = walk(tree.toJSON() as unknown as Json).find(
    (n) => n.type === "rn-text-input",
  )!;
  act(() => {
    (input.props.onChangeText as (v: string) => void)("   ");
  });
  act(() => {
    (input.props.onSubmitEditing as () => void)();
  });
  assert.deepEqual(added, []);
});
