// Prep the Week — the loading screen (Oct 3, the approved onion-dicing mockup).
//
// Mounts the REAL screen in its real loading state: every query is held in
// flight by a fetch that never settles, which is exactly the state the screen
// describes. Timers are mocked so the ~400 ms delay is stepped, not slept.
//
// The copy below is transcribed from the approved mockup, independently of the
// source file, so a typo on either side goes red.
//
// This file previously pinned the D-WS9-213 §3.2 strings ("just over a minute"
// / "about 40 seconds"); the mockup replaces them, and the last test keeps them
// pinned by absence so a revert is visible.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  __resetWindowDimensionsForTests,
  __setWindowDimensionsForTests,
} from "react-native";

import { LOADING_SCREEN_DELAY_MS, PrepWeekScreen } from "../PrepWeekScreen";
import { PrepWeekLoadingView, onionGridColumns } from "../PrepWeekLoadingView";
import { Colors } from "@/constants/tokens";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

/** Every string under `node`, concatenated — one Text's full sentence. */
function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

/** The outermost Text nodes, each read whole (nested runs included). */
function textRuns(node: Node | string | null, out: string[] = []): string[] {
  if (node == null || typeof node === "string") return out;
  if (node.type === "rn-text") {
    out.push(textOf(node));
    return out;
  }
  for (const c of node.children ?? []) textRuns(c, out);
  return out;
}

function findAll(
  node: Node | string | null,
  pred: (n: Node) => boolean,
  out: Node[] = [],
): Node[] {
  if (node == null || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) findAll(c, pred, out);
  return out;
}

function colorOf(n: Node): unknown {
  return (n.props?.style as { color?: unknown } | undefined)?.color;
}

/** Mount the screen with every query stuck in flight; timers are mocked. */
function mountLoading(mealIds?: string[]) {
  const originalFetch = globalThis.fetch;
  // Never settles: the queries stay isLoading, which is the state under test.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  mock.timers.enable({ apis: ["setTimeout"] });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(PrepWeekScreen, {
          planId: "plan-1",
          mealIds,
          onExit: () => {},
          onSaveExit: () => {},
        }),
      ),
    );
  });
  return {
    tree: () => renderer.toJSON() as unknown as Node,
    advance: (ms: number) => act(() => mock.timers.tick(ms)),
    cleanup: () => {
      renderer.unmount();
      client.clear();
      mock.timers.reset();
      globalThis.fetch = originalFetch;
    },
  };
}

const TITLE = "Building your prep list…";
const SUBTITLE =
  "Kiwi is grouping this week's ingredients into containers. The first open takes about 30–60 seconds.";
const LABEL = "— while you wait: how to dice an onion —";
const NEXT_UP =
  "Next up: your containers, in the order you'd work a board — dry, then wash, then one knife through all the onions, carrots and garlic, then liquids, then proteins.";

// [caption, its terracotta words, tip] — panel order 1..6.
const PANELS: Array<[string, string[], string]> = [
  [
    "Cut off the stem end and the root end.",
    ["stem end", "root end"],
    "Two flat ends make the onion easy to steady.",
  ],
  [
    "Peel the papery skin and the first tough layer.",
    ["Peel"],
    "Start at the cut top; the skin lifts in one strip.",
  ],
  [
    "Cut in half, end to end. Lay each half on its cut side.",
    ["half", "cut side"],
    "Cut end toward you and to the right; the root end points away.",
  ],
  [
    "Knife flat, from the cut end: 2–3 horizontal cuts toward the root — not through it.",
    ["2–3 horizontal cuts"],
    "Stop about ½ inch short of the root.",
  ],
  [
    "Lengthwise cuts, stem to root, as close together as you want the dice.",
    ["Lengthwise cuts"],
    "Stop just short of the root end so the half stays in one piece.",
  ],
  [
    "Turn the knife to point away from you and cut across — the dice falls away. Work toward the root; compost the stub.",
    ["cut across"],
    "Fingertips curled under, knuckles against the flat of the blade. Smaller gaps in 4–6 = finer dice.",
  ],
];

test("before the delay: only the header paints — no loading screen, no spinner", () => {
  const screen = mountLoading();
  try {
    const at0 = textRuns(screen.tree());
    assert.ok(at0.includes("Prep the Week"), `header missing: ${at0.join(" | ")}`);
    assert.ok(!at0.includes(TITLE), "the loading screen painted at 0 ms");
    assert.equal(
      findAll(screen.tree(), (n) => n.type === "rn-activity-indicator").length,
      0,
      "a spinner still paints during the delay",
    );

    screen.advance(LOADING_SCREEN_DELAY_MS - 1);
    const justBefore = textRuns(screen.tree());
    assert.ok(
      !justBefore.includes(TITLE),
      `the loading screen painted before ${LOADING_SCREEN_DELAY_MS} ms`,
    );
    assert.ok(
      !justBefore.some((t) => t.startsWith("Cut off the")),
      "a panel painted before the delay",
    );

    screen.advance(1);
    assert.ok(
      textRuns(screen.tree()).includes(TITLE),
      `the loading screen did not paint at ${LOADING_SCREEN_DELAY_MS} ms`,
    );
  } finally {
    screen.cleanup();
  }
});

