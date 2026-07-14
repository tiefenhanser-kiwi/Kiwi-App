// WS7-3 Block C1 — tests for lib/api/home.ts.
// Covers the getter + schema (getHomePayload fetch-mocked round-trips of the
// populated and the all-null GET /home composite, 401 / schema-mismatch
// propagation) and the useHomePayload React Query hook (loading→data, error).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { getHomePayload, HomePayloadSchema } from "../home";
import { ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { useHomePayload } from "@/hooks/useHomePayload";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

// A list-shaped meal — `todaysMeal.meal` and each discovery card's plans.
const MEAL_LIST_ITEM = {
  id: "meal-1",
  title: "Salmon Teriyaki",
  cuisine: "Japanese",
  minutes: 30,
  servings: 4,
  authoredServingsDefault: 4,
  calories: 540,
  protein: 38,
  carbs: 32,
  fat: 24,
  tags: ["seafood"],
  image: null,
};

const PLAN_LIST_ITEM = {
  id: "plan-1",
  name: "Spice It Up",
  description: "A bold week.",
  image: null,
  tags: ["spicy"],
  source: "instance",
  status: "this_week",
  startDate: "2026-05-18T00:00:00.000Z",
  endDate: "2026-05-24T00:00:00.000Z",
  isActiveThisWeek: true,
};

// A fully-populated Home payload.
const HOME_FULL = {
  todaysMeal: {
    mealPlanItemId: "item-1",
    dayOffset: 2,
    planId: "plan-1",
    planName: "Spice It Up",
    meal: MEAL_LIST_ITEM,
  },
  activePlan: {
    id: "plan-1",
    name: "Spice It Up",
    status: "this_week",
    startDate: "2026-05-18T00:00:00.000Z",
    endDate: "2026-05-24T00:00:00.000Z",
    revisionId: 3,
    groceryListId: "gl-1",
  },
  planDiscoveryCards: [{ badge: "my_plans", plans: [PLAN_LIST_ITEM] }],
  firstPlanCreatedAt: "2026-05-10T00:00:00.000Z",
};

// The empty-state Home payload — no active plan, nothing assigned to today.
const HOME_EMPTY = {
  todaysMeal: null,
  activePlan: null,
  planDiscoveryCards: [{ badge: "featured", plans: [] }],
  firstPlanCreatedAt: null,
};

// ── Harness ─────────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;

beforeEach(() => {
  nextResponse = () => mockJson(HOME_FULL);
  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    nextResponse()) as unknown as typeof fetch;
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

// ── Schema ──────────────────────────────────────────────────────────────────

test("HomePayloadSchema parses a fully-populated payload", () => {
  const home = HomePayloadSchema.parse(HOME_FULL);
  assert.equal(home.todaysMeal?.meal.id, "meal-1");
  assert.equal(home.activePlan?.revisionId, 3);
  assert.equal(home.planDiscoveryCards[0].badge, "my_plans");
});

test("HomePayloadSchema parses the all-null empty state", () => {
  const home = HomePayloadSchema.parse(HOME_EMPTY);
  assert.equal(home.todaysMeal, null);
  assert.equal(home.activePlan, null);
  assert.equal(home.planDiscoveryCards[0].plans.length, 0);
});

test("HomePayloadSchema rejects an unknown discovery-card badge", () => {
  const bad = {
    ...HOME_EMPTY,
    planDiscoveryCards: [{ badge: "trending", plans: [] }],
  };
  assert.equal(HomePayloadSchema.safeParse(bad).success, false);
});

// ── getHomePayload ──────────────────────────────────────────────────────────

test("getHomePayload parses the composite payload", async () => {
  nextResponse = () => mockJson(HOME_FULL);
  const home = await getHomePayload();
  assert.equal(home.todaysMeal?.planName, "Spice It Up");
  assert.equal(home.planDiscoveryCards.length, 1);
});

test("getHomePayload propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => getHomePayload(),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("getHomePayload rejects a malformed response body", async () => {
  // `planDiscoveryCards` omitted — fails HomePayloadSchema validation.
  nextResponse = () => mockJson({ todaysMeal: null, activePlan: null });
  await assert.rejects(
    () => getHomePayload(),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── useHomePayload ──────────────────────────────────────────────────────────

// Drains in-flight React Query fetches inside an act() pass.
async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

async function mountProbe(
  qc: QueryClient,
  recordLatest: () => void,
): Promise<TestRenderer.ReactTestRenderer> {
  function Probe(): null {
    recordLatest();
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
  return renderer;
}

test("useHomePayload transitions from loading to data", async () => {
  nextResponse = () => mockJson(HOME_FULL);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useHomePayload> | null = null;
  let sawLoading = false;
  const renderer = await mountProbe(qc, () => {
    latest = useHomePayload();
    if (latest.isLoading) sawLoading = true;
  });

  assert.equal(sawLoading, true);
  await settle(qc);

  assert.equal(latest!.isLoading, false);
  assert.equal(latest!.data?.todaysMeal?.meal.id, "meal-1");
  renderer.unmount();
});

test("useHomePayload surfaces an error state on a 401", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useHomePayload> | null = null;
  const renderer = await mountProbe(qc, () => {
    latest = useHomePayload();
  });

  await settle(qc);

  assert.equal(latest!.isError, true);
  assert.equal(latest!.data, undefined);
  renderer.unmount();
});
