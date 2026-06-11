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

import {
  asMealsFilters,
  getMeal,
  getMeals,
  MealListItemSchema,
  saveMeal,
  updateMeal,
  type SaveMealInput,
  type UpdateMealInput,
} from "../meals";
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

// WS7-6 G2 scope (iii): sort / cursor / limit opts (mirrors getDishes).

test("getMeals appends ?sort= when provided", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  await getMeals(["my_meals"], { sort: "date_created" });
  assert.ok(lastUrl?.includes("sort=date_created"), `unexpected url: ${lastUrl}`);
});

test("getMeals appends cursor + limit when provided", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  await getMeals(["my_meals"], { cursor: "abc123", limit: 10 });
  assert.ok(lastUrl?.includes("cursor=abc123"), `unexpected url: ${lastUrl}`);
  assert.ok(lastUrl?.includes("limit=10"), `unexpected url: ${lastUrl}`);
});

test("getMeals with no opts omits sort/cursor/limit (byte-identical wire)", async () => {
  nextResponse = () => mockJson(MEAL_LIST_RESPONSE);
  await getMeals(["my_meals"]);
  assert.ok(
    lastUrl?.endsWith("/me/meals?filter=my_meals"),
    `unexpected url: ${lastUrl}`,
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

// ── saveMeal (WS7-6 Block 1E) ────────────────────────────────────────────
// Pins POST /me/meals: the wire shape (manual `kind:"new"` vs Mode-C
// `kind:"link"`), the success envelope parse, and the typed-error surface
// for the load-bearing failure modes (403 linked-dish-not-owned, 400
// validation, 401 auth).

const SAVE_MEAL_MANUAL_INPUT: SaveMealInput = {
  title: "Lemon Roast Chicken Dinner",
  cuisineType: "American",
  servingsDefault: 4,
  estimatedTimeMinutes: 45,
  difficulty: "fancy",
  sourceType: "manual",
  dishes: [
    {
      kind: "new",
      title: "Roast chicken",
      role: "main",
      positionIndex: 0,
      ingredients: [
        { name: "Whole chicken", quantity: 1, unit: "whole" },
        { name: "Lemon", quantity: 2, unit: "whole" },
      ],
      steps: [
        { text: "Roast at 425°F for 45 min.", estimatedMinutes: 45 },
      ],
    },
  ],
};

const SAVE_MEAL_MODE_C_INPUT: SaveMealInput = {
  title: "Chicken + Pilaf",
  servingsDefault: 4,
  sourceType: "manual",
  dishes: [
    { kind: "link", dishId: "dish-existing-1", role: "main", positionIndex: 0 },
    { kind: "link", dishId: "dish-existing-2", role: "side", positionIndex: 1 },
  ],
};

interface CapturedRequest {
  method: string | null;
  body: string | null;
  url: string | null;
}

// Replaces the default fetch stub for one test with one that captures
// method/body/url. Returns the captured-request handle so the test can
// assert against the wire shape directly.
function captureNextRequest(response: Response): CapturedRequest {
  const captured: CapturedRequest = { method: null, body: null, url: null };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    captured.url = url;
    captured.method = init?.method ?? "GET";
    captured.body = typeof init?.body === "string" ? init.body : null;
    return response;
  }) as unknown as typeof fetch;
  return captured;
}

test("saveMeal POSTs to /me/meals and returns the new meal id + dishIds", async () => {
  const captured = captureNextRequest(
    mockJson(
      {
        meal: {
          id: "meal-new-1",
          dishIds: ["dish-new-1"],
          linksCreated: 1,
        },
      },
      201,
    ),
  );
  const result = await saveMeal(SAVE_MEAL_MANUAL_INPUT);
  assert.equal(captured.method, "POST");
  assert.ok(
    captured.url?.endsWith("/me/meals"),
    `unexpected url: ${captured.url}`,
  );
  assert.equal(result.id, "meal-new-1");
  assert.deepEqual(result.dishIds, ["dish-new-1"]);
  assert.equal(result.linksCreated, 1);
});

test("saveMeal sends the manual-mode input shape (kind:'new') verbatim", async () => {
  const captured = captureNextRequest(
    mockJson(
      { meal: { id: "meal-new-2", dishIds: ["dish-new-2"], linksCreated: 1 } },
      201,
    ),
  );
  await saveMeal(SAVE_MEAL_MANUAL_INPUT);
  assert.ok(captured.body, "expected a request body");
  const parsed = JSON.parse(captured.body!);
  assert.equal(parsed.title, "Lemon Roast Chicken Dinner");
  assert.equal(parsed.difficulty, "fancy");
  assert.equal(parsed.dishes[0].kind, "new");
  assert.equal(parsed.dishes[0].title, "Roast chicken");
  assert.equal(parsed.dishes[0].ingredients.length, 2);
});

test("saveMeal sends Mode-C kind:'link' payload with dishId references (WS7-6 1E key contract)", async () => {
  const captured = captureNextRequest(
    mockJson(
      {
        meal: {
          id: "meal-mode-c-1",
          dishIds: ["dish-existing-1", "dish-existing-2"],
          linksCreated: 2,
        },
      },
      201,
    ),
  );
  const result = await saveMeal(SAVE_MEAL_MODE_C_INPUT);
  assert.ok(captured.body, "expected a request body");
  const parsed = JSON.parse(captured.body!);
  // Critical: each Mode-C dish must be a link discriminant with a real
  // server dishId — anything else fails the server's ownership/existence
  // check and fails the save.
  assert.equal(parsed.dishes.length, 2);
  assert.equal(parsed.dishes[0].kind, "link");
  assert.equal(parsed.dishes[0].dishId, "dish-existing-1");
  assert.equal(parsed.dishes[1].kind, "link");
  assert.equal(parsed.dishes[1].dishId, "dish-existing-2");
  // Response surfaces linksCreated for the caller.
  assert.equal(result.linksCreated, 2);
});

test("saveMeal 403 (linked dish not owned) propagates as ApiError", async () => {
  captureNextRequest(
    mockJson(
      {
        error: "linked dish(es) not owned by user",
        forbidden: ["dish-someone-else"],
      },
      403,
    ),
  );
  await assert.rejects(
    () => saveMeal(SAVE_MEAL_MODE_C_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
});

test("saveMeal 404 (linked dish not found) propagates as ApiError", async () => {
  captureNextRequest(
    mockJson(
      { error: "linked dish(es) not found", missing: ["dish-missing"] },
      404,
    ),
  );
  await assert.rejects(
    () => saveMeal(SAVE_MEAL_MODE_C_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("saveMeal 400 (validation) propagates as ApiError", async () => {
  captureNextRequest(mockJson({ error: "invalid body" }, 400));
  await assert.rejects(
    () => saveMeal(SAVE_MEAL_MANUAL_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );
});

test("saveMeal 401 propagates as UnauthenticatedError", async () => {
  captureNextRequest(mockJson({ error: "unauthenticated" }, 401));
  await assert.rejects(
    () => saveMeal(SAVE_MEAL_MANUAL_INPUT),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("saveMeal rejects a malformed response body as ApiSchemaError", async () => {
  // Server returned the envelope without `dishIds` — schema parse fails.
  captureNextRequest(mockJson({ meal: { id: "x", linksCreated: 0 } }, 201));
  await assert.rejects(
    () => saveMeal(SAVE_MEAL_MANUAL_INPUT),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── updateMeal (PATCH /me/meals/:id) — WS7-6 1A + 1F ────────────────────

const UPDATE_MEAL_SCALAR_INPUT: UpdateMealInput = {
  title: "Renamed meal",
  difficulty: "medium",
};

test("updateMeal PATCHes /me/meals/:id and returns the meal id", async () => {
  const captured = captureNextRequest(
    mockJson({ meal: { id: "meal-1" } }, 200),
  );
  const result = await updateMeal("meal-1", UPDATE_MEAL_SCALAR_INPUT);
  assert.equal(captured.method, "PATCH");
  assert.ok(captured.url?.endsWith("/me/meals/meal-1"));
  assert.equal(result.id, "meal-1");
});

test("updateMeal sends the patch body verbatim (scalar-only)", async () => {
  const captured = captureNextRequest(
    mockJson({ meal: { id: "meal-1" } }, 200),
  );
  await updateMeal("meal-1", UPDATE_MEAL_SCALAR_INPUT);
  assert.ok(captured.body);
  const parsed = JSON.parse(captured.body!);
  assert.equal(parsed.title, "Renamed meal");
  assert.equal(parsed.difficulty, "medium");
  assert.equal(Object.keys(parsed).length, 2);
});

test("updateMeal forwards a dishes[] sub-graph patch (wipe-and-recreate trigger)", async () => {
  const captured = captureNextRequest(
    mockJson(
      {
        meal: { id: "meal-1", dishIds: ["dish-new-A"], linksCreated: 1 },
      },
      200,
    ),
  );
  const result = await updateMeal("meal-1", {
    dishes: [
      {
        kind: "new",
        title: "Replacement",
        role: "main",
        positionIndex: 0,
        ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
        steps: [{ text: "Sprinkle." }],
      },
    ],
  });
  assert.ok(captured.body);
  const parsed = JSON.parse(captured.body!);
  assert.equal(parsed.dishes[0].kind, "new");
  assert.deepEqual(result.dishIds, ["dish-new-A"]);
  assert.equal(result.linksCreated, 1);
});

test("updateMeal 403 (foreign-owned) propagates as ApiError", async () => {
  captureNextRequest(
    mockJson({ error: "meal not owned by user" }, 403),
  );
  await assert.rejects(
    () => updateMeal("meal-foreign", UPDATE_MEAL_SCALAR_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
});

test("updateMeal 404 (missing/archived/curated) propagates as ApiError", async () => {
  captureNextRequest(mockJson({ error: "meal not found" }, 404));
  await assert.rejects(
    () => updateMeal("meal-missing", UPDATE_MEAL_SCALAR_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("updateMeal 400 (validation: empty patch) propagates as ApiError", async () => {
  captureNextRequest(mockJson({ error: "invalid body" }, 400));
  await assert.rejects(
    () => updateMeal("meal-1", {}),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );
});

test("updateMeal 401 propagates as UnauthenticatedError", async () => {
  captureNextRequest(mockJson({ error: "unauthenticated" }, 401));
  await assert.rejects(
    () => updateMeal("meal-1", UPDATE_MEAL_SCALAR_INPUT),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("updateMeal URL-encodes the meal id", async () => {
  // Defensive — the server's :id param is a cuid in production but the
  // client must not break on edge characters (e.g. a future migration to a
  // composite identifier). encodeURIComponent matches getMeal's posture.
  const captured = captureNextRequest(mockJson({ meal: { id: "x" } }, 200));
  await updateMeal("with spaces/and slashes", UPDATE_MEAL_SCALAR_INPUT);
  assert.ok(captured.url);
  assert.ok(!captured.url!.includes(" "));
  assert.ok(captured.url!.includes("with%20spaces"));
});