test("after the delay: title, subtitle, bar, label, all six panels and the Next-up box", () => {
  const screen = mountLoading();
  try {
    screen.advance(LOADING_SCREEN_DELAY_MS);
    const tree = screen.tree();
    const runs = textRuns(tree);
    const all = runs.join(" | ");

    assert.ok(runs.includes(TITLE), `title missing: ${all}`);
    assert.ok(runs.includes(SUBTITLE), `subtitle missing or changed: ${all}`);
    assert.ok(runs.includes(LABEL), `label missing: ${all}`);
    assert.ok(runs.includes(NEXT_UP), `Next-up box missing or changed: ${all}`);
    assert.equal(
      findAll(tree, (n) => n.props?.accessibilityRole === "progressbar").length,
      1,
      "the progress bar is missing",
    );

    for (const [i, [caption, , tip]] of PANELS.entries()) {
      assert.ok(runs.includes(caption), `panel ${i + 1} caption missing: ${caption}`);
      assert.ok(runs.includes(tip), `panel ${i + 1} tip missing: ${tip}`);
      assert.ok(runs.includes(String(i + 1)), `panel ${i + 1} badge missing`);
    }

    // The terracotta words, exactly and only: every nested run coloured
    // terracotta[400], in order, across all six captions.
    const terracotta = findAll(
      tree,
      (n) => n.type === "rn-text" && colorOf(n) === Colors.terracotta[400],
    ).map(textOf);
    assert.deepEqual(
      terracotta,
      PANELS.flatMap(([, strong]) => strong),
      "the terracotta words drifted",
    );

    // Six illustrations, all on the mockup's 160×120 viewBox.
    const svgs = findAll(tree, (n) => n.type === "rn-svg");
    assert.equal(svgs.length, 6, `expected six panels' art, got ${svgs.length}`);
    for (const svg of svgs) assert.equal(svg.props?.viewBox, "0 0 160 120");
  } finally {
    screen.cleanup();
  }
});

test("the mockup's meta row is gone; 'Sorting N meals' only from client state", () => {
  // Full week, plan detail still in flight → the count is unknown → no line,
  // and none of the numbers that only exist once the response lands.
  const full = mountLoading();
  try {
    full.advance(LOADING_SCREEN_DELAY_MS);
    const all = textRuns(full.tree()).join(" | ");
    assert.ok(!all.includes("Sorting"), `a meal count appeared from nowhere: ${all}`);
    assert.ok(!all.includes("ingredients ·") && !all.includes("containers ·"), all);
    assert.ok(!all.includes("about 85 min"), all);
  } finally {
    full.cleanup();
  }

  // A subset names its meals in the route, so the count is known up front.
  const subset = mountLoading([M1, M2]);
  try {
    subset.advance(LOADING_SCREEN_DELAY_MS);
    const runs = textRuns(subset.tree());
    assert.ok(runs.includes("Sorting 2 meals"), runs.join(" | "));
  } finally {
    subset.cleanup();
  }
});

test("the D-WS9-213 §3.2 strings are gone (pinned by absence)", () => {
  const screen = mountLoading();
  try {
    screen.advance(LOADING_SCREEN_DELAY_MS);
    const all = textRuns(screen.tree()).join(" | ");
    assert.ok(!all.includes("just over a minute"), "the old full-week copy is back");
    assert.ok(!all.includes("about 40 seconds"), "the old subset copy is back");
  } finally {
    screen.cleanup();
  }
});

// ── Layout at large system font sizes (BUG-347 was a welcome screen at max) ──

function panelRows(): number[] {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(PrepWeekLoadingView, {}));
  });
  try {
    const tree = renderer.toJSON() as unknown as Node;
    // A grid row is a row-direction View whose children are panels (each
    // holds one svg).
    const rows = findAll(
      tree,
      (n) =>
        n.type === "rn-view" &&
        (n.props?.style as { flexDirection?: string } | undefined)
          ?.flexDirection === "row" &&
        (n.children ?? []).length > 0 &&
        (n.children ?? []).every(
          (c) =>
            typeof c !== "string" &&
            findAll(c, (x) => x.type === "rn-svg").length === 1,
        ),
    );
    return rows.map((r) => (r.children ?? []).length);
  } finally {
    renderer.unmount();
  }
}

test("grid: three rows of two at 1× text, one column at accessibility sizes", () => {
  try {
    assert.deepEqual(panelRows(), [2, 2, 2], "expected the mockup's 3×2 grid");

    __setWindowDimensionsForTests({ fontScale: 2 });
    assert.deepEqual(panelRows(), [1, 1, 1, 1, 1, 1], "expected one column at 2×");

    // The decision is width-aware, not a bare font-scale cut-off.
    assert.equal(onionGridColumns(375, 1.5), 2);
    assert.equal(onionGridColumns(375, 1.65), 1);
    assert.equal(onionGridColumns(320, 1.24), 2);
    assert.equal(onionGridColumns(320, 1.35), 1);
  } finally {
    __resetWindowDimensionsForTests();
  }
});
