// WS7-6 Block 1C — tests for lib/api/builder.ts wrappers.
//
// Pins the load-bearing contracts:
//   - parseMeal / assistIngredients / assistSteps POST to the right URL,
//     parse the { status:"success", … } envelope, and forward AbortSignal.
//   - parseMeal maps server `difficulty: fancy` → UI `hard` at the boundary
//     (and toServerDifficulty / fromServerDifficulty round-trip cleanly).
//   - 402 on parse-meal (premium gate) surfaces as UpgradeRequiredError so
//     the screen can route to the upgrade modal.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  assistIngredients,
  assistSteps,
  fromServerDifficulty,
  parseMeal,
  toServerDifficulty,
} from "../builder";
import {
  ApiError,
  ApiSchemaError,
  UnauthenticatedError,
  UpgradeRequiredError,
} from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────

const ASSIST_INGREDIENTS_INPUT = {
  dishTitle: "Lemon roast chicken",
  cuisine: "American",
  existingIngredients: [
    { name: "Chicken thighs", quantity: 6, unit: "pieces" },
  ],
  servings: 4,
};

const ASSIST_INGREDIENTS_RESPONSE = {
  status: "success" as const,
  ingredients: [
    {
      name: "Chicken thighs",
      quantity: 6,
      unit: "pieces",
      isUserProvided: true,
      addedByKiwi: false,
    },
    {
      name: "Lemon",
      quantity: 2,
      unit: "whole",
      isUserProvided: false,
      addedByKiwi: true,
    },
  ],
};

const ASSIST_STEPS_INPUT = {
  dishTitle: "Lemon roast chicken",
  cuisine: "American",
  ingredients: [
    { name: "Chicken thighs", quantity: 6, unit: "pieces" },
    { name: "Lemon", quantity: 2, unit: "whole" },
  ],
  servings: 4,
};

const ASSIST_STEPS_RESPONSE = {
  status: "success" as const,
  steps: [
    {
      content: "Preheat oven to 425°F.",
      estimatedMinutes: 5,
      phaseType: "preheat",
    },
    {
      content: "Roast 35 minutes.",
      estimatedMinutes: 35,
      phaseType: "cook",
      parallelGroup: null,
    },
  ],
};

const PARSE_MEAL_INPUT = {
  freeText: "A weeknight roast chicken with potatoes and a green salad",
  servings: 4,
};

const PARSE_MEAL_SERVER_RESPONSE = {
  status: "success" as const,
  meal: {
    title: "Weeknight Roast Chicken",
    cuisine: "American",
    estimatedPrepMinutes: 15,
    estimatedCookMinutes: 45,
    servingsDefault: 4,
    // Server canon — wrapper maps fancy → hard at the boundary.
    difficulty: "fancy" as const,
    tags: ["roast", "comforting"],
    subDishes: [
      {
        title: "Roast chicken",
        role: "main" as const,
        positionIndex: 0,
        ingredients: [
          { name: "Whole chicken", quantity: 1, unit: "whole" },
        ],
        steps: [
          {
            content: "Roast.",
            estimatedMinutes: 45,
            phaseType: "cook" as const,
          },
        ],
      },
    ],
  },
};

// ── Harness ─────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;
let lastUrl: string | null;
let lastMethod: string | null;
let lastSignal: AbortSignal | null;
let lastBody: string | null;

beforeEach(() => {
  lastUrl = null;
  lastMethod = null;
  lastSignal = null;
  lastBody = null;
  nextResponse = () => mockJson({});
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; signal?: AbortSignal; body?: string },
  ) => {
    lastUrl = url;
    lastMethod = init?.method ?? "GET";
    lastSignal = init?.signal ?? null;
    lastBody = init?.body ?? null;
    return nextResponse();
  }) as unknown as typeof fetch;
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

// ── Difficulty mapping ──────────────────────────────────────────────────

test("toServerDifficulty maps hard → fancy, others pass through", () => {
  assert.equal(toServerDifficulty("hard"), "fancy");
  assert.equal(toServerDifficulty("medium"), "medium");
  assert.equal(toServerDifficulty("easy"), "easy");
});

test("fromServerDifficulty maps fancy → hard, others pass through", () => {
  assert.equal(fromServerDifficulty("fancy"), "hard");
  assert.equal(fromServerDifficulty("medium"), "medium");
  assert.equal(fromServerDifficulty("easy"), "easy");
});

// ── assistIngredients ───────────────────────────────────────────────────

test("assistIngredients POSTs to /builder/assist-ingredients and returns the list", async () => {
  nextResponse = () => mockJson(ASSIST_INGREDIENTS_RESPONSE);
  const result = await assistIngredients(ASSIST_INGREDIENTS_INPUT);
  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/builder/assist-ingredients"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(result.ingredients.length, 2);
  assert.equal(result.ingredients[1].name, "Lemon");
  assert.equal(result.ingredients[1].addedByKiwi, true);
});

