// WS9 D-WS9-206 / D-WS9-207 — the shared dietary block.
//
// WHY THESE ASSERTIONS AND NOT OTHERS. The four screens that render this block
// (preferences.tsx, onboarding-prefs.tsx, wizard.tsx, tellkiwi.tsx) all live
// under app/, which is OUTSIDE this runner's glob (D-WS9-164) — no screen file
// is covered end-to-end, and device testing is the real gate. What CAN be
// pinned is the extracted component, and the three things pinned here are the
// three that already went wrong once in the duplicated chrome this replaces:
//
//   1. THE DOUBLED HEADING. BUG-196 moved "Allergies & avoidances" into
//      AllergiesPicker's ExpandLink and deleted the orphan <SubLabel> in
//      preferences.tsx ONLY. Three screens kept their hand-rolled <Text> and
//      shipped the heading twice. Nothing in the suite noticed, because the
//      duplicate lived in a screen file. It lives here now, so it is testable.
//   2. THE PLACEHOLDER CONTRAST. BUG-154's measured value likewise landed on
//      one screen. A "tidy" back to the muted token would go silently.
//   3. PER-RUN vs PERSISTENT. wizard and tellkiwi must never write this block
//      back to /me/preferences. The component is the shared surface, so the
//      guard that belongs here is that it OWNS no persistence at all — it can
//      only call the handlers it is given.
//
// Every assertion below reads the LIVE value out of the rendered tree (or out
// of the token module) and compares it to a literal written independently. A
// deliberate break was applied to each and the red output is in the report.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  DietarySection,
  DIETARY_NOTES_PLACEHOLDER,
  OTHER_ALLERGIES_FIELD_ENABLED,
} from "../DietarySection";
import { ALLERGIES_AND_AVOIDANCES } from "@/lib/domain";
import { Colors } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

type Calls = {
  eatingStyles: string[][];
  allergies: string[][];
  otherAllergies: string[][];
  dietaryNotes: string[];
};

function render(over: Partial<React.ComponentProps<typeof DietarySection>> = {}) {
  const calls: Calls = {
    eatingStyles: [],
    allergies: [],
    otherAllergies: [],
    dietaryNotes: [],
  };
  const props: React.ComponentProps<typeof DietarySection> = {
    eatingStyles: [],
    onEatingStylesChange: (n) => calls.eatingStyles.push(n),
    allergies: [],
    onAllergiesChange: (n) => calls.allergies.push(n),
    otherAllergies: [],
    onOtherAllergiesChange: (n) => calls.otherAllergies.push(n),
    dietaryNotes: "",
    onDietaryNotesChange: (v) => calls.dietaryNotes.push(v),
    ...over,
  };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(DietarySection, props));
  });
  return { tree, calls, json: () => tree.toJSON() as unknown as Json };
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

/** The "Anything else?" input. It is the LAST TextInput in the block in both
 *  gate states (the dark other-allergies input renders ABOVE it), so these
 *  assertions stay valid when OTHER_ALLERGIES_FIELD_ENABLED flips — the flip
 *  should cost one test update (the ship gate), not four. */
function notesInput(root: Json): Json {
  const inputs = byType(root, "rn-text-input");
  assert.ok(inputs.length >= 1, "the notes input renders");
  return inputs[inputs.length - 1];
}

/** Every string rendered anywhere in the tree, flattened. */
function texts(root: Json): string[] {
  return walk(root).flatMap((n) =>
    Array.isArray(n.children)
      ? n.children.filter((c): c is string => typeof c === "string")
      : [],
  );
}

// ── 1. Exactly one allergies heading ───────────────────────────────────────

test("exactly ONE 'Allergies & avoidances' heading renders (BUG-196 regression guard)", () => {
  const { json } = render();
  const all = texts(json());
  const hits = all.filter((t) => t === "Allergies & avoidances");
  // The picker's own ExpandLink label is the heading. A <Text> heading above it
  // — which is what onboarding-prefs, wizard and tellkiwi each carried — makes
  // this 2.
  assert.equal(
    hits.length,
    1,
    `expected 1 "Allergies & avoidances", found ${hits.length}: ${JSON.stringify(all)}`,
  );
});

test("the one heading is the picker's expander, not a plain label", () => {
  const { json, tree } = render();
  // Collapsed: the 11 chips are hidden behind the expander, so none render.
  const beforeLabels = texts(json());
  for (const a of ALLERGIES_AND_AVOIDANCES) {
    assert.ok(
      !beforeLabels.includes(a),
      `"${a}" rendered while the section is collapsed`,
    );
  }
  // Press the element carrying the heading text. If the heading were an inert
  // <Text>, there would be nothing to press and the chips would never appear.
  const pressables = walk(json()).filter(
    (n) => typeof n.props?.onPress === "function",
  );
  const expander = pressables.find((n) =>
    texts(n).includes("Allergies & avoidances"),
  );
  assert.ok(expander, "the heading text is inside a pressable");
  act(() => {
    (expander!.props.onPress as () => void)();
  });
  const afterLabels = texts(tree.toJSON() as unknown as Json);
  for (const a of ALLERGIES_AND_AVOIDANCES) {
    assert.ok(afterLabels.includes(a), `"${a}" missing after expanding`);
  }
});

