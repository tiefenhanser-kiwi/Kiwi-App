// WS7-6 G3 Scope A + B — surface #2 (Plan → Add Meal) chooser. Asserts the
// restructure: create/add options on TOP (Ask-Kiwi first), the saved-meals
// list section BELOW them, and that the two pre-G3 dead controls are gone —
// "Run Kitchen Wizard for one meal" and "Ask Kiwi for a meal recommendation",
// each of which fired a "Coming in WS6" Alert. Ask Kiwi now routes to the live
// Mode-A screen (/ask-kiwi) with the plan id threaded, and fires NO Alert.
//
// useMeals needs a QueryClientProvider; the query never resolves under the node
// harness (no network), so the list renders its loading branch — the create
// options render regardless, which is all this test inspects.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text, __setAlertHandler } from "react-native";
import {
  __setRouterForTests,
  __resetRouterForTests,
} from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AddMealsSheet } from "../AddMealsSheet";

function textLeavesOf(node: TestRenderer.ReactTestInstance): string[] {
  return node.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderSheet(opts: {
  planId?: string;
  onPick?: (m: unknown) => void;
}): Promise<TestRenderer.ReactTestRenderer> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(AddMealsSheet, {
          visible: true,
          planId: opts.planId ?? "plan-1",
          onClose: () => {},
          onPickExistingMeal: opts.onPick ?? (() => {}),
        }),
      ),
    );
  });
  return renderer;
}

test("AddMealsSheet: create options sit ABOVE the saved-meals list", async () => {
  __resetRouterForTests();
  const renderer = await renderSheet({});
  const leaves = textLeavesOf(renderer.root);

  // WS9 3f-3 — header copy unified across both sheets to "Bring in something new"
  // (was "Add something new" here) when the inline chooser became the shared
  // ImportSourceCards component.
  const addNew = leaves.findIndex((t) => t === "Bring in something new");
  const pickList = leaves.findIndex((t) => t === "Pick from your meals");
  assert.ok(addNew >= 0, "'Bring in something new' header missing");
  assert.ok(pickList >= 0, "'Pick from your meals' header missing");
  assert.ok(
    addNew < pickList,
    "create options should render above the saved-meals list",
  );

  renderer.unmount();
});

test("AddMealsSheet: the two dead 'Coming in WS6' controls are gone", async () => {
  const renderer = await renderSheet({});
  const joined = textLeavesOf(renderer.root).join(" | ");

  assert.ok(
    !joined.includes("Run Kitchen Wizard for one meal"),
    "dead Kitchen Wizard card should be removed",
  );
  assert.ok(
    !joined.includes("Ask Kiwi for a meal recommendation"),
    "dead Ask-Kiwi-recommendation section should be removed",
  );
  // The live Ask Kiwi create option IS present.
  assert.ok(joined.includes("Ask Kiwi"), "live Ask Kiwi card missing");

  renderer.unmount();
});

test("AddMealsSheet: tapping Ask Kiwi routes to /ask-kiwi with the plan id, no Alert", async () => {
  let pushed: { pathname?: string; params?: { addToPlanId?: string } } | null =
    null;
  let alerts = 0;
  __setRouterForTests({
    push: (href: { pathname?: string; params?: { addToPlanId?: string } }) => {
      pushed = href;
    },
  });
  __setAlertHandler(() => {
    alerts += 1;
  });

  const renderer = await renderSheet({ planId: "plan-77" });

  // The Ask Kiwi card is the Pressable whose subtree contains the
  // "Ask Kiwi for a meal" title (D-WS9-017) but not the list/section headers.
  const askCard = renderer.root.findAllByType(Pressable).find((p) => {
    const leaves = textLeavesOf(p);
    return leaves.includes("Ask Kiwi for a meal");
  });
  assert.ok(askCard, "Ask Kiwi card not found");

  await act(async () => {
    askCard!.props.onPress({});
    await wait(200);
  });

  assert.equal(alerts, 0, "Ask Kiwi must NOT fire a placeholder Alert anymore");
  assert.equal(pushed?.pathname, "/ask-kiwi", "Ask Kiwi should route to /ask-kiwi");
  assert.equal(
    pushed?.params?.addToPlanId,
    "plan-77",
    "the plan id must thread through as addToPlanId",
  );

  renderer.unmount();
  __setAlertHandler(null);
  __resetRouterForTests();
});