test("assistIngredients sends the input as JSON body", async () => {
  nextResponse = () => mockJson(ASSIST_INGREDIENTS_RESPONSE);
  await assistIngredients(ASSIST_INGREDIENTS_INPUT);
  assert.ok(lastBody, "expected request body");
  const parsed = JSON.parse(lastBody!);
  assert.equal(parsed.dishTitle, "Lemon roast chicken");
  assert.equal(parsed.existingIngredients[0].name, "Chicken thighs");
});

test("assistIngredients forwards an AbortSignal to fetch", async () => {
  nextResponse = () => mockJson(ASSIST_INGREDIENTS_RESPONSE);
  const controller = new AbortController();
  await assistIngredients(ASSIST_INGREDIENTS_INPUT, {
    signal: controller.signal,
  });
  assert.equal(lastSignal, controller.signal);
});

test("assistIngredients 502 ai_failed propagates as ApiError", async () => {
  nextResponse = () =>
    mockJson(
      { error: "Kiwi got distracted", status: "failed" },
      502,
    );
  await assert.rejects(
    () => assistIngredients(ASSIST_INGREDIENTS_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 502,
  );
});

test("assistIngredients 401 propagates as UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => assistIngredients(ASSIST_INGREDIENTS_INPUT),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

// ── assistSteps ─────────────────────────────────────────────────────────

test("assistSteps POSTs to /builder/assist-steps and returns the steps", async () => {
  nextResponse = () => mockJson(ASSIST_STEPS_RESPONSE);
  const result = await assistSteps(ASSIST_STEPS_INPUT);
  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/builder/assist-steps"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].phaseType, "preheat");
  assert.equal(result.steps[1].content, "Roast 35 minutes.");
});

test("assistSteps forwards an AbortSignal", async () => {
  nextResponse = () => mockJson(ASSIST_STEPS_RESPONSE);
  const controller = new AbortController();
  await assistSteps(ASSIST_STEPS_INPUT, { signal: controller.signal });
  assert.equal(lastSignal, controller.signal);
});

// ── parseMeal ───────────────────────────────────────────────────────────

test("parseMeal POSTs to /builder/parse-meal and parses the envelope", async () => {
  nextResponse = () => mockJson(PARSE_MEAL_SERVER_RESPONSE);
  const result = await parseMeal(PARSE_MEAL_INPUT);
  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/builder/parse-meal"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(result.meal.title, "Weeknight Roast Chicken");
  assert.equal(result.meal.subDishes.length, 1);
});

test("parseMeal maps server difficulty fancy → hard at the wrapper boundary", async () => {
  nextResponse = () => mockJson(PARSE_MEAL_SERVER_RESPONSE);
  const result = await parseMeal(PARSE_MEAL_INPUT);
  // Server emitted "fancy" — wrapper normalizes to UI canon "hard" so the
  // DraftMeal type (which uses UI difficulty) consumes it without a separate
  // mapping pass downstream.
  assert.equal(result.meal.difficulty, "hard");
});

test("parseMeal passes server difficulty medium / easy through unchanged", async () => {
  for (const d of ["easy", "medium"] as const) {
    nextResponse = () =>
      mockJson({
        ...PARSE_MEAL_SERVER_RESPONSE,
        meal: { ...PARSE_MEAL_SERVER_RESPONSE.meal, difficulty: d },
      });
    const result = await parseMeal(PARSE_MEAL_INPUT);
    assert.equal(result.meal.difficulty, d);
  }
});

test("parseMeal forwards an AbortSignal", async () => {
  nextResponse = () => mockJson(PARSE_MEAL_SERVER_RESPONSE);
  const controller = new AbortController();
  await parseMeal(PARSE_MEAL_INPUT, { signal: controller.signal });
  assert.equal(lastSignal, controller.signal);
});

test("parseMeal 402 (premium gate) surfaces as UpgradeRequiredError", async () => {
  nextResponse = () =>
    mockJson(
      {
        error: "upgrade required",
        reason: "Parsing meals from free text is a premium feature.",
      },
      402,
    );
  await assert.rejects(
    () => parseMeal(PARSE_MEAL_INPUT),
    (err: unknown) => err instanceof UpgradeRequiredError,
  );
});

test("parseMeal rejects a malformed response body as ApiSchemaError", async () => {
  // Drop `subDishes` so the schema parse fails.
  const { subDishes: _omit, ...badMeal } = PARSE_MEAL_SERVER_RESPONSE.meal;
  nextResponse = () =>
    mockJson({ status: "success", meal: badMeal });
  await assert.rejects(
    () => parseMeal(PARSE_MEAL_INPUT),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});