// ── 2. Placeholder: the AA value and the corrected copy ────────────────────

test("the dietary-notes placeholder renders BUG-154's neutral[700], not the muted token", () => {
  const { json } = render();
  const input = notesInput(json());
  // Read the live prop, compare to an independently written literal — the hex
  // BUG-154 measured at 6.2999:1 on the white card. Colors.neutral[700] is
  // asserted to BE that hex separately, so neither side is a tautology.
  assert.equal(input.props.placeholderTextColor, "#6B5E4D");
  assert.equal(Colors.neutral[700], "#6B5E4D");
});

test("the placeholder examples are PREFERENCES, not allergies (tellkiwi's 'no shellfish' is gone)", () => {
  const { json } = render();
  const placeholder = notesInput(json()).props.placeholder as string;
  assert.equal(placeholder, DIETARY_NOTES_PLACEHOLDER);
  // Under D-WS9-206's split, shellfish is an ALLERGY — an example naming it in
  // the preferences box points the user at the wrong field.
  assert.ok(
    !placeholder.toLowerCase().includes("shellfish"),
    `preference placeholder names an allergy: ${placeholder}`,
  );
  for (const example of ["cilantro", "veal", "soft cheese"]) {
    assert.ok(
      placeholder.includes(example),
      `Hans's example "${example}" missing from ${placeholder}`,
    );
  }
});

// ── 3. No "(Optional)" badge on any screen ─────────────────────────────────

test("no '(Optional)' badge — it existed on onboarding-prefs alone and is dropped", () => {
  const { json } = render();
  const all = texts(json());
  assert.ok(
    !all.some((t) => t.includes("(Optional)")),
    `an "(Optional)" badge rendered: ${JSON.stringify(all)}`,
  );
});

// ── 4. The ship gate ───────────────────────────────────────────────────────

test("SHIP GATE — the other-allergies field does NOT render", () => {
  assert.equal(
    OTHER_ALLERGIES_FIELD_ENABLED,
    false,
    "the flag is on; nothing honours free-text allergy terms yet",
  );
  const { json } = render({ otherAllergies: ["kiwi", "cinnamon"] });
  const all = texts(json());
  // Not merely "the label is absent" — the VALUES must not surface either, or a
  // stored term would appear as a chip with no label explaining it.
  assert.ok(!all.includes("Any other allergies?"), "the dark label rendered");
  assert.ok(!all.includes("kiwi"), "a stored other-allergy rendered as a chip");
  assert.ok(!all.includes("cinnamon"), "a stored other-allergy rendered");
  // And exactly one TextInput: "Anything else?". A second one means the dark
  // field's add-input leaked.
  assert.equal(byType(json(), "rn-text-input").length, 1);
});

// ── 5. Persistence: the component owns none ────────────────────────────────

test("PER-RUN SAFE — the component performs no writes; every change exits via a handler", () => {
  const { json, calls, tree } = render();
  // Type into the notes field.
  const input = notesInput(json());
  act(() => {
    (input.props.onChangeText as (v: string) => void)("no soft cheese");
  });
  assert.deepEqual(calls.dietaryNotes, ["no soft cheese"]);

  // Expand the allergies section and tap a chip.
  const expander = walk(tree.toJSON() as unknown as Json)
    .filter((n) => typeof n.props?.onPress === "function")
    .find((n) => texts(n).includes("Allergies & avoidances"))!;
  act(() => {
    (expander.props.onPress as () => void)();
  });
  const chip = walk(tree.toJSON() as unknown as Json)
    .filter((n) => typeof n.props?.onPress === "function")
    .find((n) => texts(n).includes("Nut-free"))!;
  act(() => {
    (chip.props.onPress as () => void)();
  });
  assert.deepEqual(calls.allergies, [["Nut-free"]]);

  // The screen owns the transport. The component's whole persistence surface is
  // these callbacks, so wizard/tellkiwi passing per-run setters is sufficient
  // for "changes apply to this plan only" — there is no other write path to
  // sever.
  assert.equal(calls.eatingStyles.length, 0);
  assert.equal(calls.otherAllergies.length, 0);
});

test("controlled: the rendered value is the prop, never internal state", () => {
  const { json } = render({ dietaryNotes: "lower sodium" });
  assert.equal(notesInput(json()).props.value, "lower sodium");
});
