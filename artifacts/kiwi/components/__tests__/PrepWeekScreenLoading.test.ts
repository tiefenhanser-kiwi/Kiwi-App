// WS9 D-WS9-207 Part 2 item 3 — the two loading strings.
//
// A subset prep run and a full-week run are not the same wait: MEASURED at
// 35-41s for a selected-meals subset and 64-75s for a full week. One "about a
// minute" over both either over-promises the full week or makes the subset feel
// slow for no reason, so the copy branches on `isSubset`.
//
// WHY A RENDER TEST AND NOT A STRING CONSTANT. The branch is one ternary; a
// test that imported the two strings and compared them to themselves would
// assert nothing. What can actually break is the WIRING — the screen reading
// the wrong side of `isSubset`, or the branch being dropped in a later tidy —
// so this mounts the real screen in its real loading state and reads the text
// that is actually on the glass.
//
// The queries are held in-flight by a fetch that never settles, which is
// exactly the state the copy describes.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PrepWeekScreen } from "../PrepWeekScreen";

const M1 = "11111111-1111-4111-8111-111111111111";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function gatherText(node: Node | string | null, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) gatherText(c, out);
  }
  return out;
}

/** Mount the screen with every query stuck in flight, and return its copy. */
function loadingText(mealIds?: string[]): string {
  const originalFetch = globalThis.fetch;
  // Never settles: the queries stay isLoading, which is the state under test.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
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
    return gatherText(renderer.toJSON() as unknown as Node)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    if (renderer!) renderer.unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  }
}

// D-WS9-213 §3.2 — the copy is Hans-canonical and transcribed here VERBATIM
// from the ruling, independently of the source file. `.includes` against the
// whole sentence is what makes "shorten it to fit the layout" go red: a
// truncation that keeps the first clause still fails.
const FULL_WEEK_COPY =
  "This usually takes just over a minute — Kiwi is reading every meal, dish and ingredient in your plan to build one efficient prep session.";
const SUBSET_COPY =
  "This usually takes about 40 seconds — Kiwi is reading every meal, dish and ingredient in your selected meals to build one efficient prep session.";

test("full-week run: the copy promises just over a minute, IN FULL", () => {
  const copy = loadingText();
  // Measured 64-75s. The old "about a minute" under-promised its own numbers.
  assert.ok(
    copy.includes(FULL_WEEK_COPY),
    `full-week loading copy not found in: ${copy}`,
  );
  assert.ok(
    !copy.includes("selected meals"),
    "the subset copy leaked into a full-week run",
  );
  // ⚠️ THE OLD, UNTRUE ESTIMATES. Pinned by absence so a revert is visible.
  assert.ok(!copy.includes("about a minute"), "the old estimate is back");
});

test("subset run: the copy names the SELECTION and the shorter measured wait, IN FULL", () => {
  const copy = loadingText([M1]);
  // Measured 35-41s, device-confirmed at 41s. "about 30 seconds" was a promise
  // the run could not keep.
  assert.ok(copy.includes(SUBSET_COPY), `subset loading copy not found in: ${copy}`);
  assert.ok(
    !copy.includes("just over a minute"),
    "the full-week estimate leaked into a subset run",
  );
  assert.ok(!copy.includes("about 30 seconds"), "the old estimate is back");
});

test("the explanatory clause is present on BOTH runs — it is the copy's job, not decoration", () => {
  // "Reading every meal, dish and ingredient" converts dead time into visible
  // effort. A layout-driven trim would drop exactly this half of the sentence,
  // so it is asserted on its own as well as inside the whole string.
  const CLAUSE = "Kiwi is reading every meal, dish and ingredient in your";
  assert.ok(loadingText().includes(CLAUSE), "full-week clause missing");
  assert.ok(loadingText([M1]).includes(CLAUSE), "subset clause missing");
});

test("an EMPTY mealIds array is a full-week run, not a subset", () => {
  // isSubset is `!!mealIds && mealIds.length > 0` — an empty array must not
  // promise 40 seconds for a full week's work.
  const copy = loadingText([]);
  assert.ok(copy.includes(FULL_WEEK_COPY), `expected full-week copy: ${copy}`);
});
