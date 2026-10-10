// WEB-1 Part A — lib/dialog.ts + components/DialogHost.tsx.
//
// react-native-web's Alert is an empty stub, so on web every confirm in the
// app was a silent no-op. dialog.alert queues a request that DialogHost
// renders; on native it passes straight through to Alert.alert. Both halves
// are pinned here: the web store + host (open → buttons in order → press →
// its onPress fires → closed; a queue of two; the cancelable scrim), and the
// native pass-through.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Platform, __setAlertHandler } from "react-native";

import { DialogHost } from "../DialogHost";
import { Palette } from "@/constants/tokens";
import {
  __resetDialogsForTests,
  currentDialog,
  dialog,
  dismissDialog,
  enterTarget,
} from "@/lib/dialog";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}
function allText(node: Json | string | null): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}
function byTestId(tree: Json | null, id: string): Json | undefined {
  return walk(tree).find((n) => n.props?.testID === id);
}
function buttonLabels(tree: Json | null): string[] {
  return walk(tree)
    .filter((n) => typeof n.props?.testID === "string" && (n.props.testID as string).startsWith("dialog-button-"))
    .map((n) => allText(n).join(""));
}
function press(tree: Json | null, id: string) {
  const node = byTestId(tree, id);
  assert.ok(node, `no node with testID ${id}`);
  act(() => {
    (node!.props.onPress as () => void)();
  });
}

const rnPlatform = Platform as { OS: string };
const originalOS = rnPlatform.OS;

beforeEach(() => {
  rnPlatform.OS = "web";
  __resetDialogsForTests();
});
afterEach(() => {
  rnPlatform.OS = originalOS;
  __setAlertHandler(null);
  __resetDialogsForTests();
});

function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(React.createElement(DialogHost));
  });
  return r;
}

test("nothing queued → the host renders nothing", () => {
  const r = mount();
  assert.equal(r.toJSON(), null);
});

test("open → title, body and buttons in the caller's order → press → its onPress fires → closed", () => {
  const r = mount();
  const fired: string[] = [];
  act(() => {
    dialog.alert("Compost this meal?", "It leaves this plan.", [
      { text: "Cancel", style: "cancel", onPress: () => fired.push("cancel") },
      { text: "Compost", style: "destructive", onPress: () => fired.push("compost") },
    ]);
  });
  const tree = r.toJSON() as Json;
  const text = allText(tree);
  assert.ok(text.includes("Compost this meal?"));
  assert.ok(text.includes("It leaves this plan."));
  assert.deepEqual(buttonLabels(tree), ["Cancel", "Compost"]);
  // Variants: cancel → secondary (ink label), destructive → terracotta fill
  // (Button primary, white label). Read off the label colour — Button's
  // Pressable style is a function of `pressed`.
  const labelColor = (id: string) => {
    const txt = walk(byTestId(tree, id) ?? null).find((n) => n.type === "rn-text")!;
    return Object.assign({}, ...(txt.props.style as object[]).flat().filter(Boolean)).color;
  };
  assert.equal(labelColor("dialog-button-0"), Palette.button.secondary.text);
  assert.equal(labelColor("dialog-button-1"), Palette.button.primary.text);

  press(tree, "dialog-button-1");
  assert.deepEqual(fired, ["compost"]);
  assert.equal(r.toJSON(), null, "closed after the press");
  assert.equal(currentDialog(), null);
});

test("zero buttons → one OK, which closes", () => {
  const r = mount();
  act(() => {
    dialog.alert("Couldn't save", "Something went wrong.");
  });
  assert.deepEqual(buttonLabels(r.toJSON() as Json), ["OK"]);
  press(r.toJSON() as Json, "dialog-button-0");
  assert.equal(r.toJSON(), null);
});

test("a second alert while one is open WAITS — never stacks — and shows when the first closes", () => {
  const r = mount();
  act(() => {
    dialog.alert("First");
    dialog.alert("Second");
  });
  let text = allText(r.toJSON() as Json);
  assert.ok(text.includes("First"));
  assert.ok(!text.includes("Second"), "the second is queued, not stacked");
  assert.equal(walk(r.toJSON() as Json).filter((n) => n.type === "rn-modal").length, 1);

  press(r.toJSON() as Json, "dialog-button-0");
  text = allText(r.toJSON() as Json);
  assert.ok(text.includes("Second"));
  assert.ok(!text.includes("First"));
  press(r.toJSON() as Json, "dialog-button-0");
  assert.equal(r.toJSON(), null);
});

