// BUG-110 + BUG-104 — the plan-mutation invalidation contract.
//
// BUG-110: `invalidateQueries({ queryKey: ["plans", planId] })` matched NO
// live query. The full key inventory under "plans" is ["plans","detail",id],
// ["plans","list",filter] and ["plans","template",id] — a plan id at index 1
// matches none of them. At handleMutationResult it was masked by the broad
// ["plans"] on the next line; at dispatchRecalcMacros it was the ONLY
// invalidation, so after an AI macro recalc Plan Review never refetched.
//
// A dead key fails EXACTLY like a slow network, which is why it survived. The
// test below is shaped to tell them apart: it holds the recalc POST open, takes
// the fetch count AFTER the mutation's own invalidation has settled, then
// releases the recalc and asserts one FURTHER fetch. With the dead key there is
// no further fetch and it goes red.
//
// BUG-104: handleMutationResult must DEFER its invalidations while an
// optimistic write is in flight (beginPlanWrite / endPlanWrite), because a
// mid-burst refetch is what reverted a sibling write's optimism in the cache.
//
// Harness style mirrors AppContext.mutators.test.ts — full
// QueryClient → AuthProvider → AppProvider tree over a mocked fetch.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { AppProvider, useApp } from "../AppContext";
import { AuthProvider } from "../AuthContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type AppValue = ReturnType<typeof useApp>;

let app: AppValue | null = null;
let activeRenderer: TestRenderer.ReactTestRenderer | null = null;
let routeTable: Map<string, () => Response>;

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function route(method: string, suffix: string, make: () => Response): void {
  routeTable.set(`${method} ${suffix}`, make);
}

