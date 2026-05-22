// WS7-3 Block C1 — tests for lib/api/dishes.ts.
// Covers the getters + schemas (getDishes / getDish fetch-mocked round-trips,
// the ?filter= query construction, 404 / 401 / schema-mismatch propagation)
// and the useDishes / useDish React Query hooks (loading→data, enabled gating).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import {
  DishDetailSchema,
  DishListItemSchema,
  getDish,
  getDishes,
} from "../dishes";
import { ApiError, ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { useDish } from "@/hooks/useDish";
import { useDishes } from "@/hooks/useDishes";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

const DISH_LIST_ITEM = {
  id: "dish-1",
  title: "Rice Pilaf",
  minutes: 20,
  servings: 4,
  difficulty: "easy",
  calories: 320,
  protein: 8,
  carbs: 52,
  fat: 9,
  tags: ["side"],
  image: null,
};

const DISH_LIST_RESPONSE = {
  dishes: [DISH_LIST_ITEM],
  nextCursor: "dish-1",
};

const DISH_DETAIL_RESPONSE = {
  dish: {
    id: "dish-1",
    title: "Rice Pilaf",
    description: "A fragrant pilaf.",
    image: null,
    difficulty: "easy",
    minutes: 20,
    servings: 4,
    calories: 320,
    protein: 8,
    carbs: 52,
    fat: 9,
    tags: ["side"],
    sourceType: "manual",
    userId: "user-1",
    ingredients: [
      {
        name: "Basmati rice",
        quantity: 1,
        unit: "cup",
        preparationNote: null,
        category: "Pantry",
        isOptional: false,
      },
    ],
    steps: [
      {
        stepIndex: 0,
        text: "Toast the rice.",
        estimatedMinutes: 3,
        phaseType: "prep",
        parallelGroup: null,
        requiresPreheat: false,
        requiresRest: false,
        requiresMarination: false,
        isTimingSensitive: false,
      },
    ],
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
  nextResponse = () => mockJson(DISH_LIST_RESPONSE);
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

// ── Schemas ─────────────────────────────────────────────────────────────────

test("DishListItemSchema parses a list row", () => {
  const d = DishListItemSchema.parse(DISH_LIST_ITEM);
  assert.equal(d.difficulty, "easy");
});

test("DishDetailSchema parses detail with a nullable userId", () => {
  const dish = DishDetailSchema.parse({
    ...DISH_DETAIL_RESPONSE.dish,
    userId: null,
  });
  assert.equal(dish.userId, null);
  assert.equal(dish.ingredients.length, 1);
  assert.equal(dish.steps[0].text, "Toast the rice.");
});

// ── getDishes ───────────────────────────────────────────────────────────────

test("getDishes parses the dish-list response", async () => {
  const res = await getDishes();
  assert.equal(res.dishes.length, 1);
  assert.equal(res.nextCursor, "dish-1");
});

test("getDishes with no filter omits the query param", async () => {
  await getDishes();
  assert.ok(lastUrl?.endsWith("/me/dishes"), `unexpected url: ${lastUrl}`);
});

test("getDishes serializes a multi-select filter into ?filter=", async () => {
  await getDishes(["my_dishes", "top_rated"]);
  assert.ok(
    lastUrl?.endsWith("/me/dishes?filter=my_dishes%2Ctop_rated"),
    `unexpected url: ${lastUrl}`,
  );
});

test("getDishes propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => getDishes(),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

// ── getDish ─────────────────────────────────────────────────────────────────

test("getDish unwraps and parses the dish envelope", async () => {
  nextResponse = () => mockJson(DISH_DETAIL_RESPONSE);
  const dish = await getDish("dish-1");
  assert.equal(dish.id, "dish-1");
  assert.equal(dish.minutes, 20);
});

test("getDish propagates a 404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "dish not found" }, 404);
  await assert.rejects(
    () => getDish("missing"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("getDish rejects a malformed response body", async () => {
  const { steps: _omit, ...badDish } = DISH_DETAIL_RESPONSE.dish;
  nextResponse = () => mockJson({ dish: badDish });
  await assert.rejects(
    () => getDish("dish-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── useDishes / useDish ─────────────────────────────────────────────────────

// Drains in-flight React Query fetches inside an act() pass.
async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

test("useDishes transitions from loading to data", async () => {
  nextResponse = () => mockJson(DISH_LIST_RESPONSE);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useDishes> | null = null;
  let sawLoading = false;
  function Probe(): null {
    const q = useDishes(["my_dishes"]);
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
  assert.equal(latest!.data?.dishes.length, 1);
  renderer.unmount();
});

test("useDish is disabled for an empty id", async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useDish> | null = null;
  function Probe(): null {
    latest = useDish("");
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

  // enabled:false — the query never fetches; it stays idle with no data.
  assert.equal(latest!.fetchStatus, "idle");
  assert.equal(latest!.data, undefined);
  renderer.unmount();
});
