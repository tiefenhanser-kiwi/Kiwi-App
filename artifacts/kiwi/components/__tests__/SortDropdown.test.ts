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
