// WS7-6 B-fix Block 3 — SortDropdown disabled-key behavior.
// A key listed in `disabledKeys` renders greyed and is NOT selectable: its
// option Pressable carries disabled=true and tapping it must not fire
// onChange. Enabled keys still select normally.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";

import { SortDropdown, type SortKey } from "../SortDropdown";
import {
  PLAN_DISABLED_SORT_KEYS,
  PLAN_HIDDEN_SORT_KEYS,
} from "../../lib/plans/sortMapping";
import { MEAL_DISABLED_SORT_KEYS } from "../../lib/meals/sortMapping";

// Gather all descendant text of a test instance into one string.
function textOf(instance: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  for (const t of instance.findAllByType(Text)) {
    const ch = t.props.children;
    if (typeof ch === "string") parts.push(ch);
    else if (Array.isArray(ch))
      parts.push(ch.filter((c) => typeof c === "string").join(""));
  }
  return parts.join(" ");
}

// Render the dropdown, open the menu, return the option Pressables keyed by
// the label text they contain.
async function openMenu(props: {
  value: SortKey;
  onChange: (k: SortKey) => void;
  disabledKeys?: readonly SortKey[];
  hiddenKeys?: readonly SortKey[];
}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(SortDropdown, props));
  });
  // First Pressable is the trigger — press to open the menu.
  const trigger = renderer.root.findAllByType(Pressable)[0];
  await act(async () => {
    trigger.props.onPress({});
  });
  return renderer;
}

// Option rows are the only Pressables carrying an accessibilityState with a
// `selected` flag (the trigger shows the current label but has no such state,
// and the backdrop has an accessibilityLabel instead).
function optionPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Pressable)
    .filter(
      (p) =>
        p.props.accessibilityState != null &&
        "selected" in p.props.accessibilityState,
    );
}

// The visible option labels, in render order.
function optionLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return optionPressables(renderer).map((p) => textOf(p).trim());
}

test("SortDropdown: menu is hidden until opened, then renders all options in the Modal", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SortDropdown, {
        value: "alpha" as SortKey,
        onChange: () => {},
        disabledKeys: ["last_cooked"],
      }),
    );
  });
  // Closed: only the trigger Pressable exists, no option labels rendered.
  assert.equal(optionPressables(renderer).length, 0, "menu rendered while closed");

  const trigger = renderer.root.findAllByType(Pressable)[0];
  await act(async () => {
    trigger.props.onPress({});
  });
  // Open: all five options present (in the Modal portal).
  assert.equal(optionPressables(renderer).length, 5, "all options should render");
  renderer.unmount();
});

test("SortDropdown: tapping the backdrop closes the menu", async () => {
  const renderer = await openMenu({
    value: "alpha",
    onChange: () => {},
    disabledKeys: ["last_cooked"],
  });
  assert.equal(optionPressables(renderer).length, 5);

  // The backdrop is the Pressable labeled for dismissal.
  const backdrop = renderer.root
    .findAllByType(Pressable)
    .find((p) => p.props.accessibilityLabel === "Close sort menu");
  assert.ok(backdrop, "backdrop not found");
  await act(async () => {
    backdrop!.props.onPress({});
  });
  assert.equal(optionPressables(renderer).length, 0, "menu should close");
  renderer.unmount();
});

test("SortDropdown: a disabledKey option is non-selectable (disabled=true, no onChange)", async () => {
  const picked: SortKey[] = [];
  const renderer = await openMenu({
    value: "alpha",
    onChange: (k) => picked.push(k),
    disabledKeys: ["last_cooked"],
  });

  const pressables = renderer.root.findAllByType(Pressable);
  // Find the "Last cooked" option Pressable.
  const lastCooked = pressables.find((p) => textOf(p).includes("Last cooked"));
  assert.ok(lastCooked, "Last cooked option not rendered");
  assert.equal(
    lastCooked!.props.disabled,
    true,
    "disabled key should set disabled=true",
  );
  assert.equal(lastCooked!.props.accessibilityState?.disabled, true);

  // Tapping it must NOT fire onChange (the handler guards on disabled).
  await act(async () => {
    lastCooked!.props.onPress({});
  });
  assert.deepEqual(picked, [], "disabled option must not select");

  renderer.unmount();
});

test("SortDropdown: an enabled option selects normally", async () => {
  const picked: SortKey[] = [];
  const renderer = await openMenu({
    value: "alpha",
    onChange: (k) => picked.push(k),
    disabledKeys: ["last_cooked"],
  });

  const pressables = renderer.root.findAllByType(Pressable);
  const timesCooked = pressables.find((p) =>
    textOf(p).includes("Times cooked"),
  );
  assert.ok(timesCooked, "Times cooked option not rendered");
  assert.notEqual(timesCooked!.props.disabled, true);

  await act(async () => {
    timesCooked!.props.onPress({});
  });
  assert.deepEqual(picked, ["times_cooked"]);

  renderer.unmount();
});

