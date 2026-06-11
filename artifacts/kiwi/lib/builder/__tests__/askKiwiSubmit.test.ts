// WS7-6 G1 — Mode A submit orchestrator. The apiClient + expo-router are
// INJECTED (no module mocking), so each error path is exercised by handing
// runAskKiwiSubmit a fake parseMeal that resolves / rejects accordingly.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runAskKiwiSubmit,
  ASK_KIWI_AI_FAILED_MESSAGE,
  type AskKiwiSubmitDeps,
} from "../askKiwiSubmit";
import type { ParsedMeal, ParseMealResult } from "../../api/builder";
import { ApiError, ApiNetworkError, UpgradeRequiredError } from "../../api/errors";

function makeParsedMeal(): ParsedMeal {
  return {
    title: "Salmon Teriyaki Dinner",
    cuisine: "Japanese",
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 20,
    servingsDefault: 4,
    difficulty: "easy",
    tags: [],
    subDishes: [
      {
        title: "Salmon Teriyaki",
        role: "main",
        positionIndex: 0,
        ingredients: [{ name: "salmon", quantity: 2, unit: "fillets" }],
        steps: [{ content: "Glaze and broil.", estimatedMinutes: 12, phaseType: "cook" }],
      },
    ],
  };
}

interface Spy {
  navigated: string[];
  upgraded: number;
  deps: AskKiwiSubmitDeps;
}

function makeDeps(parseMeal: AskKiwiSubmitDeps["parseMeal"]): Spy {
  const spy: Spy = {
    navigated: [],
    upgraded: 0,
    deps: {
      parseMeal,
      navigateToDraft: (json) => spy.navigated.push(json),
      routeToUpgrade: () => {
        spy.upgraded += 1;
      },
    },
  };
  return spy;
}

test("success: navigates with the encoded DraftMeal (round-trip parseable)", async () => {
  const result: ParseMealResult = { meal: makeParsedMeal() };
  const spy = makeDeps(async () => result);

  const outcome = await runAskKiwiSubmit(
    { freeText: "salmon teriyaki for four", servings: 4 },
    spy.deps,
  );

  assert.deepEqual(outcome, { status: "success" });
  assert.equal(spy.navigated.length, 1);
  assert.equal(spy.upgraded, 0);
  // The navigated payload is JSON that hydrates back to a DraftMeal.
  const draft = JSON.parse(spy.navigated[0]);
  assert.equal(draft.title, "Salmon Teriyaki Dinner");
  assert.equal(draft.dishes[0].name, "Salmon Teriyaki");
  assert.equal(draft.estimatedTimeMinutes, 30);
});

test("success: passes freeText + servings straight through to parseMeal", async () => {
  let seen: { freeText: string; servings: number } | null = null;
  const spy = makeDeps(async (input) => {
    seen = { freeText: input.freeText, servings: input.servings ?? -1 };
    return { meal: makeParsedMeal() };
  });

  await runAskKiwiSubmit({ freeText: "describe this", servings: 6 }, spy.deps);
  assert.deepEqual(seen, { freeText: "describe this", servings: 6 });
});

test("402: routes to upgrade, does NOT navigate", async () => {
  const spy = makeDeps(async () => {
    throw new UpgradeRequiredError({ status: 402, body: { error: "upgrade required" } });
  });

  const outcome = await runAskKiwiSubmit({ freeText: "x", servings: 4 }, spy.deps);

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

  const outcome = await runAskKiwiSubmit({ freeText: "x", servings: 4 }, spy.deps);

  assert.deepEqual(outcome, { status: "error", message: ASK_KIWI_AI_FAILED_MESSAGE });
  assert.equal(spy.navigated.length, 0);
  assert.equal(spy.upgraded, 0);
});

test("transport error: same retryable treatment, no navigate", async () => {
  const spy = makeDeps(async () => {
    throw new ApiNetworkError("network down", new Error("offline"));
  });

  const outcome = await runAskKiwiSubmit({ freeText: "x", servings: 4 }, spy.deps);

  assert.equal(outcome.status, "error");
  assert.equal(spy.navigated.length, 0);
});
