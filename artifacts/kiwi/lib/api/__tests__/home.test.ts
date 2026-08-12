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

import { getHomePayload, getHomeRail, HomePayloadSchema } from "../home";
import { ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { useHomePayload } from "@/hooks/useHomePayload";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

// A list-shaped meal — the `todaysMeal.meal` expansion.
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
  firstPlanCreatedAt: "2026-05-10T00:00:00.000Z",
};

// The empty-state Home payload — no active plan, nothing assigned to today.
const HOME_EMPTY = {
  todaysMeal: null,
  activePlan: null,
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
});

test("HomePayloadSchema parses the all-null empty state", () => {
  const home = HomePayloadSchema.parse(HOME_EMPTY);
  assert.equal(home.todaysMeal, null);
  assert.equal(home.activePlan, null);
});

// WS9-2 2c Commit 6 — REPLACES "rejects an unknown discovery-card badge". The
// field is gone from both the server builder and this schema; the payload the
// client actually reads is exactly these three keys.
test("HomePayloadSchema no longer carries planDiscoveryCards", () => {
  const parsed = HomePayloadSchema.parse(HOME_FULL);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "activePlan",
    "firstPlanCreatedAt",
    "todaysMeal",
  ]);

  // An older server still sending the field parses cleanly (a plain z.object
  // strips unknown keys) — which is what makes the rollout order safe.
  const withLegacy = HomePayloadSchema.parse({
    ...HOME_EMPTY,
    planDiscoveryCards: [{ badge: "featured", plans: [] }],
  });
  assert.ok(!("planDiscoveryCards" in withLegacy));
});

// ── getHomePayload ──────────────────────────────────────────────────────────

test("getHomePayload parses the composite payload", async () => {
  nextResponse = () => mockJson(HOME_FULL);
  const home = await getHomePayload();
  assert.equal(home.todaysMeal?.planName, "Spice It Up");
  assert.equal(home.activePlan?.groceryListId, "gl-1");
});

test("getHomePayload propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => getHomePayload(),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("getHomePayload rejects a malformed response body", async () => {
  // `firstPlanCreatedAt` omitted — fails HomePayloadSchema validation. (It used
  // to be `planDiscoveryCards`, removed in 2c Commit 6; the required-key
  // contract is what this test is really about.)
  nextResponse = () => mockJson({ todaysMeal: null, activePlan: null });
  await assert.rejects(
    () => getHomePayload(),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── WS9-2 2c (D-WS9-154) — getHomeRail ──────────────────────────────────────

const RAIL_ROW = {
  id: "dev-plan-template-game-day-spread",
  name: "Game Day Spread",
  image:
    "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
  tags: ["hosting", "game-day"],
  isFeatured: false,
  isHostingFeatured: true,
};

test("getHomeRail parses the rail and unwraps `plans`", async () => {
  nextResponse = () => mockJson({ plans: [RAIL_ROW] });
  const rail = await getHomeRail();
  assert.equal(rail.length, 1);
  assert.equal(rail[0].name, "Game Day Spread");
  assert.equal(rail[0].isHostingFeatured, true);
});

test("getHomeRail: `image` survives the parse — the rail is the ONLY surface where photos render", async () => {
  nextResponse = () => mockJson({ plans: [RAIL_ROW] });
  const rail = await getHomeRail();
  assert.equal(rail[0].image, RAIL_ROW.image);
});

test("getHomeRail: a MISSING `image` key is a hard parse failure, not a silent blank", async () => {
  // The whole guard chain exists for this: if a server-side projection ever
  // drops imageUrl, res.json omits the key and this must fail LOUDLY rather
  // than rendering six gradient rectangles. `image` is nullable, NOT optional.
  const { image, ...withoutImage } = RAIL_ROW;
  void image;
  nextResponse = () => mockJson({ plans: [withoutImage] });
  await assert.rejects(
    () => getHomeRail(),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("getHomeRail: an explicit null image parses (a curated row may have no photo yet)", async () => {
  nextResponse = () => mockJson({ plans: [{ ...RAIL_ROW, image: null }] });
  const rail = await getHomeRail();
  assert.equal(rail[0].image, null);
});

test("getHomeRail: empty rail parses to an empty array", async () => {
  nextResponse = () => mockJson({ plans: [] });
  assert.deepEqual(await getHomeRail(), []);
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