function makeUser() {
  return {
    id: "u1",
    email: "hans@example.com",
    firstName: "Hans",
    lastName: "T",
    phone: null,
    zipCode: null,
    timezone: "UTC",
    accountStatus: "active",
    subscriptionStatus: "trialing",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    marketingConsentEmail: false,
    marketingConsentSms: false,
    onboardingComplete: true,
    firstRunChoiceMade: true,
    subscription: {
      status: "trialing",
      planCode: "free",
      trialEndsAt: null,
      currentPeriodEnd: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A PATCH /plans/:id/items/:itemId response carrying macrosStale. */
function itemMutationResponse(macrosStale: boolean) {
  return {
    item: {
      id: "item-1",
      mealId: "meal-1",
      positionIndex: 0,
      assignedDayOfWeek: "Tuesday",
      assignedDate: null,
      servingsOverride: null,
      isBreakfast: false,
      isLunch: false,
      isDinner: true,
      notes: null,
      meal: null,
    },
    planId: "plan-1",
    revisionId: 2,
    macrosStale,
  };
}

const RECALC_BODY = {
  dailyAverages: {
    caloriesPerDay: 500,
    proteinGPerDay: 30,
    carbsGPerDay: 40,
    fatGPerDay: 20,
  },
};

beforeEach(() => {
  routeTable = new Map();
  app = null;
  activeRenderer = null;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    for (const [key, make] of routeTable) {
      const sep = key.indexOf(" ");
      const m = key.slice(0, sep);
      const suffix = key.slice(sep + 1);
      if (m === method && u.endsWith(suffix)) return Promise.resolve(make());
    }
    return Promise.resolve(mockJson({}, 200));
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  (AsyncStorage as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

afterEach(() => {
  if (activeRenderer) {
    try {
      activeRenderer.unmount();
    } catch {
      // already unmounted
    }
    activeRenderer = null;
  }
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  (AsyncStorage as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

function Probe(): null {
  app = useApp();
  return null;
}

async function observerFetch(o: QueryObserver): Promise<void> {
  await o.refetch();
}

async function settle(qc?: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc && qc.isFetching() === 0 && i > 2) return;
    }
  });
}

async function mountAuthed(): Promise<QueryClient> {
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  route("GET", "/auth/me", () => mockJson({ user: makeUser() }));

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  await act(async () => {
    activeRenderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(AppProvider, null, React.createElement(Probe)),
        ),
      ),
    );
  });
  await settle(qc);
  return qc;
}

/**
 * Register a LIVE query at the real plan-detail key with a counting queryFn,
 * so "did the invalidation match anything" is answered by an actual refetch
 * rather than by inspecting the key we passed in (which would be a tautology —
 * asserting the constant against itself).
 */
function seedPlanDetailQuery(qc: QueryClient, planId: string) {
  let fetches = 0;
  // A real SUBSCRIBED observer, not a bare cache entry: invalidateQueries
  // defaults to refetchType "active", so an observerless query would only be
  // marked stale and never refetch — the test would then pass or fail for a
  // reason unrelated to the key.
  const observer = new QueryObserver(qc, {
    queryKey: ["plans", "detail", planId],
    queryFn: async () => {
      fetches += 1;
      return { id: planId };
    },
    staleTime: Infinity,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { count: () => fetches, observer, unsubscribe };
}

// ── BUG-110 ───────────────────────────────────────────────────────────────

test("BUG-110: after the AI macro recalc resolves, the plan-detail query REFETCHES", async () => {
  const qc = await mountAuthed();
  const detail = seedPlanDetailQuery(qc, "plan-1");
  await act(async () => {
    await observerFetch(detail.observer);
  });
  assert.equal(detail.count(), 1, "precondition: the detail query has fetched once");

  // Hold the recalc POST open so its invalidation is separable in time from
  // the mutation's own ["plans"] invalidation.
  let releaseRecalc!: (r: Response) => void;
  const recalcHeld = new Promise<Response>((r) => {
    releaseRecalc = r;
  });
  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson(itemMutationResponse(true)),
  );
  routeTable.set("POST /plans/plan-1/recalc-macros", (() =>
    recalcHeld) as unknown as () => Response);

  await act(async () => {
    await app!.assignDayToPlanItem("plan-1", "item-1", "Tuesday");
  });
  await settle(qc);

  const afterMutation = detail.count();
  assert.ok(
    afterMutation >= 2,
    `the mutation's own ["plans"] invalidation should already have refetched the detail query, got ${afterMutation}`,
  );

  // Now let the recalc land. Its invalidation is the ONE under test.
  await act(async () => {
    releaseRecalc(mockJson(RECALC_BODY));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  await settle(qc);

  assert.ok(
    detail.count() > afterMutation,
    `the recalc's invalidation must refetch the plan-detail query (was ${afterMutation}, now ${detail.count()}). A key matching nothing fails exactly like a slow network — this is the difference.`,
  );
});

// ── BUG-104 ───────────────────────────────────────────────────────────────

test("BUG-104: handleMutationResult DEFERS its invalidations while a plan write is in flight", async () => {
  const qc = await mountAuthed();
  const detail = seedPlanDetailQuery(qc, "plan-1");
  await act(async () => {
    await observerFetch(detail.observer);
  });
  const before = detail.count();

  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson(itemMutationResponse(false)),
  );

  // Simulate the runner holding the depth open across the mutation — exactly
  // what runPlanWrite does around its `write()`.
  app!.beginPlanWrite();
  await act(async () => {
    await app!.assignDayToPlanItem("plan-1", "item-1", "Tuesday");
  });
  await settle(qc);

  assert.equal(
    detail.count(),
    before,
    "an invalidation fired while a sibling write is still in flight starts the refetch that reverts that sibling's optimism",
  );

  // Draining the depth and flushing is the runner's `finally`.
  const depth = app!.endPlanWrite();
  assert.equal(depth, 0);
  await act(async () => {
    app!.invalidatePlanCaches();
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  await settle(qc);

  assert.ok(
    detail.count() > before,
    "once the burst drains, the deferred invalidation must actually run",
  );
});

test("BUG-104: with NO write in flight, handleMutationResult invalidates immediately (unchanged for non-runner callers)", async () => {
  const qc = await mountAuthed();
  const detail = seedPlanDetailQuery(qc, "plan-1");
  await act(async () => {
    await observerFetch(detail.observer);
  });
  const before = detail.count();

  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson(itemMutationResponse(false)),
  );
  await act(async () => {
    await app!.assignDayToPlanItem("plan-1", "item-1", "Tuesday");
  });
  await settle(qc);

  assert.ok(
    detail.count() > before,
    "callers that do not route through the runner must keep the old immediate-invalidate behaviour",
  );
});

test("BUG-104: begin/endPlanWrite nest, and the depth never goes negative", async () => {
  await mountAuthed();
  assert.equal(app!.beginPlanWrite(), 1);
  assert.equal(app!.beginPlanWrite(), 2);
  assert.equal(app!.endPlanWrite(), 1);
  assert.equal(app!.endPlanWrite(), 0);
  assert.equal(
    app!.endPlanWrite(),
    0,
    "an unbalanced end must clamp at 0 — a negative depth would permanently suppress every invalidation",
  );
});
