// WS7-6 G2 — Dish Mode A submit orchestrator. The apiClient + expo-router are
// INJECTED (no module mocking), so each error path is exercised by handing
// runAskKiwiDishSubmit a fake parseDish that resolves / rejects accordingly.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runAskKiwiDishSubmit,
  ASK_KIWI_DISH_AI_FAILED_MESSAGE,
  type AskKiwiDishSubmitDeps,
} from "../askKiwiDishSubmit";
import type { ParsedDish, ParseDishResult } from "../../api/builder";
import { ApiError, ApiNetworkError, UpgradeRequiredError } from "../../api/errors";

function makeParsedDish(): ParsedDish {
  return {
    title: "Roasted Broccoli with Garlic and Lemon",
    cuisine: "Mediterranean",
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 20,
    servingsDefault: 4,
    difficulty: "easy",
    tags: ["vegetable"],
    ingredients: [{ name: "broccoli florets", quantity: 1.5, unit: "lb" }],
    steps: [
      { content: "Heat the oven to 425F.", estimatedMinutes: 5, phaseType: "preheat" },
      { content: "Toss broccoli with oil.", estimatedMinutes: 3, phaseType: "prep" },
    ],
  };
}

interface Spy {
  navigated: string[];
  upgraded: number;
  deps: AskKiwiDishSubmitDeps;
}

function makeDeps(parseDish: AskKiwiDishSubmitDeps["parseDish"]): Spy {
  const spy: Spy = {
    navigated: [],
    upgraded: 0,
    deps: {
      parseDish,
      navigateToDraft: (json) => spy.navigated.push(json),
      routeToUpgrade: () => {
        spy.upgraded += 1;
      },
    },
  };
  return spy;
}

test("success: navigates with the encoded DraftDish (round-trip parseable)", async () => {
  const result: ParseDishResult = { dish: makeParsedDish() };
  const spy = makeDeps(async () => result);

  const outcome = await runAskKiwiDishSubmit(
    { freeText: "roasted broccoli with garlic and lemon", servings: 4 },
    spy.deps,
  );

  assert.deepEqual(outcome, { status: "success" });
  assert.equal(spy.navigated.length, 1);
  assert.equal(spy.upgraded, 0);
  // The navigated payload is JSON that hydrates back to a DraftDish.
  const draft = JSON.parse(spy.navigated[0]);
  assert.equal(draft.name, "Roasted Broccoli with Garlic and Lemon");
  assert.equal(draft.cuisineType, "Mediterranean");
  assert.equal(draft.type, "main");
  // prep(10) + cook(20) collapse into one estimatedTimeMinutes.
  assert.equal(draft.estimatedTimeMinutes, 30);
  assert.equal(draft.ingredients[0].name, "broccoli florets");
  assert.equal(draft.steps.length, 2);
  assert.equal(draft.steps[0].text, "Heat the oven to 425F.");
});

test("success: passes freeText + servings straight through to parseDish", async () => {
  let seen: { freeText: string; servings: number } | null = null;
  const spy = makeDeps(async (input) => {
    seen = { freeText: input.freeText, servings: input.servings ?? -1 };
    return { dish: makeParsedDish() };
  });

  await runAskKiwiDishSubmit({ freeText: "describe this dish", servings: 2 }, spy.deps);
  assert.deepEqual(seen, { freeText: "describe this dish", servings: 2 });
});

test("402: routes to upgrade, does NOT navigate", async () => {
  const spy = makeDeps(async () => {
    throw new UpgradeRequiredError({ status: 402, body: { error: "upgrade required" } });
  });

  const outcome = await runAskKiwiDishSubmit({ freeText: "x", servings: 4 }, spy.deps);

  assert.deepEqual(outcome, { status: "upgrade" });
  assert.equal(spy.upgraded, 1);
  assert.equal(spy.navigated.length, 0);
});

test("502 ai_failed: friendly retryable error, input untouched (no navigate)", async () => {
  const spy = makeDeps(async () => {
    throw new ApiError("Request failed (502)", {
      status: 502,
      body: { error: "ai_failed", status: "failed" },
    });
  });

  const outcome = await runAskKiwiDishSubmit({ freeText: "x", servings: 4 }, spy.deps);

  assert.deepEqual(outcome, {
    status: "error",
    message: ASK_KIWI_DISH_AI_FAILED_MESSAGE,
  });
  assert.equal(spy.navigated.length, 0);
  assert.equal(spy.upgraded, 0);
});

test("transport error: same retryable treatment, no navigate", async () => {
  const spy = makeDeps(async () => {
    throw new ApiNetworkError("network down", new Error("offline"));
  });

  const outcome = await runAskKiwiDishSubmit({ freeText: "x", servings: 4 }, spy.deps);

  assert.equal(outcome.status, "error");
  assert.equal(spy.navigated.length, 0);
});
