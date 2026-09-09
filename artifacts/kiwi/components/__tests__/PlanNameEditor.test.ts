// WS9-2 2e Part 4 Item 1 — PlanNameEditor.
//
// This component had NO test file, and it is the one testable half of Item 1:
// app/plan/[id].tsx is outside the runner's glob (D-WS9-164), so the header
// band's layout cannot be pinned at all — but the two things that actually
// broke or could break here live in this component and CAN be.
//
//   1. THE LINE POLICY. Item 1's whole defect was "Italian Comfort mee…" —
//      variant="slim" caps at one line and ellipsizes. It is now "hero", which
//      is uncapped. A later "tidy" back to slim restores the bug silently, and
//      nothing else in the suite would notice.
//   2. INLINE TAP-TO-EDIT, which PRD §8.3.1 locks. Item 1 moved this component
//      out of a row wrapper and onto its own full-width line; the risk of that
//      move is the edit affordance quietly not surviving it.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { PlanNameEditor } from "../PlanNameEditor";
import { Typography } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function render(props: React.ComponentProps<typeof PlanNameEditor>) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(PlanNameEditor, props));
  });
  return {
    tree,
    json: () => tree.toJSON() as unknown as Json,
  };
}

function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => walk(c))
    : [];
  return [node, ...kids];
}

function byType(root: Json, type: string): Json[] {
  return walk(root).filter((n) => n.type === type);
}

function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  const parts = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...parts.filter(Boolean));
}

/** The rendered name Text (display mode has exactly one). */
function nameNode(root: Json): Json {
  const texts = byType(root, "rn-text");
  assert.ok(texts.length >= 1, "name Text node found");
  return texts[0];
}

/** ⚠️ toJSON() hoists a Text's string content into `children`, NOT into
 *  `props.children` — reading the prop yields undefined and quietly "passes"
 *  any assertion written as a not-equal. */
function textContent(n: Json): string {
  return (n.children ?? []).filter((c): c is string => typeof c === "string").join("");
}

const LONG_NAME = "Italian Comfort meets Weeknight Speed and Sunday Leftovers";

// ── 1. the line policy ──────────────────────────────────────────────────────

test("Item 1: the plan name is UNCAPPED — it wraps, it does not ellipsize", () => {
  // The defect this closes rendered as "Italian Comfort mee…" at the top of
  // Plan Review. variant="hero" maps to numberOfLines: undefined.
  const { json } = render({ currentName: LONG_NAME, onSave: () => {} });
  const name = nameNode(json());
  assert.equal(
    name.props.numberOfLines,
    undefined,
    "a numberOfLines cap is exactly the truncation Item 1 removed",
  );
  assert.equal(
    name.props.ellipsizeMode,
    undefined,
    "DisplayTitle only sets ellipsizeMode when the variant caps lines",
  );
  assert.equal(textContent(name), LONG_NAME, "and the whole name renders");
});

test("Item 1: the line-policy change did NOT move the type", () => {
  // DisplayTitle deliberately does not own typography, so slim → hero must be
  // a line-count change and nothing else. If these values drift, the "visible
  // size jump" that was explicitly NOT part of this item happened by accident.
  const s = flatten(nameNode(render({ currentName: "X", onSave: () => {} }).json()).props.style);
  assert.equal(s.fontSize, Typography.fontSize.lg, "17px, unchanged");
  assert.equal(s.fontFamily, Typography.face.serif[600]);
  assert.equal(s.fontWeight, Typography.fontWeight.semibold);
});

// ── 2. inline tap-to-edit (PRD §8.3.1, locked) ──────────────────────────────

test("§8.3.1: display mode is a tap target, and tapping it opens the input", () => {
  const { tree, json } = render({ currentName: "Spice It Up", onSave: () => {} });
  assert.equal(byType(json(), "rn-text-input").length, 0, "starts read-only");

  const trigger = byType(json(), "rn-pressable")[0];
  assert.ok(trigger, "tap-to-edit trigger found");
  act(() => {
    (trigger.props.onPress as () => void)();
  });

  const input = byType(tree.toJSON() as unknown as Json, "rn-text-input")[0];
  assert.ok(input, "tapping the name opens an inline TextInput");
  assert.equal(input.props.value, "Spice It Up", "seeded with the current name");
  assert.equal(input.props.autoFocus, true);
});

