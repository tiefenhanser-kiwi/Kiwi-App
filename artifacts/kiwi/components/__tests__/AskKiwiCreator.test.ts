// WS9 3f-4 (Thread A) — the extracted, prop-driven Ask-Kiwi creator renders and
// submits with INJECTED props (no expo-router, no real apiClient). Proves the
// one-shot contract: one free-text parse → one draft handed to navigateToDraft,
// with the upgrade + error branches routed to their injected callbacks.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { AskKiwiCreator } from "../AskKiwiCreator";
import type { ParsedMeal, ParseMealResult } from "@/lib/api/builder";
import { ApiError, UpgradeRequiredError } from "@/lib/api/errors";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PARSED_MEAL: ParsedMeal = {
  title: "Chicken Piccata",
  cuisine: "Italian",
  estimatedPrepMinutes: 10,
  estimatedCookMinutes: 20,
  servingsDefault: 4,
  difficulty: "medium",
  tags: [],
  subDishes: [],
};

function findByTestId(
  root: TestRenderer.ReactTestInstance,
  testID: string,
): TestRenderer.ReactTestInstance {
  const hit = root.findAll(
    (n) =>
      n.props?.testID === testID && typeof n.props?.onPress === "function",
  );
  if (hit.length > 0) return hit[0];
  // TextInput carries onChangeText instead of onPress.
  return root.find((n) => n.props?.testID === testID);
}

async function renderCreator(props: {
  parseMeal: (input: unknown) => Promise<ParseMealResult>;
  navigateToDraft?: (draftJson: string) => void;
  routeToUpgrade?: () => void;
}): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(AskKiwiCreator, {
        parseMeal: props.parseMeal as never,
        navigateToDraft: props.navigateToDraft ?? (() => {}),
        routeToUpgrade: props.routeToUpgrade ?? (() => {}),
      }),
    );
  });
  return renderer;
}

async function type(renderer: TestRenderer.ReactTestRenderer, value: string) {
  const input = findByTestId(renderer.root, "ask-kiwi-input");
  await act(async () => {
    input.props.onChangeText(value);
  });
}

async function submit(renderer: TestRenderer.ReactTestRenderer) {
  const btn = findByTestId(renderer.root, "ask-kiwi-submit");
  await act(async () => {
    await btn.props.onPress();
    await wait(10);
  });
}

test("success: one parse → navigateToDraft called with the draft JSON (one-shot)", async () => {
  let draftJson: string | null = null;
  let upgraded = false;
  const parseMeal = async (): Promise<ParseMealResult> => ({ meal: PARSED_MEAL });
  const renderer = await renderCreator({
    parseMeal,
    navigateToDraft: (j) => (draftJson = j),
    routeToUpgrade: () => (upgraded = true),
  });

  await type(renderer, "chicken piccata with arugula");
  await submit(renderer);

  const captured = draftJson as string | null;
  assert.ok(captured, "navigateToDraft was not called");
  const draft = JSON.parse(captured!);
  assert.equal(draft.title, "Chicken Piccata", "one draft, carrying the parsed title");
  assert.equal(upgraded, false, "success must not route to upgrade");

  renderer.unmount();
});

test("upgrade: a 402 routes to routeToUpgrade, not navigateToDraft", async () => {
  let draftJson: string | null = null;
  let upgraded = false;
  const parseMeal = async (): Promise<ParseMealResult> => {
    throw new UpgradeRequiredError({ status: 402 });
  };
  const renderer = await renderCreator({
    parseMeal,
    navigateToDraft: (j) => (draftJson = j),
    routeToUpgrade: () => (upgraded = true),
  });

  await type(renderer, "something premium");
  await submit(renderer);

  assert.equal(upgraded, true, "402 must route to upgrade");
  assert.equal(draftJson, null, "no draft navigation on the upgrade path");

  renderer.unmount();
});

test("error: an API failure surfaces the retryable message, no navigation", async () => {
  let draftJson: string | null = null;
  const parseMeal = async (): Promise<ParseMealResult> => {
    throw new ApiError("upstream", { status: 502 });
  };
  const renderer = await renderCreator({
    parseMeal,
    navigateToDraft: (j) => (draftJson = j),
  });

  await type(renderer, "a meal that fails to parse");
  await submit(renderer);

  const err = renderer.root.find((n) => n.props?.testID === "ask-kiwi-error");
  const errText = String(err.props.children);
  assert.ok(errText.length > 0, "an error message renders");
  assert.equal(draftJson, null, "no navigation on error");

  renderer.unmount();
});
