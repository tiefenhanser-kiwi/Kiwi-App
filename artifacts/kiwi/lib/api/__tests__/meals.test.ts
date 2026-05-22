// WS7-3 Block B — tests for lib/api/meals.ts getMeal + hooks/useMeal.
//
// getMeal: fetch-mocked round-trips of the single-dish and multi-dish
// GET /meals/:id envelopes, plus 404 / 401 / schema-mismatch error
// propagation. useMeal: the React Query hook's loading -> data and error
// transitions, driven through a real QueryClient + react-test-renderer.
// Harness mirrors client.test.ts (fetch mock) and
// contexts/__tests__/AppContext.favorites.test.ts (renderer + settle).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { asMealsFilters, getMeal, getMeals, MealListItemSchema } from "../meals";
import { ApiError, ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { useMeal } from "@/hooks/useMeal";
import { useMeals } from "@/hooks/useMeals";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

function step(stepIndex: number, text: string, timing = false) {
  return {
    stepIndex,
    text,
    estimatedMinutes: 5,
    phaseType: "cook",
    parallelGroup: null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: timing,
  };
}

function ingredient(name: string, quantity: number, unit: string) {
  return {
    name,
    quantity,
    unit,
    preparationNote: null,
    category: "Protein",
    isOptional: false,
  };
}

// Single-dish meal — dish-level steps fall back to the meal-owned array, so
// the top-level `steps` is populated and dishes[0].steps mirrors it.
const SINGLE_DISH_MEAL = {
  meal: {
    id: "meal-single",
    title: "Salmon Teriyaki",
    cuisine: "Japanese",
    minutes: 30,
    servings: 4,
    calories: 540,
    protein: 38,
    carbs: 32,
    fat: 24,
    tags: ["seafood"],
    image: null,
    description: "Pan-seared salmon.",
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "curated",
    isPublic: true,
    userId: null,
    dishes: [
      {
        dishId: "dish-1",
        title: "Salmon",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 30,
        difficulty: "easy",
        servings: 4,
        ingredients: [ingredient("Salmon fillets", 1.5, "lb")],
        steps: [step(0, "Sear the salmon.", true)],
      },
    ],
    steps: [step(0, "Sear the salmon.", true)],
    notes: null,
  },
};

// Multi-dish meal — each dish carries its own steps, so the top-level
// meal-owned `steps` array is empty.
const MULTI_DISH_MEAL = {
  meal: {
    id: "meal-multi",
    title: "Salmon with Rice Pilaf",
    cuisine: "American",
    minutes: 35,
    servings: 4,
    calories: 640,
    protein: 38,
    carbs: 48,
    fat: 26,
    tags: ["high-protein", "multi-dish"],
    image: null,
    description: "Two dishes plated as one meal.",
    difficulty: "medium",
    mealType: "dinner",
    sourceType: "manual",
    isPublic: true,
    userId: "user-1",
    dishes: [
      {
        dishId: "dish-salmon",
        title: "Seared Salmon",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 15,
        difficulty: "medium",
        servings: 4,
        ingredients: [ingredient("Salmon fillets", 4, "6 oz")],
        steps: [step(0, "Pat salmon dry; season.")],
      },
      {
        dishId: "dish-pilaf",
        title: "Rice Pilaf",
        roleLabel: "side",
        positionIndex: 1,
        minutes: 25,
        difficulty: "easy",
        servings: 4,
        ingredients: [ingredient("Jasmine rice", 1, "cup")],
        steps: [step(0, "Toast the rice."), step(1, "Simmer covered.")],
      },
    ],
    steps: [],
    notes: null,
  },
};

// ── Harness ─────────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;
let lastUrl: string | null;

beforeEach(() => {
  lastUrl = null;
  nextResponse = () => mockJson(SINGLE_DISH_MEAL);
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    lastUrl = url;
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

// Drains in-flight React Query fetches inside an act() pass.
async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

// ── getMeal ─────────────────────────────────────────────────────────────────

test("getMeal parses a single-dish response", async () => {
  nextResponse = () => mockJson(SINGLE_DISH_MEAL);
  const meal = await getMeal("meal-single");
  assert.equal(meal.id, "meal-single");
  assert.equal(meal.cuisine, "Japanese");
  assert.equal(meal.dishes.length, 1);
  // Single-dish: the meal-owned steps array is populated and the dish mirrors it.
  assert.equal(meal.steps.length, 1);
  assert.equal(meal.dishes[0].steps.length, 1);
  assert.equal(meal.dishes[0].title, "Salmon");
});

test("getMeal parses a multi-dish response", async () => {
  nextResponse = () => mockJson(MULTI_DISH_MEAL);
  const meal = await getMeal("meal-multi");
  assert.equal(meal.dishes.length, 2);
  // Multi-dish: steps live per-dish, the top-level meal-owned array is empty.
  assert.equal(meal.steps.length, 0);
  assert.equal(meal.dishes[0].steps.length, 1);
  assert.equal(meal.dishes[1].steps.length, 2);
  assert.equal(meal.dishes[1].roleLabel, "side");
});

test("getMeal propagates a 404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "meal not found" }, 404);
  await assert.rejects(
    () => getMeal("missing"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("getMeal propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => getMeal("meal-single"),
    (err: unknown) => {
      assert.ok(err instanceof UnauthenticatedError);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("getMeal rejects a malformed response body", async () => {
  // `dishes` omitted — fails MealDetailSchema validation.
  const { dishes: _omitted, ...badMeal } = SINGLE_DISH_MEAL.meal;
  nextResponse = () => mockJson({ meal: badMeal });
  await assert.rejects(
    () => getMeal("meal-single"),
    (err: unknown) => {
      assert.ok(err instanceof ApiSchemaError);
      return true;
    },
  );
});

// ── useMeal ─────────────────────────────────────────────────────────────────

test("useMeal transitions from loading to data", async () => {
  nextResponse = () => mockJson(MULTI_DISH_MEAL);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useMeal> | null = null;
  // The synchronous first render is always loading (query pending + fetching)
  // before the mocked fetch resolves; record it rather than racing the act().
  let sawLoading = false;
  function Probe(): null {
    const q = useMeal("meal-multi");
    if (q.isLoading) sawLoading = true;
    latest = q;
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ),
    );
  });

  assert.equal(sawLoading, true);

  await settle(qc);

  assert.equal(latest!.isLoading, false);
  assert.equal(latest!.isError, false);
  assert.equal(latest!.data?.id, "meal-multi");
  assert.equal(latest!.data?.dishes.length, 2);
  renderer.unmount();
});

test("useMeal surfaces an error state for a missing meal", async () => {
  nextResponse = () => mockJson({ error: "meal not found" }, 404);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useMeal> | null = null;
  function Probe(): null {
    latest = useMeal("missing");
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ),
    );
  });

  await settle(qc);

  assert.equal(latest!.isError, true);
  assert.equal(latest!.data, undefined);
  assert.ok(latest!.error instanceof ApiError);
  renderer.unmount();
});

// ── getMeals (GET /me/meals) ────────────────────────────────────────────────
// WS7-3 Block C1 — the filtered Meals-tab list read.

const MEAL_LIST_RESPONSE = {
  meals: [
    {
      id: "meal-list-1",
      title: "Chicken Tikka",
      cuisine: "Indian",
      minutes: 40,
      servings: 4,
      calories: 610,
      protein: 44,
      carbs: 28,
      fat: 32,
      tags: ["high-protein"],
      image: null,
    },
  ],
  nextCursor: "meal-list-1",
};

test("MealListItemSchema parses a renamed-flat list row", () => {
  const m = MealListItemSchema.parse(MEAL_LIST_RESPONSE.meals[0]);
  assert.equal(m.cuisine, "Indian");
  assert.equal(m.minutes, 40);
});

test("getMeals parses the meal-list response", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  const res = await getMeals();
  assert.equal(res.meals.length, 1);
  assert.equal(res.meals[0].id, "meal-list-1");
  assert.equal(res.nextCursor, "meal-list-1");
});

test("getMeals with no filter omits the query param", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  await getMeals();
  assert.ok(lastUrl?.endsWith("/me/meals"), `unexpected url: ${lastUrl}`);
});