test("§8.3.1: the inline input keeps flex:1 — it must fill its row, not collapse", () => {
  // Item 1 removed the s.titleCol wrapper that used to re-supply column stretch
  // inside a ROW parent. flex:1 here is the half of that invariant this
  // component owns; if it goes, a short name renders a hairline-wide input.
  const { tree, json } = render({ currentName: "Hi", onSave: () => {} });
  act(() => {
    (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
  });
  const input = byType(tree.toJSON() as unknown as Json, "rn-text-input")[0];
  assert.equal(flatten(input.props.style).flex, 1);
});

test("§8.3.1: committing a changed name calls onSave with the trimmed value", () => {
  const saved: string[] = [];
  const { tree, json } = render({
    currentName: "Spice It Up",
    onSave: (n) => saved.push(n),
  });
  act(() => {
    (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
  });
  const input = byType(tree.toJSON() as unknown as Json, "rn-text-input")[0];
  act(() => {
    (input.props.onChangeText as (t: string) => void)("  Weeknight Speed  ");
  });
  act(() => {
    (
      (tree.toJSON() as unknown as Json) &&
      (byType(tree.toJSON() as unknown as Json, "rn-text-input")[0].props
        .onSubmitEditing as () => void)
    )();
  });
  assert.deepEqual(saved, ["Weeknight Speed"]);
  assert.equal(
    byType(tree.toJSON() as unknown as Json, "rn-text-input").length,
    0,
    "and the editor closes back to display mode",
  );
});

test("§8.3.1: a blank name does NOT save — it reverts", () => {
  const saved: string[] = [];
  const { tree, json } = render({
    currentName: "Spice It Up",
    onSave: (n) => saved.push(n),
  });
  act(() => {
    (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
  });
  act(() => {
    (
      byType(tree.toJSON() as unknown as Json, "rn-text-input")[0].props
        .onChangeText as (t: string) => void
    )("   ");
  });
  act(() => {
    (
      byType(tree.toJSON() as unknown as Json, "rn-text-input")[0].props
        .onBlur as () => void
    )();
  });
  assert.deepEqual(saved, [], "a whitespace-only name is not a rename");
  assert.equal(
    textContent(nameNode(tree.toJSON() as unknown as Json)),
    "Spice It Up",
    "the old name is restored",
  );
});

test("§8.3.1: committing an UNCHANGED name does not fire a write", () => {
  const saved: string[] = [];
  const { tree, json } = render({
    currentName: "Spice It Up",
    onSave: (n) => saved.push(n),
  });
  act(() => {
    (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
  });
  act(() => {
    (
      byType(tree.toJSON() as unknown as Json, "rn-text-input")[0].props
        .onBlur as () => void
    )();
  });
  assert.deepEqual(saved, []);
});

// WS9 BUG-238 — the same-tick double-fire family, third instance.
//
// PlanNameEditor wires BOTH onBlur and onSubmitEditing to `commit`, with
// `blurOnSubmit` at its default of true: pressing "done" submits AND blurs, so
// one tap dispatches `commit` twice against the SAME element instance, before
// React has re-rendered. Unlike profile.tsx (BUG-236) and grocery-list
// (BUG-117) this handler had NO guard at all, so both calls saw the same
// closure `draftName`/`currentName` and both called onSave.
//
// The existing tests above invoke onSubmitEditing OR onBlur, never both in
// sequence, which is exactly the blind spot.
test("§8.3.1 / BUG-238: 'done' fires onSubmitEditing AND onBlur — ONE rename, not two", () => {
  const saved: string[] = [];
  const { tree, json } = render({
    currentName: "Spice It Up",
    onSave: (n) => saved.push(n),
  });
  act(() => {
    (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
  });
  act(() => {
    (
      byType(tree.toJSON() as unknown as Json, "rn-text-input")[0].props
        .onChangeText as (t: string) => void
    )("Weeknight Speed");
  });

  // Both handlers come off the SAME live element, and both are invoked inside
  // one act() so React cannot re-render between them — that is what "same
  // tick" means on the device.
  const live = byType(tree.toJSON() as unknown as Json, "rn-text-input")[0];
  const onSubmitEditing = live.props.onSubmitEditing as () => void;
  const onBlur = live.props.onBlur as () => void;
  act(() => {
    onSubmitEditing();
    onBlur();
  });

  assert.deepEqual(
    saved,
    ["Weeknight Speed"],
    "one tap on done must produce ONE rename",
  );
});

// WS9 BUG-238 — the failure mode the ref latch itself can introduce. If any
// write to `editing` forgets to write `editingRef`, the row commits once and
// is then permanently uneditable. A single happy-path rename would not show it.
test("BUG-238: the ref latch re-arms — two consecutive renames both save", () => {
  const saved: string[] = [];
  let name = "Spice It Up";
  const { tree, json } = render({
    currentName: name,
    onSave: (n) => {
      saved.push(n);
      name = n;
    },
  });

  for (const next of ["Weeknight Speed", "Sunday Slow"]) {
    act(() => {
      (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
    });
    act(() => {
      (
        byType(tree.toJSON() as unknown as Json, "rn-text-input")[0].props
          .onChangeText as (t: string) => void
      )(next);
    });
    const live = byType(tree.toJSON() as unknown as Json, "rn-text-input")[0];
    const onSubmitEditing = live.props.onSubmitEditing as () => void;
    const onBlur = live.props.onBlur as () => void;
    act(() => {
      onSubmitEditing();
      onBlur();
    });
  }

  assert.deepEqual(saved, ["Weeknight Speed", "Sunday Slow"]);
});

// WS9 BUG-238 — the DEVICE TIMING model, and the process lesson behind it.
//
// The test above invokes onSubmitEditing and onBlur back-to-back inside ONE
// act(), so React cannot re-render between them. The device does not do that:
// a server log of two renames showed four PATCHes, paired 207ms and 227ms
// apart. A fifth of a second is a keyboard-dismiss animation, not two
// dispatches in one tick — so a synchronous test cannot see whatever produces
// it, and a guard whose timing model does not match the device is the same
// class of defect as an assertion that reads the constant it is testing.
//
// ⚠️ THIS TEST DOES NOT REPRODUCE THAT DEVICE SYMPTOM. It was written to, and
// it passes. That is a REPORTED RESULT, not a claim of coverage: it proves the
// ref latch holds across a real gap AND across the prop change the optimistic
// plan-cache write produces, which is what rules the latch OUT as the cause.
// Whatever fires the second PATCH is not this guard. Do not read it as
// "BUG-238 is device-clear".
for (const optimisticSave of [false, true]) {
  test(`BUG-238 device timing (optimistic onSave = ${optimisticSave}): submit, re-render, blur ~220ms later`, async () => {
    const saved: string[] = [];
    let name = "Spice It Up";
    let tree!: TestRenderer.ReactTestRenderer;
    const draw = () =>
      act(() => {
        const el = React.createElement(PlanNameEditor, {
          currentName: name,
          onSave: (n: string) => {
            saved.push(n);
            // The real onSave optimistically rewrites the plan cache, so
            // `currentName` changes underneath the component. The original
            // test's onSave never did, which hid a second variable.
            if (optimisticSave) {
              name = n;
              draw();
            }
          },
        });
        if (!tree) tree = TestRenderer.create(el);
        else tree.update(el);
      });
    draw();
    const json = () => tree.toJSON() as unknown as Json;

    act(() => {
      (byType(json(), "rn-pressable")[0].props.onPress as () => void)();
    });
    act(() => {
      (byType(json(), "rn-text-input")[0].props.onChangeText as (
        t: string,
      ) => void)("Weeknight Speed");
    });

    const live = byType(json(), "rn-text-input")[0];
    const onSubmitEditing = live.props.onSubmitEditing as () => void;
    const onBlur = live.props.onBlur as () => void;

    act(() => {
      onSubmitEditing();
    });
    // The gap the device actually produces. The handler below is the STALE
    // one, captured from the render before the editor closed — which is
    // exactly what a late native blur would be holding.
    await new Promise((r) => setTimeout(r, 220));
    act(() => {
      onBlur();
    });

    assert.deepEqual(saved, ["Weeknight Speed"]);
  });
}
