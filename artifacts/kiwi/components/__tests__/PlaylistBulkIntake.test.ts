// WS9 Redesign Arc Block 2c Part A (D-WS9-244) — the bulk intake section.
//
// Mounts the real section with fake deps and pins: three boxes + the copy;
// "Add another meal" grows the list; three filled boxes → three parse calls
// IN SEQUENCE (the gate in the fake parse proves the second cannot start
// before the first resolves) → three saves → the hand-off with every saved
// meal; a middle box that throws leaves the other two saved, the failed row
// keeps its text with a Retry, and Retry finishes the run; empty boxes are
// skipped; the host's running flag flips around the run.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { ParseMealInput, ParseMealResult } from "@/lib/api/builder";
import { ApiError } from "@/lib/api/errors";
import type { SaveMealInput } from "@/lib/api/meals";
import {
  BULK_ADD_ANOTHER,
  BULK_PLACEHOLDERS,
  BULK_SECTION_SUBLINE,
  BULK_SECTION_TITLE,
  BULK_STATUS_FAILED,
  BULK_STATUS_SAVED,
  BULK_SUBMIT_CAPTION,
} from "@/lib/builder/bulkPlaylistIntake";
import { PlaylistBulkIntake } from "../PlaylistBulkIntake";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
type Tree = Json | string | null | (Json | string)[];
function walk(node: Tree): Json[] {
  if (node == null || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((c) => walk(c));
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}
function allText(node: Tree): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(allText);
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}
function joined(node: Tree): string {
  return allText(node).join(" ").replace(/\s+/g, " ");
}
function byTestId(root: Tree, id: string): Json | undefined {
  return walk(root).find((n) => n.props.testID === id);
}
function byLabel(root: Tree, label: string): Json | undefined {
  return walk(root).find((n) => n.props.accessibilityLabel === label);
}
function inputs(root: Tree): Json[] {
  return walk(root).filter((n) => typeof n.props.testID === "string" && (n.props.testID as string).startsWith("bulk-input-"));
}

function parsed(title: string): ParseMealResult {
  return {
    meal: {
      title,
      cuisine: null,
      estimatedPrepMinutes: 5,
      estimatedCookMinutes: 15,
      servingsDefault: 4,
      difficulty: "easy",
      tags: [],
      subDishes: [
        {
          title,
          ingredients: [{ name: "thing", quantity: 1, unit: "each" }],
          steps: [{ content: "Do it.", estimatedMinutes: 15, isTimingSensitive: false, phaseType: "cook" }],
        },
      ],
    },
  } as ParseMealResult;
}
function defer<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let mounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.unmount());
    mounted = null;
  }
});

async function mount(opts: {
  parseImpl?: (input: ParseMealInput, n: number) => Promise<ParseMealResult>;
} = {}) {
  const log: string[] = [];
  const finished: { mealId: string; title: string }[][] = [];
  const running: boolean[] = [];
  let n = 0;
  let saved = 0;
  const deps = {
    parseMeal: async (input: ParseMealInput) => {
      n += 1;
      log.push(`parse:${input.freeText}`);
      const r = opts.parseImpl ? await opts.parseImpl(input, n) : parsed(`Meal ${input.freeText}`);
      log.push(`parsed:${input.freeText}`);
      return r;
    },
    saveMeal: async (input: SaveMealInput) => {
      saved += 1;
      log.push(`save:${input.title}`);
      return { id: `m${saved}`, dishIds: [], linksCreated: 0 };
    },
    addToPlaylist: async (mealId: string) => {
      log.push(`add:${mealId}`);
      return {};
    },
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlaylistBulkIntake, {
        deps,
        onFinished: (s) => finished.push(s),
        onUpgradeRequired: () => log.push("upgrade"),
        onRunningChange: (r) => running.push(r),
      }),
    );
  });
  mounted = renderer;
  const root = () => renderer.toJSON() as Tree;
  const type = async (index: number, text: string) => {
    const node = inputs(root())[index];
    assert.ok(node, `input ${index}`);
    await act(async () => {
      (node.props.onChangeText as (t: string) => void)(text);
    });
  };
  const tap = async (node: Json | undefined, what: string) => {
    assert.ok(node, `${what} not found`);
    await act(async () => {
      (node!.props.onPress as () => void)();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  };
  const settle = async () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  return { root, text: () => joined(root()), type, tap, settle, log, finished, running };
}

test("three boxes with the go-to-meal placeholders, the copy, and 'Add another meal' grows the list", async () => {
  const m = await mount();
  const t = m.text();
  assert.ok(t.includes(BULK_SECTION_TITLE) && t.includes(BULK_SECTION_SUBLINE) && t.includes(BULK_SUBMIT_CAPTION), t);
  const boxes = inputs(m.root());
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map((b) => b.props.placeholder), [...BULK_PLACEHOLDERS]);
  assert.equal(byTestId(m.root(), "playlist-bulk-submit")!.props.disabled, true, "nothing to add yet");
  await m.tap(byLabel(m.root(), BULK_ADD_ANOTHER), "Add another meal");
  assert.equal(inputs(m.root()).length, 4);
});

