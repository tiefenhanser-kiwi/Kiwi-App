// WS7-3 Block C1 — tests for lib/api/home.ts.
// C1.1 covers the getter + schema: getHomePayload fetch-mocked round-trips of
// the populated and the all-null GET /home composite, plus 401 / schema-
// mismatch propagation. The useHomePayload hook test is appended in C1.2.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { getHomePayload, HomePayloadSchema } from "../home";
import { ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

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
  },
  planDiscoveryCards: [{ badge: "my_plans", plans: [PLAN_LIST_ITEM] }],
};

// The empty-state Home payload — no active plan, nothing assigned to today.
const HOME_EMPTY = {
  todaysMeal: null,
  activePlan: null,
  planDiscoveryCards: [{ badge: "featured", plans: [] }],
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