// ── WS9-2 BUG-075 — the sort-context constants + the hiddenKeys mechanism ──

test("sort-context constants: plans hide cook_time + grey the cook stats; meals grey the cook stats", () => {
  assert.deepEqual([...PLAN_HIDDEN_SORT_KEYS], ["cook_time"]);
  assert.deepEqual([...PLAN_DISABLED_SORT_KEYS], ["last_cooked", "times_cooked"]);
  assert.deepEqual([...MEAL_DISABLED_SORT_KEYS], ["last_cooked", "times_cooked"]);
});

test("SortDropdown (no hiddenKeys): default order is unchanged — all five keys in canon order", async () => {
  const renderer = await openMenu({ value: "alpha", onChange: () => {} });
  assert.deepEqual(optionLabels(renderer), [
    "Last cooked",
    "Times cooked",
    "Date added",
    "A–Z",
    "Cook time",
  ]);
  renderer.unmount();
});

test("SortDropdown (plans context): cook_time is ABSENT from the menu, order otherwise preserved", async () => {
  const renderer = await openMenu({
    value: "alpha",
    onChange: () => {},
    hiddenKeys: PLAN_HIDDEN_SORT_KEYS,
    disabledKeys: PLAN_DISABLED_SORT_KEYS,
  });
  // Four options — cook_time dropped entirely (not just greyed).
  assert.equal(optionPressables(renderer).length, 4);
  assert.deepEqual(optionLabels(renderer), [
    "Last cooked",
    "Times cooked",
    "Date added",
    "A–Z",
  ]);
  const labels = optionLabels(renderer).join(" ");
  assert.ok(!labels.includes("Cook time"), "Cook time must not render for plans");
  renderer.unmount();
});

test("SortDropdown (plans context): last_cooked + times_cooked greyed; date_created + alpha selectable", async () => {
  const picked: SortKey[] = [];
  const renderer = await openMenu({
    value: "alpha",
    onChange: (k) => picked.push(k),
    hiddenKeys: PLAN_HIDDEN_SORT_KEYS,
    disabledKeys: PLAN_DISABLED_SORT_KEYS,
  });
  const byLabel = (label: string) =>
    renderer.root
      .findAllByType(Pressable)
      .find((p) => textOf(p).trim() === label);

  assert.equal(byLabel("Last cooked")!.props.disabled, true);
  assert.equal(byLabel("Times cooked")!.props.disabled, true);

  const dateAdded = byLabel("Date added");
  assert.notEqual(dateAdded!.props.disabled, true);
  await act(async () => {
    dateAdded!.props.onPress({});
  });
  assert.deepEqual(picked, ["date_created"], "Date added must select");

  // A–Z is also live (re-open: the first select closed the menu).
  const renderer2 = await openMenu({
    value: "date_created",
    onChange: (k) => picked.push(k),
    hiddenKeys: PLAN_HIDDEN_SORT_KEYS,
    disabledKeys: PLAN_DISABLED_SORT_KEYS,
  });
  const alpha = renderer2.root
    .findAllByType(Pressable)
    .find((p) => textOf(p).trim() === "A–Z");
  assert.notEqual(alpha!.props.disabled, true);
  await act(async () => {
    alpha!.props.onPress({});
  });
  assert.deepEqual(picked, ["date_created", "alpha"]);

  renderer.unmount();
  renderer2.unmount();
});

test("SortDropdown (meal context): cook_time stays live, only the cook stats grey", async () => {
  const picked: SortKey[] = [];
  const renderer = await openMenu({
    value: "alpha",
    onChange: (k) => picked.push(k),
    disabledKeys: MEAL_DISABLED_SORT_KEYS,
  });
  // All five present in meal context — cook_time is NOT hidden here.
  assert.equal(optionPressables(renderer).length, 5);
  const byLabel = (label: string) =>
    renderer.root
      .findAllByType(Pressable)
      .find((p) => textOf(p).trim() === label);

  assert.equal(byLabel("Last cooked")!.props.disabled, true);
  assert.equal(byLabel("Times cooked")!.props.disabled, true);

  const cookTime = byLabel("Cook time");
  assert.notEqual(cookTime!.props.disabled, true, "cook_time must stay live for meals");
  await act(async () => {
    cookTime!.props.onPress({});
  });
  assert.deepEqual(picked, ["cook_time"]);

  renderer.unmount();
});