test("getMeals serializes a multi-select filter into ?filter=", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  await getMeals(["my_meals", "hosting"]);
  assert.ok(
    lastUrl?.endsWith("/me/meals?filter=my_meals%2Chosting"),
    `unexpected url: ${lastUrl}`,
  );
});

test("getMeals rejects a malformed response body", async () => {
  nextResponse = () => mockJson({ meals: [{ id: "x" }], nextCursor: null });
  await assert.rejects(
    () => getMeals(),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── asMealsFilters (relocated from lib/stubs.ts in WS7-3 C3 c1) ──────────────

test("asMealsFilters: null / undefined / empty input → []", () => {
  assert.deepEqual(asMealsFilters(null), []);
  assert.deepEqual(asMealsFilters(undefined), []);
  assert.deepEqual(asMealsFilters([]), []);
});

test("asMealsFilters: preserves the four canonical keys", () => {
  assert.deepEqual(
    asMealsFilters(["my_meals", "featured", "top_rated", "hosting"]),
    ["my_meals", "featured", "top_rated", "hosting"],
  );
});

test("asMealsFilters: drops unknown keys silently", () => {
  // Legacy / unknown values that may live in older saved state are dropped
  // rather than throwing — the screen still renders with the empty set.
  assert.deepEqual(
    asMealsFilters(["my_meals", "all_meals", "garbage", "featured"]),
    ["my_meals", "featured"],
  );
});

test("useMeals transitions from loading to data", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useMeals> | null = null;
  let sawLoading = false;
  function Probe(): null {
    const q = useMeals(["my_meals"]);
    if (q.isLoading) sawLoading = true;
    latest = q;
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ),
    );
  });

  assert.equal(sawLoading, true);
  await settle(qc);

  assert.equal(latest!.isLoading, false);
  assert.equal(latest!.data?.meals.length, 1);
  assert.equal(latest!.data?.meals[0].id, "meal-list-1");
  renderer.unmount();
});