test("an onPress that opens a follow-up dialog shows it at once (the first has already closed)", () => {
  const r = mount();
  act(() => {
    dialog.alert("Save?", undefined, [
      { text: "Save", onPress: () => dialog.alert("Saved", "Your meal was updated.") },
    ]);
  });
  press(r.toJSON() as Json, "dialog-button-0");
  const text = allText(r.toJSON() as Json);
  assert.ok(text.includes("Saved"));
  assert.ok(!text.includes("Save?"));
});

test("cancelable (the default): a scrim tap runs the CANCEL button's onPress and closes", () => {
  const r = mount();
  const fired: string[] = [];
  act(() => {
    dialog.alert("Leave?", undefined, [
      { text: "Stay", style: "cancel", onPress: () => fired.push("stay") },
      { text: "Leave", style: "destructive", onPress: () => fired.push("leave") },
    ]);
  });
  press(r.toJSON() as Json, "dialog-scrim");
  assert.deepEqual(fired, ["stay"]);
  assert.equal(r.toJSON(), null);
});

test("cancelable: false → the scrim does nothing; the dialog stays", () => {
  const r = mount();
  const fired: string[] = [];
  act(() => {
    dialog.alert(
      "Must choose",
      undefined,
      [
        { text: "Cancel", style: "cancel", onPress: () => fired.push("cancel") },
        { text: "Go", onPress: () => fired.push("go") },
      ],
      { cancelable: false },
    );
  });
  press(r.toJSON() as Json, "dialog-scrim");
  assert.deepEqual(fired, []);
  assert.ok(allText(r.toJSON() as Json).includes("Must choose"));
});

test("no cancel button + an action-bearing OK → the scrim does NOT skip it (native never does)", () => {
  // BUG-385 — "Saved" / OK → router.back() is the only way forward; a scrim
  // tap that closed it would strand the user on the form.
  const r = mount();
  const fired: string[] = [];
  act(() => {
    dialog.alert("Saved", "Your meal was updated.", [
      { text: "OK", onPress: () => fired.push("ok") },
    ]);
  });
  press(r.toJSON() as Json, "dialog-scrim");
  assert.deepEqual(fired, []);
  assert.ok(allText(r.toJSON() as Json).includes("Saved"), "still open");
  press(r.toJSON() as Json, "dialog-button-0");
  assert.deepEqual(fired, ["ok"]);
  assert.equal(r.toJSON(), null);
});

test("a plain informational OK (no onPress) IS scrim-dismissible", () => {
  const r = mount();
  act(() => {
    dialog.alert("Couldn't save", "Try again.");
  });
  press(r.toJSON() as Json, "dialog-scrim");
  assert.equal(r.toJSON(), null);
});

test("a double dismissal closes ONE dialog, never the next in the queue", () => {
  const r = mount();
  act(() => {
    dialog.alert("A");
    dialog.alert("B");
  });
  const id = currentDialog()!.id;
  act(() => {
    dismissDialog(id);
    dismissDialog(id);
  });
  assert.ok(allText(r.toJSON() as Json).includes("B"));
});

test("Enter → the LAST non-cancel button", () => {
  act(() => {
    dialog.alert("Edit meal", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "This time only" },
      { text: "Always" },
    ]);
  });
  assert.equal(enterTarget(currentDialog()!)?.text, "Always");
});

test("three buttons render in order (meal-builder's save-mode prompt)", () => {
  const r = mount();
  act(() => {
    dialog.alert("Save changes", "How should this apply?", [
      { text: "Cancel", style: "cancel" },
      { text: "Just this time" },
      { text: "Always" },
    ]);
  });
  assert.deepEqual(buttonLabels(r.toJSON() as Json), ["Cancel", "Just this time", "Always"]);
  // A default-style button is the SAGE fill — its label is the sage text token.
  const txt = walk(byTestId(r.toJSON() as Json, "dialog-button-2") ?? null).find((n) => n.type === "rn-text")!;
  assert.equal(
    Object.assign({}, ...(txt.props.style as object[]).flat().filter(Boolean)).color,
    Palette.button.sage.text,
  );
});

test("native: dialog.alert IS Alert.alert — same arguments, nothing queued", () => {
  rnPlatform.OS = "ios";
  const seen: unknown[] = [];
  __setAlertHandler((a: unknown) => seen.push(a));
  const buttons = [{ text: "OK" }];
  dialog.alert("Title", "Body", buttons);
  assert.deepEqual(seen, [{ title: "Title", message: "Body", buttons }]);
  assert.equal(currentDialog(), null);
});
