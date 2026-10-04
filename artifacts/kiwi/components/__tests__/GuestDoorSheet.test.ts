// Resub C1 — the door sheet says the right thing on each platform. The copy
// decision is lib/guest/doors.ts doorCopy (tested there); this pins that the
// SHEET asks it with the running platform rather than rendering the web lines
// everywhere.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Platform } from "react-native";

import { GuestDoorSheet } from "../GuestDoorSheet";
import { DOOR_APP_NOTE, DOOR_INTRO, DOOR_NATIVE_INTRO, DOOR_NATIVE_NOTE } from "../../lib/guest/doors";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

const platform = Platform as unknown as { OS: string };
const realOS = platform.OS;

let active: TestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => {
      r.unmount();
    });
  }
});

after(() => {
  platform.OS = realOS;
});

function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}

async function sheetText(os: string): Promise<string> {
  platform.OS = os;
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(GuestDoorSheet, { action: "grocery_list", onClose: () => {} }),
    );
  });
  active = r;
  return textOf(r.toJSON() as unknown as Node);
}

test("🔴 iOS: the native door — account made here, no 'app comes right after'", async () => {
  const text = await sheetText("ios");
  assert.ok(text.includes(DOOR_NATIVE_INTRO));
  assert.ok(text.includes(DOOR_NATIVE_NOTE));
  assert.ok(!text.includes(DOOR_APP_NOTE));
});

test("Android: the native door too", async () => {
  const text = await sheetText("android");
  assert.ok(text.includes(DOOR_NATIVE_NOTE));
  assert.ok(!text.includes(DOOR_APP_NOTE));
});

test("web: the web door, unchanged", async () => {
  const text = await sheetText("web");
  assert.ok(text.includes(DOOR_INTRO));
  assert.ok(text.includes(DOOR_APP_NOTE));
  assert.ok(!text.includes(DOOR_NATIVE_NOTE));
});