test("three filled boxes → three calls IN SEQUENCE → three saves → the hand-off with all three", async () => {
  const gates = [defer<void>(), defer<void>(), defer<void>()];
  const m = await mount({
    parseImpl: async (input, n) => {
      await gates[n - 1].promise;
      return parsed(`Meal ${input.freeText}`);
    },
  });
  await m.type(0, "tacos");
  await m.type(1, "pizza");
  await m.type(2, "salad");
  assert.ok(!byTestId(m.root(), "playlist-bulk-submit")!.props.disabled);
  await m.tap(byTestId(m.root(), "playlist-bulk-submit"), "Add these meals");
  // 🔴 THE BREAK THIS CATCHES (Promise.all): all three would be in flight.
  assert.deepEqual(m.log, ["parse:tacos"], "only the first box has started");
  assert.ok(m.text().includes("Kiwi is writing this one…"), "the first box shows its progress");
  assert.ok(m.text().includes("waiting"), "the others wait");
  assert.deepEqual(m.running, [true]);
  gates[0].resolve();
  await m.settle();
  assert.deepEqual(m.log, ["parse:tacos", "parsed:tacos", "save:Meal tacos", "add:m1", "parse:pizza"]);
  assert.ok(m.text().includes(BULK_STATUS_SAVED), "the first box reads saved ✓");
  gates[1].resolve();
  await m.settle();
  gates[2].resolve();
  await m.settle();
  assert.deepEqual(m.log, [
    "parse:tacos", "parsed:tacos", "save:Meal tacos", "add:m1",
    "parse:pizza", "parsed:pizza", "save:Meal pizza", "add:m2",
    "parse:salad", "parsed:salad", "save:Meal salad", "add:m3",
  ]);
  assert.deepEqual(m.finished, [[
    { mealId: "m1", title: "Meal tacos" },
    { mealId: "m2", title: "Meal pizza" },
    { mealId: "m3", title: "Meal salad" },
  ]]);
  assert.deepEqual(m.running, [true, false]);
});

test("a middle box that throws → the other two save; the failed row keeps its text, offers Retry, and Retry finishes the run", async () => {
  let pizzaCalls = 0;
  const m = await mount({
    parseImpl: async (input) => {
      if (input.freeText === "pizza") {
        pizzaCalls += 1;
        if (pizzaCalls === 1) throw new ApiError("Request failed (502)", { status: 502, body: { error: "ai_failed" } });
      }
      return parsed(`Meal ${input.freeText}`);
    },
  });
  await m.type(0, "tacos");
  await m.type(1, "pizza");
  await m.type(2, "salad");
  await m.tap(byTestId(m.root(), "playlist-bulk-submit"), "Add these meals");
  await m.settle();
  assert.deepEqual(m.finished, [], "not handed off while a box is failed");
  assert.ok(m.log.includes("add:m1") && m.log.includes("add:m2"), "the other two saved");
  assert.ok(!m.log.includes("save:Meal pizza"));
  const failedInput = inputs(m.root())[1];
  assert.equal(failedInput.props.value, "pizza", "the failed box keeps its text");
  assert.ok(m.text().includes(BULK_STATUS_FAILED));
  assert.ok(m.text().includes("2 saved · 1 failed"), m.text());
  const retry = byLabel(m.root(), "Retry pizza");
  assert.ok(retry, "Retry offered on the failed row");
  await m.tap(retry, "Retry");
  await m.settle();
  assert.equal(pizzaCalls, 2);
  // Hand-off is in BOX order (the sheet lists them as typed), not save order.
  assert.deepEqual(m.finished, [[
    { mealId: "m1", title: "Meal tacos" },
    { mealId: "m3", title: "Meal pizza" },
    { mealId: "m2", title: "Meal salad" },
  ]]);
});

test("empty boxes are skipped: one filled of three → one call, one save", async () => {
  const m = await mount();
  await m.type(1, "  salad  ");
  await m.tap(byTestId(m.root(), "playlist-bulk-submit"), "Add these meals");
  await m.settle();
  assert.deepEqual(m.log, ["parse:salad", "parsed:salad", "save:Meal salad", "add:m1"]);
  assert.deepEqual(m.finished, [[{ mealId: "m1", title: "Meal salad" }]]);
});
