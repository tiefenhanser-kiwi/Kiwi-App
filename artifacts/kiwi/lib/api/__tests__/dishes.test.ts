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
  saveDish,
  updateDish,
  type SaveDishInput,
  type UpdateDishInput,
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
  // WS7-6 B-fix Block 3: live-meal use count is now a required wire field.
  mealUseCount: 2,
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

// ── getDishes sort/limit/cursor params (WS7-6 B-fix Block 3) ─────────────

test("getDishes omits sort/limit/cursor when no opts are passed", async () => {
  await getDishes(["my_dishes"]);
  assert.ok(lastUrl, "expected a url");
  assert.ok(!lastUrl!.includes("sort="), `sort leaked: ${lastUrl}`);
  assert.ok(!lastUrl!.includes("limit="), `limit leaked: ${lastUrl}`);
  assert.ok(!lastUrl!.includes("cursor="), `cursor leaked: ${lastUrl}`);
  // filter is still present and is the only param.
  assert.ok(lastUrl!.endsWith("/me/dishes?filter=my_dishes"), lastUrl!);
});

test("getDishes appends sort, limit and cursor when provided", async () => {
  await getDishes(["my_dishes"], {
    sort: "times_cooked",
    limit: 25,
    cursor: "opaque-cursor-abc",
  });
  assert.ok(lastUrl, "expected a url");
  assert.ok(lastUrl!.includes("sort=times_cooked"), lastUrl!);
  assert.ok(lastUrl!.includes("limit=25"), lastUrl!);
  // URLSearchParams percent-encodes nothing here, but assert the value round-trips.
  assert.ok(lastUrl!.includes("cursor=opaque-cursor-abc"), lastUrl!);
});

test("getDishes can send sort with no filter", async () => {
  await getDishes(undefined, { sort: "cook_time" });
  assert.ok(lastUrl, "expected a url");
  assert.ok(!lastUrl!.includes("filter="), `filter leaked: ${lastUrl}`);
  assert.ok(lastUrl!.endsWith("/me/dishes?sort=cook_time"), lastUrl!);
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
  // useInfiniteQuery now: the hook exposes a flattened `dishes` helper.
  assert.equal(latest!.dishes.length, 1);
  renderer.unmount();
});

test("useDishes paginates two pages and flattens them; hasNextPage flips false", async () => {
  // Page 1 (no cursor) → 2 rows + a cursor; page 2 (cursor present) → 1 row,
  // nextCursor null. The fetch mock branches on the cursor query param.
  const row = (id: string) => ({ ...DISH_LIST_ITEM, id });
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    lastUrl = url;
    if (url.includes("cursor=")) {
      return mockJson({ dishes: [row("d-3")], nextCursor: null });
    }
    return mockJson({ dishes: [row("d-1"), row("d-2")], nextCursor: "cur-1" });
  }) as unknown as typeof fetch;

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useDishes> | null = null;
  function Probe(): null {
    latest = useDishes(["my_dishes"]);
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

  // Page 1 loaded: 2 flattened rows, more pages available.
  assert.equal(latest!.dishes.length, 2);
  assert.equal(latest!.hasNextPage, true);
  assert.deepEqual(
    latest!.dishes.map((d) => d.id),
    ["d-1", "d-2"],
  );

  // Fetch page 2 → flattened to 3, no more pages.
  await act(async () => {
    await latest!.fetchNextPage();
  });
  await settle(qc);

  assert.equal(latest!.dishes.length, 3);
  assert.equal(latest!.hasNextPage, false);
  assert.deepEqual(
    latest!.dishes.map((d) => d.id),
    ["d-1", "d-2", "d-3"],
  );
  // Page 2 request carried the cursor minted by page 1.
  assert.ok(lastUrl?.includes("cursor=cur-1"), `unexpected url: ${lastUrl}`);
  renderer.unmount();
});

test("useDishes refetches with the new ?sort= when the sort key changes", async () => {
  const seenSorts: string[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    lastUrl = url;
    const m = /[?&]sort=([^&]+)/.exec(url);
    if (m) seenSorts.push(m[1]);
    return mockJson(DISH_LIST_RESPONSE);
  }) as unknown as typeof fetch;

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe({ sort }: { sort: "alpha" | "times_cooked" }): null {
    useDishes(["my_dishes"], sort);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe, { sort: "alpha" }),
      ),
    );
  });
  await settle(qc);
  assert.ok(seenSorts.includes("alpha"), `alpha not requested: ${seenSorts}`);

  // Flip the sort — a distinct query key → a fresh fetch with the new param.
  await act(async () => {
    renderer.update(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe, { sort: "times_cooked" }),
      ),
    );
  });
  await settle(qc);
  assert.ok(
    seenSorts.includes("times_cooked"),
    `times_cooked not requested after sort change: ${seenSorts}`,
  );
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

// ── saveDish (WS7-6 Block 1E) ────────────────────────────────────────────
// Pins POST /me/dishes: wire shape, envelope parse, typed-error surface.

const SAVE_DISH_INPUT: SaveDishInput = {
  title: "Garlic Rice Pilaf",
  estimatedTimeMinutes: 25,
  servingsDefault: 4,
  sourceType: "manual",
  ingredients: [
    { name: "Long-grain rice", quantity: 1, unit: "cup" },
    { name: "Garlic", quantity: 2, unit: "cloves" },
  ],
  steps: [{ text: "Toast rice in oil.", estimatedMinutes: 3 }],
};

interface CapturedRequest {
  method: string | null;
  body: string | null;
  url: string | null;
}

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

test("saveDish POSTs to /me/dishes and returns the new dish id", async () => {
  const captured = captureNextRequest(
    mockJson({ dish: { id: "dish-new-1" } }, 201),
  );
  const result = await saveDish(SAVE_DISH_INPUT);
  assert.equal(captured.method, "POST");
  assert.ok(
    captured.url?.endsWith("/me/dishes"),
    `unexpected url: ${captured.url}`,
  );
  assert.equal(result.id, "dish-new-1");
});

test("saveDish sends ingredients + steps as a JSON body", async () => {
  const captured = captureNextRequest(
    mockJson({ dish: { id: "dish-new-2" } }, 201),
  );
  await saveDish(SAVE_DISH_INPUT);
  assert.ok(captured.body, "expected a request body");
  const parsed = JSON.parse(captured.body!);
  assert.equal(parsed.title, "Garlic Rice Pilaf");
  assert.equal(parsed.ingredients.length, 2);
  assert.equal(parsed.steps[0].text, "Toast rice in oil.");
});

test("saveDish 400 validation propagates as ApiError", async () => {
  captureNextRequest(mockJson({ error: "invalid body" }, 400));
  await assert.rejects(
    () => saveDish(SAVE_DISH_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );
});

test("saveDish 401 propagates as UnauthenticatedError", async () => {
  captureNextRequest(mockJson({ error: "unauthenticated" }, 401));
  await assert.rejects(
    () => saveDish(SAVE_DISH_INPUT),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("saveDish rejects a malformed response body as ApiSchemaError", async () => {
  // Drop `dish` — schema parse fails.
  captureNextRequest(mockJson({ result: { id: "x" } }, 201));
  await assert.rejects(
    () => saveDish(SAVE_DISH_INPUT),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── updateDish (PATCH /me/dishes/:id) — WS7-6 1A ────────────────────────

const UPDATE_DISH_SCALAR_INPUT: UpdateDishInput = {
  title: "Renamed dish",
  difficulty: "medium",
};

test("updateDish PATCHes /me/dishes/:id and returns the dish id", async () => {
  const captured = captureNextRequest(
    mockJson({ dish: { id: "dish-1" } }, 200),
  );
  const result = await updateDish("dish-1", UPDATE_DISH_SCALAR_INPUT);
  assert.equal(captured.method, "PATCH");
  assert.ok(captured.url?.endsWith("/me/dishes/dish-1"));
  assert.equal(result.id, "dish-1");
});

test("updateDish sends the scalar-only patch body verbatim", async () => {
  const captured = captureNextRequest(
    mockJson({ dish: { id: "dish-1" } }, 200),
  );
  await updateDish("dish-1", UPDATE_DISH_SCALAR_INPUT);
  assert.ok(captured.body);
  const parsed = JSON.parse(captured.body!);
  assert.equal(parsed.title, "Renamed dish");
  assert.equal(parsed.difficulty, "medium");
  assert.equal(Object.keys(parsed).length, 2);
});

test("updateDish forwards an ingredients/steps sub-graph patch (wipe-and-recreate trigger)", async () => {
  const captured = captureNextRequest(
    mockJson({ dish: { id: "dish-1" } }, 200),
  );
  await updateDish("dish-1", {
    ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
    steps: [{ text: "Sprinkle." }, { text: "Serve." }],
  });
  assert.ok(captured.body);
  const parsed = JSON.parse(captured.body!);
  assert.ok(Array.isArray(parsed.ingredients), "ingredients[] forwarded");
  assert.ok(Array.isArray(parsed.steps), "steps[] forwarded");
  assert.equal(parsed.ingredients[0].name, "Salt");
  assert.equal(parsed.steps.length, 2);
});

test("updateDish 403 (foreign-owned) propagates as ApiError", async () => {
  captureNextRequest(
    mockJson({ error: "dish not owned by user" }, 403),
  );
  await assert.rejects(
    () => updateDish("dish-foreign", UPDATE_DISH_SCALAR_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 403,
  );
});

test("updateDish 404 (missing/archived/curated) propagates as ApiError", async () => {
  captureNextRequest(mockJson({ error: "dish not found" }, 404));
  await assert.rejects(
    () => updateDish("dish-missing", UPDATE_DISH_SCALAR_INPUT),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("updateDish 400 (validation: empty patch) propagates as ApiError", async () => {
  captureNextRequest(mockJson({ error: "invalid body" }, 400));
  await assert.rejects(
    () => updateDish("dish-1", {}),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );
});

test("updateDish 401 propagates as UnauthenticatedError", async () => {
  captureNextRequest(mockJson({ error: "unauthenticated" }, 401));
  await assert.rejects(
    () => updateDish("dish-1", UPDATE_DISH_SCALAR_INPUT),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("updateDish URL-encodes the dish id (defensive, mirrors updateMeal)", async () => {
  const captured = captureNextRequest(mockJson({ dish: { id: "x" } }, 200));
  await updateDish("with spaces/and slashes", UPDATE_DISH_SCALAR_INPUT);
  assert.ok(captured.url);
  assert.ok(!captured.url!.includes(" "));
  assert.ok(captured.url!.includes("with%20spaces"));
});
