// WS7-2 Block B Commit 3 — AppContext profile/account mutator wire-ups.
//
// Covers updateUserName / updateUserPhone / updateUserPreferences /
// deactivateAccount now that they call the real /me/* endpoints. Mounts the
// full QueryClient → AuthProvider → AppProvider tree and drives the mutators
// through a mocked `fetch` (same harness style as AuthContext.test.ts —
// mocking fetch rather than the lib/api/me module avoids ESM module-mock
// machinery and exercises the apiClient + Zod path end to end).
//
// Why .ts + React.createElement: the node:test runner strips TS types but
// can't transform JSX. AppContext was converted to React.createElement and
// renamed .tsx → .ts in this commit (Phase 2 clarifier Item 10) for exactly
// this reason — mirrors AuthContext.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { AppProvider, useApp } from "../AppContext";
import { AuthProvider, useAuth } from "../AuthContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type AppValue = ReturnType<typeof useApp>;
type AuthValue = ReturnType<typeof useAuth>;

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "hans@example.com",
    firstName: "Hans",
    lastName: "Old",
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
    ...overrides,
  };
}

// PATCH /me/profile's response omits `subscription` (matches routes/me.ts).
function makeProfileUser(overrides: Record<string, unknown> = {}) {
  const { subscription: _drop, ...rest } = makeUser(overrides);
  return rest;
}

const VALID_PREFS = {
  spiceTolerance: "mild",
  budgetLevel: "economy",
  cookingSkill: "intermediate",
  stovetopType: "gas",
  defaultRetailer: "Instacart",
  cuisines: ["Italian"],
  allergiesAndAvoidances: [],
  // WS9 D-WS9-206 — the new otherAllergies column. It is NOT nullable and has
  // a [] server default, so it is always on the wire; a fixture without it is
  // not a payload the server can produce.
  otherAllergies: [],
  cookingEquipment: ["Oven"],
  recurringGroceryItems: ["Milk"],
  eatingStyles: ["Healthy"],
  healthGoals: [],
  pickyAvoidances: ["Mushrooms"],
  householdSize: 3,
  kidsCount: 2,
  pickyEaterCount: 1,
  planLengthDefault: 7,
  wantsLeftovers: true,
  dietaryNotes: null,
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

// ── Harness ───────────────────────────────────────────────────────────────

// Route table: "METHOD /path-suffix" → response factory. Unmatched routes
// fall through to a generic 200 {} so stray calls don't reject the test.
let routeTable: Map<string, () => Response>;
let app: AppValue | null;
let auth: AuthValue | null;
let activeRenderer: TestRenderer.ReactTestRenderer | null;

function route(method: string, suffix: string, make: () => Response): void {
  routeTable.set(`${method} ${suffix}`, make);
}

beforeEach(() => {
  routeTable = new Map();
  app = null;
  auth = null;
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
  auth = useAuth();
  return null;
}

async function settle(qc?: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc && qc.isFetching() === 0) return;
    }
  });
}

// Mounts an authenticated tree: seeds a token, serves GET /auth/me, and
// waits for the meQuery + AppProvider bootstrap to settle.
async function mountAuthed(): Promise<QueryClient> {
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "test-token",
  );
  route("GET", "/auth/me", () => mockJson({ user: makeUser() }));

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe),
          ),
        ),
      ),
    );
  });
  activeRenderer = renderer;
  await settle(qc);
  return qc;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("updateUserName splits the name, PATCHes profile, field-merges cache", async () => {
  const qc = await mountAuthed();
  assert.equal(auth!.isAuthenticated, true);

  route("PATCH", "/me/profile", () =>
    mockJson({ user: makeProfileUser({ firstName: "New", lastName: "Name" }) }),
  );

  await act(async () => {
    await app!.updateUserName("New Name");
  });

  const cached = qc.getQueryData(["auth", "me"]) as Record<string, unknown>;
  assert.equal(cached.firstName, "New");
  assert.equal(cached.lastName, "Name");
  // Field-merge preserves `subscription` (the profile response omits it).
  assert.notEqual(cached.subscription, undefined);
});

test("updateUserPhone PATCHes profile and merges the new phone into cache", async () => {
  const qc = await mountAuthed();

  route("PATCH", "/me/profile", () =>
    mockJson({ user: makeProfileUser({ phone: "555-1234567" }) }),
  );

  await act(async () => {
    await app!.updateUserPhone("555-1234567");
  });

  const cached = qc.getQueryData(["auth", "me"]) as Record<string, unknown>;
  assert.equal(cached.phone, "555-1234567");
  assert.notEqual(cached.subscription, undefined);
});

test("updateUserPreferences PATCHes /me/preferences and resolves", async () => {
  await mountAuthed();

  let patched = false;
  route("PATCH", "/me/preferences", () => {
    patched = true;
    return mockJson({ preferences: VALID_PREFS });
  });

  await act(async () => {
    await app!.updateUserPreferences({
      spiceTolerance: "hot",
    } as unknown as Parameters<AppValue["updateUserPreferences"]>[0]);
  });

  assert.equal(patched, true, "PATCH /me/preferences was called");
});

test("updateUserPreferences invalidates me/preferences + plans + home (dietary banner refresh — 792d450)", async () => {
  // WS9 3d Part 3c-2 (B4) — the 792d450 invalidation shipped untested. A
  // dietary/allergy edit re-stamps dietaryUpdatedAt server-side, flipping the
  // plan payload's dietaryStale boolean that drives the Plan Review staleness
  // banner. The plan-detail cache isn't touched by a prefs save, so without
  // these invalidations the banner never surfaces until staleTime lapses.
  const qc = await mountAuthed();
  qc.setQueryData(["me", "preferences"], VALID_PREFS);
  qc.setQueryData(["plans"], { plans: [], activeThisWeek: null, nextCursor: null });
  qc.setQueryData(["home"], {});

  route("PATCH", "/me/preferences", () => mockJson({ preferences: VALID_PREFS }));

  await act(async () => {
    await app!.updateUserPreferences({
      allergiesAndAvoidances: ["peanuts"],
    } as unknown as Parameters<AppValue["updateUserPreferences"]>[0]);
  });

  assert.equal(
    qc.getQueryState(["me", "preferences"])?.isInvalidated,
    true,
    "preferences cache invalidated so the next read refetches the merged row",
  );
  assert.equal(
    qc.getQueryState(["plans"])?.isInvalidated,
    true,
    "plans cache invalidated so the dietary-staleness banner surfaces on return",
  );
  assert.equal(qc.getQueryState(["home"])?.isInvalidated, true);
});

test("updateUserPreferences sends the partial body verbatim — no stub defaults (WS7-2-E Bug 3 / WS7-2-F)", async () => {
  // Bug 3 data-integrity half: onboarding-step-3's buildFullPrefs() now emits
  // a TRUE PARTIAL (step-2 draft ∪ step-3 form) instead of seeding from the
  // getCurrentUserPreferences() stub. This test verifies at the mutator
  // boundary — buildFullPrefs is a closure inside the screen, so the PATCH
  // request body is the testable surface — that the body is forwarded
  // verbatim with no stub re-injection. WS7-2-F (D-WS7-029) added
  // householdSize / wantsLeftovers / planLengthDefault to step 2, so they
  // now appear in the partial; only defaultRetailer stays absent — it is set
  // on the first grocery order, not during onboarding.
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      u.endsWith("/me/preferences")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson({ preferences: VALID_PREFS }));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  // Representative true-partial body — the shape buildFullPrefs() produces:
  // step-2 draft fields (incl. household / leftovers / plan-length per
  // WS7-2-F) ∪ step-3 form fields, no defaultRetailer, no expandedSections
  // UI state.
  const partial = {
    cuisines: ["Italian"],
    eatingStyles: ["Healthy"],
    allergiesAndAvoidances: [],
    cookingSkill: "intermediate",
    recurringGroceryItems: ["Milk"],
    householdSize: 4,
    wantsLeftovers: false,
    planLengthDefault: 5,
    cookingEquipment: ["Oven"],
    stovetopType: "gas",
    kidsCount: 2,
    pickyEaterCount: 1,
    pickyAvoidances: ["Mushrooms"],
    spiceTolerance: "hot",
    healthGoals: [],
    budgetLevel: "economy",
  };

  await act(async () => {
    await app!.updateUserPreferences({
      ...partial,
    } as unknown as Parameters<AppValue["updateUserPreferences"]>[0]);
  });

  assert.ok(capturedBody, "PATCH /me/preferences received a body");
  // Verbatim forward — the mutator + apiClient inject nothing.
  assert.deepEqual(capturedBody, partial);
  // The one §14.9.2 field current onboarding UI never collects must be
  // absent — defaultRetailer is set on the first grocery order, not during
  // onboarding.
  for (const banned of ["defaultRetailer"]) {
    assert.equal(
      banned in (capturedBody as object),
      false,
      `${banned} must not appear in the PATCH body`,
    );
  }
  // expandedSections is step-3 UI state, never a preference field.
  assert.equal(
    "expandedSections" in (capturedBody as object),
    false,
    "expandedSections must not appear in the PATCH body",
  );
});

test("updateUserName rejects on a server error and leaves the cache intact", async () => {
  const qc = await mountAuthed();

  route("PATCH", "/me/profile", () =>
    mockJson({ error: "boom", userFacingMessage: "Something broke" }, 500),
  );

  await act(async () => {
    await assert.rejects(() => app!.updateUserName("New Name"));
  });

  // Cache untouched — still the original user.
  const cached = qc.getQueryData(["auth", "me"]) as Record<string, unknown>;
  assert.equal(cached.firstName, "Hans");
});

test("requestEmailChange POSTs /me/email/request-change and resolves", async () => {
  await mountAuthed();

  let requested = false;
  route("POST", "/me/email/request-change", () => {
    requested = true;
    return mockJson({ success: true });
  });

  await act(async () => {
    await app!.requestEmailChange("new@example.com");
  });

  assert.equal(requested, true, "POST /me/email/request-change was called");
});

test("requestEmailChange rejects when the server returns 400", async () => {
  await mountAuthed();

  route("POST", "/me/email/request-change", () =>
    mockJson({ error: "invalid request body" }, 400),
  );

  await act(async () => {
    await assert.rejects(() => app!.requestEmailChange("not-an-email"));
  });
});

test("changePassword PATCHes /me/password and resolves", async () => {
  await mountAuthed();

  let patched = false;
  route("PATCH", "/me/password", () => {
    patched = true;
    return mockJson({ success: true });
  });

  await act(async () => {
    await app!.changePassword("oldpass-12345", "newpass-67890");
  });

  assert.equal(patched, true, "PATCH /me/password was called");
});

test("changePassword rejects when currentPassword is wrong (400)", async () => {
  await mountAuthed();

  // Server returns 400 invalid_current_password on a bcrypt mismatch — the
  // rejection propagates so profile.tsx can surface it inline.
  route("PATCH", "/me/password", () =>
    mockJson(
      {
        error: "invalid_current_password",
        userFacingMessage: "Current password is incorrect",
      },
      400,
    ),
  );

  await act(async () => {
    await assert.rejects(() =>
      app!.changePassword("wrong-guess-1", "newpass-67890"),
    );
  });
});

test("updateMarketingConsent PATCHes /me/profile and merges into the cache", async () => {
  const qc = await mountAuthed();

  route("PATCH", "/me/profile", () =>
    mockJson({ user: makeProfileUser({ marketingConsentEmail: true }) }),
  );

  await act(async () => {
    await app!.updateMarketingConsent({ marketingConsentEmail: true });
  });

  const cached = qc.getQueryData(["auth", "me"]) as Record<string, unknown>;
  assert.equal(cached.marketingConsentEmail, true);
  // Field-merge preserves `subscription` (the profile response omits it).
  assert.notEqual(cached.subscription, undefined);
});

test("updateMarketingConsent rolls the cache back on a server error", async () => {
  const qc = await mountAuthed();

  route("PATCH", "/me/profile", () => mockJson({ error: "boom" }, 500));

  await act(async () => {
    await assert.rejects(() =>
      app!.updateMarketingConsent({ marketingConsentEmail: true }),
    );
  });

  // The optimistic flip was rolled back to the original value.
  const cached = qc.getQueryData(["auth", "me"]) as Record<string, unknown>;
  assert.equal(cached.marketingConsentEmail, false);
});

test("completeOnboarding PATCHes onboardingComplete and merges into the cache", async () => {
  const qc = await mountAuthed();

  let patched = false;
  route("PATCH", "/me/profile", () => {
    patched = true;
    return mockJson({ user: makeProfileUser({ onboardingComplete: true }) });
  });

  await act(async () => {
    await app!.completeOnboarding();
  });

  assert.equal(patched, true, "PATCH /me/profile was called");
  const cached = qc.getQueryData(["auth", "me"]) as Record<string, unknown>;
  assert.equal(cached.onboardingComplete, true);
  // Field-merge preserves `subscription` (the profile response omits it).
  assert.notEqual(cached.subscription, undefined);
});

test("deactivateAccount calls /me/deactivate then logs the session out", async () => {
  const qc = await mountAuthed();
  assert.equal(auth!.isAuthenticated, true);

  let deactivated = false;
  route("POST", "/me/deactivate", () => {
    deactivated = true;
    return mockJson({ success: true });
  });
  route("POST", "/auth/logout", () => new Response("", { status: 200 }));

  await act(async () => {
    await app!.deactivateAccount();
    await settle();
  });

  assert.equal(deactivated, true, "POST /me/deactivate was called");
  // logout() flushed the auth cache + token.
  assert.equal(qc.getQueryData(["auth", "me"]), undefined);
  assert.equal(auth!.token, null);
});

// ── WS7-4-B c8 — useTemplateAsPlan ────────────────────────────────────────

test("useTemplateAsPlan POSTs use-template and returns instanceId", async () => {
  await mountAuthed();

  let postCalls = 0;
  let lastPath: string | null = null;
  route("POST", "/plans/use-template/tmpl-42", () => {
    postCalls += 1;
    lastPath = "/plans/use-template/tmpl-42";
    return mockJson({ instance: { id: "new-instance-99", revisionId: 1 } }, 201);
  });

  let result: { instanceId: string } | null = null;
  await act(async () => {
    result = await app!.useTemplateAsPlan("tmpl-42");
  });

  assert.equal(postCalls, 1);
  assert.equal(lastPath, "/plans/use-template/tmpl-42");
  assert.equal(result!.instanceId, "new-instance-99");
});

test("useTemplateAsPlan invalidates the plans-list cache after success", async () => {
  const qc = await mountAuthed();
  // Seed a fake plans-list cache row; the mutator should mark it stale.
  qc.setQueryData(["plans", "list"], { plans: [], activeThisWeek: null, nextCursor: null });
  const stateBefore = qc.getQueryState(["plans", "list"]);
  assert.ok(stateBefore);

  route("POST", "/plans/use-template/tmpl-x", () =>
    mockJson({ instance: { id: "inst-x", revisionId: 1 } }, 201),
  );

  await act(async () => {
    await app!.useTemplateAsPlan("tmpl-x");
  });

  const stateAfter = qc.getQueryState(["plans", "list"]);
  // invalidateQueries({ queryKey: ["plans"] }) marks anything under that
  // prefix as stale — observable via isInvalidated.
  assert.equal(stateAfter?.isInvalidated, true);
});

test("useTemplateAsPlan propagates a server error", async () => {
  await mountAuthed();

  route("POST", "/plans/use-template/missing", () =>
    mockJson({ error: "template not found" }, 404),
  );

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.useTemplateAsPlan("missing");
    } catch (err) {
      caught = err;
    }
  });

  assert.ok(caught, "expected useTemplateAsPlan to throw on 404");
});

// ── WS7-4-D c6 — assignDayToPlanItem + unassignDayFromPlanItem ─────────────

// Rich Q-P1-5 (a) envelope a server returns for PATCH /items.
function itemMutationResponse(planId: string, itemId: string, mealId = "m-1") {
  return {
    item: {
      id: itemId,
      mealId,
      positionIndex: 0,
      assignedDayOfWeek: null,
      assignedDate: null,
      servingsOverride: null,
      isBreakfast: false,
      isLunch: false,
      isDinner: true,
      notes: null,
      meal: null,
    },
    planId,
    revisionId: 5,
    macrosStale: false,
  };
}

test("assignDayToPlanItem PATCHes /items with { assignedDayOfWeek: day } and invalidates plan caches", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["plans", "plan-1"], { id: "plan-1" });

  let capturedBody: Record<string, unknown> | null = null;
  route("PATCH", "/plans/plan-1/items/item-1", () => {
    return mockJson(itemMutationResponse("plan-1", "item-1"));
  });
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1/items/item-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-1")));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.assignDayToPlanItem("plan-1", "item-1", "Monday");
  });

  assert.deepEqual(capturedBody, { assignedDayOfWeek: "Monday" });
  // Plan cache marked invalidated.
  const after = qc.getQueryState(["plans", "plan-1"]);
  assert.equal(after?.isInvalidated, true);
});

test("unassignDayFromPlanItem PATCHes /items with { assignedDayOfWeek: null }", async () => {
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1/items/item-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-1")));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.unassignDayFromPlanItem("plan-1", "item-1");
  });

  assert.deepEqual(capturedBody, { assignedDayOfWeek: null });
});

test("setPlanActiveThisWeek PATCHes { isActiveThisWeek: true } and invalidates groceries + plans + home (B6 — This Week chip refresh)", async () => {
  const qc = await mountAuthed();
  // Prime all three server-derived caches so we can prove the activation flip
  // invalidates each. The grocery library's per-row isActiveThisWeek is derived
  // server-side from the plan set, so without the ["groceries"] invalidation the
  // "This Week" chip lags until staleTime / a focus-refetch (the device-test
  // observation that motivated the fix).
  qc.setQueryData(["groceries", "list", null], []);
  qc.setQueryData(["plans"], { plans: [], activeThisWeek: null, nextCursor: null });
  qc.setQueryData(["home"], {});

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson({ instance: { id: "plan-1", revisionId: 2 } }));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.setPlanActiveThisWeek("plan-1");
  });

  assert.deepEqual(capturedBody, { isActiveThisWeek: true });
  assert.equal(
    qc.getQueryState(["groceries", "list", null])?.isInvalidated,
    true,
    "grocery library cache invalidated so the This Week chip refreshes immediately",
  );
  assert.equal(qc.getQueryState(["plans"])?.isInvalidated, true);
  assert.equal(qc.getQueryState(["home"])?.isInvalidated, true);
});

test("assignDayToPlanItem propagates a server error (Q-P0-8: no swallow)", async () => {
  await mountAuthed();

  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson({ error: "item not found" }, 404),
  );

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.assignDayToPlanItem("plan-1", "item-1", "Tuesday");
    } catch (err) {
      caught = err;
    }
  });

  assert.ok(caught, "expected assignDayToPlanItem to throw on 404");
});

// ── WS7-4-D c7 — addMealToPlan + removeMealFromPlan ───────────────────────

test("addMealToPlan POSTs to /items with { mealId, slot: dinner, assignedDayOfWeek: day }", async () => {
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      String(url).endsWith("/plans/plan-1/items")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-new", "m-1"), 201));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.addMealToPlan("plan-1", "m-1", "Friday");
  });

  assert.deepEqual(capturedBody, {
    mealId: "m-1",
    slot: "dinner",
    assignedDayOfWeek: "Friday",
  });
});

test("addMealToPlan without a day sends assignedDayOfWeek: null", async () => {
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      String(url).endsWith("/plans/plan-1/items")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-new"), 201));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.addMealToPlan("plan-1", "m-2");
  });

  assert.equal((capturedBody as { assignedDayOfWeek: string | null }).assignedDayOfWeek, null);
});

test("removeMealFromPlan DELETEs /items/:itemId and invalidates plan caches", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["plans", "plan-1"], { id: "plan-1" });

  let capturedMethod: string | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/plans/plan-1/items/item-1")) {
      capturedMethod = (init?.method ?? "GET").toUpperCase();
      return Promise.resolve(
        mockJson({ planId: "plan-1", revisionId: 6, macrosStale: false }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.removeMealFromPlan("plan-1", "item-1");
  });

  assert.equal(capturedMethod, "DELETE");
  const after = qc.getQueryState(["plans", "plan-1"]);
  assert.equal(after?.isInvalidated, true);
});

// ── WS9 3d Part 3a/3c — compostPlan + demotion surfacing ──────────────────

test("compostPlan DELETEs /plans/:id and invalidates the plan caches (D-WS9-001)", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["plans", "plan-1"], { id: "plan-1" });

  let capturedMethod: string | null = null;
  let capturedUrl: string | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      String(url).endsWith("/plans/plan-1") &&
      (init?.method ?? "GET").toUpperCase() === "DELETE"
    ) {
      capturedMethod = "DELETE";
      capturedUrl = String(url);
      return Promise.resolve(
        mockJson({ instance: { id: "plan-1", revisionId: 4 } }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.compostPlan("plan-1");
  });

  assert.equal(capturedMethod, "DELETE");
  assert.ok(capturedUrl?.endsWith("/plans/plan-1"));
  assert.equal(qc.getQueryState(["plans", "plan-1"])?.isInvalidated, true);
});

test("compostPlan invalidates the groceries cache so the composted plan's list drops (A1 case c)", async () => {
  // WS9 3d Part 3c-2 (B3, case c hardening) — the server cascade archives the
  // plan's grocery lists in the same tx, but compostPlan previously omitted the
  // ["groceries"] invalidation, so the composted plan's list lingered in the
  // Groceries cache until staleTime / a focus-refetch. (The server-side index
  // filter — A1 case b — is the primary fix; this keeps the client immediate.)
  const qc = await mountAuthed();
  qc.setQueryData(["groceries", "list", null], []);
  qc.setQueryData(["plans"], { plans: [], activeThisWeek: null, nextCursor: null });
  qc.setQueryData(["home"], {});

  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      String(url).endsWith("/plans/plan-1") &&
      (init?.method ?? "GET").toUpperCase() === "DELETE"
    ) {
      return Promise.resolve(
        mockJson({ instance: { id: "plan-1", revisionId: 4 } }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.compostPlan("plan-1");
  });

  assert.equal(
    qc.getQueryState(["groceries", "list", null])?.isInvalidated,
    true,
    "groceries cache invalidated so the composted plan's list disappears immediately",
  );
  assert.equal(qc.getQueryState(["plans"])?.isInvalidated, true);
  assert.equal(qc.getQueryState(["home"])?.isInvalidated, true);
});

test("copyPlan POSTs /plans/:id/copy and invalidates the plan caches (D-WS9-008)", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["plans", "my_plans"], { plans: [] });

  let capturedMethod: string | null = null;
  let capturedUrl: string | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      String(url).endsWith("/plans/plan-1/copy") &&
      (init?.method ?? "GET").toUpperCase() === "POST"
    ) {
      capturedMethod = "POST";
      capturedUrl = String(url);
      return Promise.resolve(
        mockJson({ instance: { id: "copy-1", revisionId: 1 } }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { instanceId: string } | undefined;
  await act(async () => {
    result = await app!.copyPlan("plan-1");
  });

  assert.equal(capturedMethod, "POST");
  assert.ok(capturedUrl?.endsWith("/plans/plan-1/copy"));
  assert.equal(result?.instanceId, "copy-1");
  assert.equal(qc.getQueryState(["plans", "my_plans"])?.isInvalidated, true);
});

test("setPlanActiveThisWeek surfaces the server-reported demoted plan (D-WS9-011a)", async () => {
  await mountAuthed();
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      String(url).endsWith("/plans/plan-1") &&
      (init?.method ?? "GET").toUpperCase() === "PATCH"
    ) {
      return Promise.resolve(
        mockJson({
          instance: { id: "plan-1", revisionId: 2 },
          macrosStale: false,
          demoted: { id: "plan-y", name: "Old Plan" },
        }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { demoted: { id: string; name: string } | null } | undefined;
  await act(async () => {
    result = await app!.setPlanActiveThisWeek("plan-1");
  });
  assert.deepEqual(result?.demoted, { id: "plan-y", name: "Old Plan" });
});

// ── WS7-4-D c8 — changeMealForPlanItem + Ruling 7 retirement ──────────────

test("changeMealForPlanItem PATCHes /items with { mealId: newMealId } (Q-P0-3 atomic swap on server)", async () => {
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1/items/item-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(
        mockJson(itemMutationResponse("plan-1", "swapped-item-1", "m-new")),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { newPlanItemId: string } | null = null;
  await act(async () => {
    result = await app!.changeMealForPlanItem("plan-1", "item-1", "m-new");
  });

  // Per Q-P1-4 v1 restriction: body MUST be { mealId } alone.
  assert.deepEqual(capturedBody, { mealId: "m-new" });
  // WS9 3d Part 4 follow-up — returns the server's NEW item id (the swap is
  // delete+create) so the screen converges its optimistic row and a fast second
  // swap doesn't send the deleted id (the "item not found" P1).
  assert.equal(
    (result as unknown as { newPlanItemId: string })?.newPlanItemId,
    "swapped-item-1",
    "changeMealForPlanItem returns the freshly-created plan-item id",
  );
});

test("changeMealForPlanItem propagates server error (e.g. 404 when new meal missing)", async () => {
  await mountAuthed();

  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson({ error: "meal not found" }, 404),
  );

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.changeMealForPlanItem("plan-1", "item-1", "missing");
    } catch (err) {
      caught = err;
    }
  });

  assert.ok(caught, "expected changeMealForPlanItem to throw on 404");
});

test("Ruling 7 retirement: AppContext no longer exposes swapMealInCurrentPlan", async () => {
  await mountAuthed();
  // The interface dropped the symbol; runtime should match.
  const v = app as unknown as Record<string, unknown>;
  assert.equal(
    "swapMealInCurrentPlan" in v,
    false,
    "swapMealInCurrentPlan should be removed from the AppContext value",
  );
});

// WS7-4-E c4 — findSimilarMeals retirement (Q1:A). Mirrors the c9 pattern:
// the AppContext stub was an orphan console.log returning [] — zero callers
// of useApp().findSimilarMeals across artifacts/kiwi (pre-deletion grep
// pasted in the c4 commit body). The real Find Similar flow runs through
// useFindSimilarMeals → lib/api/meals → POST /meals/find-similar; the
// server folds the free-tier cuisine-match fallback into that same response
// (the client-side findSimilarMealsByCuisine stub was removed in WS7-7-B).
// Compile-time enforced by interface removal; this test pins runtime shape too.
test("WS7-4-E retirement: AppContext no longer exposes findSimilarMeals", async () => {
  await mountAuthed();
  const v = app as unknown as Record<string, unknown>;
  assert.equal(
    "findSimilarMeals" in v,
    false,
    "findSimilarMeals should be removed from the AppContext value",
  );
});

// ── WS7-4-D c9 — changeRecipeForPlanItem + promoteRecipeOverrideToMeal ───

test("changeRecipeForPlanItem PATCHes /items with { recipeOverrideJson: override }", async () => {
  await mountAuthed();

  const override = {
    titleOverride: "Tweaked",
    dishes: [
      { name: "Main", ingredients: [{ name: "salt", quantity: 1, unit: "tsp" }] },
    ],
    steps: ["Mix all"],
    createdAt: "2026-05-26T00:00:00Z",
  };

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1/items/item-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-1")));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.changeRecipeForPlanItem(
      "plan-1",
      "item-1",
      override as Parameters<AppValue["changeRecipeForPlanItem"]>[2],
    );
  });

  assert.deepEqual(capturedBody, { recipeOverrideJson: override });
});

test("changeRecipeForPlanItem invalidates the meals-detail cache so the meal screen re-reads the override (WS7-7-A B5 Issue B)", async () => {
  const qc = await mountAuthed();

  // Prime the meal-detail cache row the meal/[id] screen reads under
  // ["meals","detail",mealId,planItemId]. handleMutationResult only touches
  // the plans/home caches, so before the fix this row stayed fresh (60s
  // staleTime) and router.back() served the pre-override read. The mutator
  // must prefix-invalidate ["meals","detail"] to force the refetch.
  qc.setQueryData(["meals", "detail", "m-1", "item-1"], {
    id: "m-1",
    title: "Pre-override",
  });
  const before = qc.getQueryState(["meals", "detail", "m-1", "item-1"]);
  assert.ok(before && !before.isInvalidated, "meal-detail primed and fresh");

  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson(itemMutationResponse("plan-1", "item-1", "m-1")),
  );

  await act(async () => {
    await app!.changeRecipeForPlanItem(
      "plan-1",
      "item-1",
      {
        titleOverride: "Post-override",
        dishes: [
          { name: "Main", ingredients: [{ name: "salt", quantity: 1, unit: "tsp" }] },
        ],
        steps: ["Mix all"],
        createdAt: "2026-05-26T00:00:00Z",
      } as Parameters<AppValue["changeRecipeForPlanItem"]>[2],
    );
  });

  // Prefix invalidation marks the deeper ["meals","detail",mealId,planItemId]
  // row stale — that staleness is what overrides the 60s staleTime and forces
  // the ?planItemId read to re-run on the still-mounted meal screen.
  const after = qc.getQueryState(["meals", "detail", "m-1", "item-1"]);
  assert.equal(
    after?.isInvalidated,
    true,
    "meal-detail cache invalidated so the override surfaces on read-back",
  );
});

// ── WS7-7-A B5 — setServingsForPlanItem ──────────────────────────────────

test("setServingsForPlanItem PATCHes /items with { servingsOverride }", async () => {
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1/items/item-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-1")));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.setServingsForPlanItem("plan-1", "item-1", 8);
  });

  assert.deepEqual(capturedBody, { servingsOverride: 8 });
});

test("setServingsForPlanItem sends null to clear the override", async () => {
  await mountAuthed();

  let capturedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/plans/plan-1/items/item-1")
    ) {
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(mockJson(itemMutationResponse("plan-1", "item-1")));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.setServingsForPlanItem("plan-1", "item-1", null);
  });

  assert.deepEqual(capturedBody, { servingsOverride: null });
});

test("setServingsForPlanItem invalidates the meals-detail cache so the meal screen re-reads the new servings (BUG-001)", async () => {
  const qc = await mountAuthed();

  // Prime the meal-detail cache row the meal/[id] screen reads under
  // ["meals","detail",mealId,planItemId]. handleMutationResult only touches
  // the plans/home caches, so before the fix this row stayed fresh (60s
  // staleTime) and a fast back-out + re-entry re-seeded displayServings from
  // the stale effectiveServings. The mutator must prefix-invalidate
  // ["meals","detail"] to force the refetch (mirrors changeRecipeForPlanItem).
  qc.setQueryData(["meals", "detail", "m-1", "item-1"], {
    id: "m-1",
    effectiveServings: 4,
  });
  const before = qc.getQueryState(["meals", "detail", "m-1", "item-1"]);
  assert.ok(before && !before.isInvalidated, "meal-detail primed and fresh");

  route("PATCH", "/plans/plan-1/items/item-1", () =>
    mockJson(itemMutationResponse("plan-1", "item-1", "m-1")),
  );

  await act(async () => {
    await app!.setServingsForPlanItem("plan-1", "item-1", 8);
  });

  // Prefix invalidation marks the deeper ["meals","detail",mealId,planItemId]
  // row stale — that staleness overrides the 60s staleTime and forces the
  // ?planItemId read to re-run on re-entry so the new servings surface.
  const after = qc.getQueryState(["meals", "detail", "m-1", "item-1"]);
  assert.equal(
    after?.isInvalidated,
    true,
    "meal-detail cache invalidated so the new servings surface on read-back",
  );
});

test("promoteRecipeOverrideToMeal POSTs to /promote-override and invalidates caches", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["plans", "plan-1"], { id: "plan-1" });

  let capturedMethod: string | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/plans/plan-1/items/item-1/promote-override")) {
      capturedMethod = (init?.method ?? "GET").toUpperCase();
      return Promise.resolve(
        mockJson({
          ...itemMutationResponse("plan-1", "item-1", "promoted-m"),
          newMealId: "promoted-m",
        }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.promoteRecipeOverrideToMeal("plan-1", "item-1");
  });

  assert.equal(capturedMethod, "POST");
  const after = qc.getQueryState(["plans", "plan-1"]);
  assert.equal(after?.isInvalidated, true);
});

// ── WS7-4-E c2 — hybrid recalc-macros dispatch (Ruling 11) ────────────────
// Each branch is asserted independently from the existing per-mutator
// wire-shape tests above. The dispatcher fires for ANY mutation whose
// response carries macrosStale: true; we use removeMealFromPlan as the
// vehicle because its response is the simplest (no `item` envelope) and
// because compost is the canonical "macrosStale=true" path when a fresh
// uncached dish was last added in the same plan.

test("WS7-4-E: macrosStale=true triggers POST /plans/:id/recalc-macros after the mutation", async () => {
  await mountAuthed();

  const calls: { url: string; method: string }[] = [];
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    if (u.endsWith("/plans/plan-1/items/item-1") && method === "DELETE") {
      calls.push({ url: u, method });
      return Promise.resolve(
        mockJson({ planId: "plan-1", revisionId: 7, macrosStale: true }),
      );
    }
    if (u.endsWith("/plans/plan-1/recalc-macros") && method === "POST") {
      calls.push({ url: u, method });
      return Promise.resolve(
        mockJson({
          dailyAverages: {
            caloriesPerDay: 500,
            proteinGPerDay: 30,
            carbsGPerDay: 40,
            fatGPerDay: 18,
          },
        }),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.removeMealFromPlan("plan-1", "item-1");
  });
  // Let the background recalc fire-and-forget settle.
  await settle();

  const recalcCalls = calls.filter((c) =>
    c.url.endsWith("/plans/plan-1/recalc-macros"),
  );
  assert.equal(recalcCalls.length, 1, "expected exactly one recalc POST");
  assert.equal(recalcCalls[0].method, "POST");
});

test("WS7-4-E: macrosStale=false does NOT trigger recalc-macros", async () => {
  await mountAuthed();

  const calls: { url: string; method: string }[] = [];
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    if (u.endsWith("/plans/plan-1/items/item-1") && method === "PATCH") {
      calls.push({ url: u, method });
      return Promise.resolve(
        mockJson(itemMutationResponse("plan-1", "item-1")), // macrosStale: false
      );
    }
    if (u.endsWith("/plans/plan-1/recalc-macros")) {
      calls.push({ url: u, method });
      return Promise.resolve(mockJson({}, 200));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.assignDayToPlanItem("plan-1", "item-1", "Tuesday");
  });
  await settle();

  const recalcCalls = calls.filter((c) =>
    c.url.endsWith("/plans/plan-1/recalc-macros"),
  );
  assert.equal(recalcCalls.length, 0, "recalc-macros should not be called");
});

test("WS7-4-E: recalc-macros failure does NOT crash the mutator (warn-only)", async () => {
  await mountAuthed();

  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    if (u.endsWith("/plans/plan-1/items") && method === "POST") {
      return Promise.resolve(
        mockJson(
          {
            ...itemMutationResponse("plan-1", "item-new"),
            macrosStale: true,
          },
          201,
        ),
      );
    }
    if (u.endsWith("/plans/plan-1/recalc-macros") && method === "POST") {
      return Promise.resolve(mockJson({ error: "rate_limited" }, 429));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  // Silence the expected console.warn so the test log stays clean. The
  // dispatcher's contract is warn-and-swallow; this test pins that.
  const prevWarn = console.warn;
  console.warn = () => {};

  let mutatorThrew = false;
  await act(async () => {
    try {
      await app!.addMealToPlan("plan-1", "m-2");
    } catch {
      mutatorThrew = true;
    }
  });
  await settle();

  console.warn = prevWarn;
  assert.equal(
    mutatorThrew,
    false,
    "mutator should resolve cleanly even when recalc-macros fails",
  );
});

test("WS7-4-E: isMacrosRecalcInFlight flips true while recalc is in flight and back to false after", async () => {
  await mountAuthed();

  // Defer the recalc response so we can observe the in-flight window.
  let resolveRecalc: ((value: Response) => void) | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    if (u.endsWith("/plans/plan-1/items/item-1") && method === "DELETE") {
      return Promise.resolve(
        mockJson({ planId: "plan-1", revisionId: 8, macrosStale: true }),
      );
    }
    if (u.endsWith("/plans/plan-1/recalc-macros") && method === "POST") {
      return new Promise<Response>((resolve) => {
        resolveRecalc = resolve;
      });
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  assert.equal(app!.isMacrosRecalcInFlight, false, "flag clean at start");

  await act(async () => {
    await app!.removeMealFromPlan("plan-1", "item-1");
  });
  // Mutation resolved; recalc fired and is awaiting resolveRecalc.
  // The state update from setMacrosRecalcInFlightCount needs a microtask
  // tick to propagate to the next Probe render.
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  assert.equal(
    app!.isMacrosRecalcInFlight,
    true,
    "flag should be true while recalc is in flight",
  );

  // Now resolve the recalc and let the dispatcher's finally run.
  await act(async () => {
    resolveRecalc!(
      mockJson({
        dailyAverages: {
          caloriesPerDay: 500,
          proteinGPerDay: 30,
          carbsGPerDay: 40,
          fatGPerDay: 18,
        },
      }),
    );
    await settle();
  });

  assert.equal(
    app!.isMacrosRecalcInFlight,
    false,
    "flag should be false after recalc settles",
  );
});

// ── WS7-5b-mobile Block C — createPlanWithMeal (D-WS7-059) ──────────────

test("createPlanWithMeal POSTs /plans then /plans/:id/items, returns new planId, invalidates plans cache", async () => {
  const qc = await mountAuthed();
  // Seed a list-cache entry so we can assert the post-create invalidation.
  qc.setQueryData(["plans"], { plans: [], activeThisWeek: null, nextCursor: null });

  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? String(init.body) : null;
    if (method === "POST" && u.endsWith("/plans")) {
      calls.push({ url: u, method, body });
      return Promise.resolve(
        mockJson({ instance: { id: "plan-fresh", revisionId: 1 } }, 201),
      );
    }
    if (method === "POST" && u.endsWith("/plans/plan-fresh/items")) {
      calls.push({ url: u, method, body });
      return Promise.resolve(
        mockJson(itemMutationResponse("plan-fresh", "item-seed", "meal-x"), 201),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { planId: string } | null = null;
  await act(async () => {
    result = await app!.createPlanWithMeal("meal-x");
  });

  assert.equal(result?.planId, "plan-fresh");
  assert.equal(calls.length, 2);
  // Step 1: empty-body create — no dates per the locked Block C contract.
  assert.equal(calls[0].body, JSON.stringify({}));
  // Step 2: add-meal with slot=dinner. assignedDayOfWeek is omitted, so the
  // server applies its null default per the PRD §2.4 unassigned-day rule.
  assert.equal(
    calls[1].body,
    JSON.stringify({ mealId: "meal-x", slot: "dinner" }),
  );
  // The plans-list cache was invalidated so the new plan surfaces in My Plans.
  const after = qc.getQueryState(["plans"]);
  assert.equal(after?.isInvalidated, true);
});

test("createPlanWithMeal: if POST /plans/:id/items throws, the create-side cache invalidation still ran (empty plan visible in list)", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["plans"], { plans: [], activeThisWeek: null, nextCursor: null });

  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && u.endsWith("/plans")) {
      return Promise.resolve(
        mockJson({ instance: { id: "plan-half", revisionId: 1 } }, 201),
      );
    }
    if (method === "POST" && u.endsWith("/plans/plan-half/items")) {
      return Promise.resolve(mockJson({ error: "meal not found" }, 404));
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.createPlanWithMeal("ghost-meal");
    } catch (err) {
      caught = err;
    }
  });

  assert.ok(caught, "expected createPlanWithMeal to throw when add-meal fails");
  // The plans-list cache MUST have been invalidated before the throw so the
  // user can find their empty plan in My Plans (Block C ruling: empty-plan-
  // with-error MVP path, no cleanup).
  const after = qc.getQueryState(["plans"]);
  assert.equal(after?.isInvalidated, true);
});

test("promoteRecipeOverrideToMeal propagates 422 unresolved_ingredient with structured body", async () => {
  await mountAuthed();

  route("POST", "/plans/plan-1/items/item-1/promote-override", () =>
    mockJson(
      { error: "unresolved_ingredient", ingredientName: "Unicorn Horn" },
      422,
    ),
  );

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.promoteRecipeOverrideToMeal("plan-1", "item-1");
    } catch (err) {
      caught = err;
    }
  });

  assert.ok(caught, "expected promoteRecipeOverrideToMeal to throw on 422");
  // The ApiError carries the structured body so a future UI consumer can
  // surface "could not find ingredient X" and route the user back to edit.
  const body = (caught as { status?: number; body?: { error?: string; ingredientName?: string } });
  assert.equal(body.status, 422);
  assert.equal(body.body?.error, "unresolved_ingredient");
  assert.equal(body.body?.ingredientName, "Unicorn Horn");
});

// ── WS7-6 Block 1E — saveMeal / saveDish ─────────────────────────────────
// Pins the AppContext-layer wiring: POSTs to the right route, returns the
// server-canonical id, and invalidates the corresponding list cache so the
// catalog tabs refresh after a save. The meal-builder's "save then add to
// plan" chain composes saveMeal + addMealToPlan back-to-back; the third
// test below pins that the chain stays atomic-at-the-mutator-level (the
// saved id survives a downstream plan-add failure so the caller can keep
// the form open per WS7-6 1E spec).

test("saveMeal POSTs to /me/meals and invalidates the meals-list cache", async () => {
  const qc = await mountAuthed();

  let postedBody: Record<string, unknown> | null = null;
  route("POST", "/me/meals", () => {
    return mockJson(
      {
        meal: {
          id: "meal-new-7",
          dishIds: ["dish-new-7"],
          linksCreated: 1,
        },
      },
      201,
    );
  });
  // Stamp the meals-list cache so we can prove invalidation happened.
  qc.setQueryData(["meals", "list", null], {
    meals: [{ id: "old", title: "Old" }],
    nextCursor: null,
  });
  const stateBefore = qc.getQueryState(["meals", "list", null]);
  assert.ok(stateBefore, "cache primed");

  // Capture the POST body separately (route() doesn't expose init).
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      String(url).endsWith("/me/meals")
    ) {
      postedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(
        mockJson(
          {
            meal: {
              id: "meal-new-7",
              dishIds: ["dish-new-7"],
              linksCreated: 1,
            },
          },
          201,
        ),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { id: string; dishIds: string[]; linksCreated: number } | null =
    null;
  await act(async () => {
    result = await app!.saveMeal({
      title: "Lemon Roast",
      servingsDefault: 4,
      difficulty: "fancy",
      sourceType: "manual",
      dishes: [
        {
          kind: "new",
          title: "Chicken",
          role: "main",
          positionIndex: 0,
          ingredients: [
            { name: "Whole chicken", quantity: 1, unit: "whole" },
          ],
          steps: [],
        },
      ],
    });
  });

  assert.ok(postedBody, "POST /me/meals fired with a body");
  assert.equal((postedBody as { title: string }).title, "Lemon Roast");
  assert.equal(result!.id, "meal-new-7");
  // Invalidation: meals-list cache should now be marked stale (or removed).
  const stateAfter = qc.getQueryState(["meals", "list", null]);
  assert.ok(
    !stateAfter || stateAfter.isInvalidated,
    "meals-list cache was invalidated after saveMeal",
  );
});

test("saveDish POSTs to /me/dishes (real call, not stub) and invalidates the dishes-list cache", async () => {
  const qc = await mountAuthed();

  qc.setQueryData(["dishes", "list", null], {
    dishes: [{ id: "old-dish" }],
    nextCursor: null,
  });

  let postedUrl: string | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      String(url).endsWith("/me/dishes")
    ) {
      postedUrl = String(url);
      return Promise.resolve(
        mockJson({ dish: { id: "dish-new-9" } }, 201),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { id: string } | null = null;
  await act(async () => {
    result = await app!.saveDish({
      name: "Pilaf",
      servingsDefault: 4,
      type: "side",
      kiwiAssistIngredients: false,
      kiwiAssistSteps: false,
      ingredients: [{ quantity: 1, unit: "cup", name: "Rice" }],
      steps: [],
      caloriesPerServing: 0,
      proteinGPerServing: 0,
      carbsGPerServing: 0,
      fatGPerServing: 0,
    });
  });

  assert.ok(postedUrl, "POST /me/dishes fired");
  assert.equal(result!.id, "dish-new-9");
  const stateAfter = qc.getQueryState(["dishes", "list", null]);
  assert.ok(
    !stateAfter || stateAfter.isInvalidated,
    "dishes-list cache was invalidated after saveDish",
  );
});

test("saveMeal then addMealToPlan: plan-add failure does NOT undo the saved meal id (WS7-6 1E stay-on-screen contract)", async () => {
  // The meal-builder onSave handler chains saveMeal → addMealToPlan when
  // addToPlanId is present. Per spec, a plan-add failure surfaces "saved
  // but couldn't add to plan" and keeps the form open. This test verifies
  // the mutator-level invariant the screen depends on: the saveMeal id
  // remains valid (no rollback / no cache eviction on the meal) when
  // addMealToPlan throws after a successful save.
  await mountAuthed();

  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    const m = (init?.method ?? "GET").toUpperCase();
    if (m === "POST" && u.endsWith("/me/meals")) {
      return Promise.resolve(
        mockJson(
          {
            meal: {
              id: "meal-saved-but-plan-failed",
              dishIds: ["d"],
              linksCreated: 1,
            },
          },
          201,
        ),
      );
    }
    // The plan-add hits POST /plans/:id/items. Simulate a 500.
    if (m === "POST" && /\/plans\/.+\/items$/.test(u)) {
      return Promise.resolve(
        mockJson({ error: "couldn't add item" }, 500),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let savedId: string | null = null;
  let planAddErr: unknown = null;
  await act(async () => {
    const r = await app!.saveMeal({
      title: "Will save but plan-add fails",
      servingsDefault: 4,
      sourceType: "manual",
      dishes: [
        {
          kind: "new",
          title: "x",
          role: "main",
          positionIndex: 0,
          ingredients: [{ name: "salt", quantity: 1, unit: "tsp" }],
          steps: [],
        },
      ],
    });
    savedId = r.id;
    try {
      await app!.addMealToPlan("plan-target-1", r.id);
    } catch (e) {
      planAddErr = e;
    }
  });

  // The saved meal id is preserved — the screen uses this to render the
  // "saved but couldn't add to plan" banner without losing the user's work.
  assert.equal(savedId, "meal-saved-but-plan-failed");
  assert.ok(planAddErr, "addMealToPlan threw after saveMeal succeeded");
});

// ── WS7-6 1F — updateMeal ────────────────────────────────────────────────
// PATCH /me/meals/:id wire-up: the right HTTP method+URL fire, the body
// forwards verbatim, and BOTH the meals caches AND the plans cache are
// invalidated (a global meal edit affects every plan that uses it).

test("updateMeal PATCHes /me/meals/:id and invalidates meals + plans caches", async () => {
  const qc = await mountAuthed();

  // Prime three caches we expect updateMeal to invalidate.
  qc.setQueryData(["meals", "list", null], {
    meals: [{ id: "meal-edit-1", title: "Old title" }],
    nextCursor: null,
  });
  qc.setQueryData(["meals", "detail", "meal-edit-1"], {
    id: "meal-edit-1",
    title: "Old title",
  });
  qc.setQueryData(["plans", "list", null], {
    plans: [{ id: "plan-1" }],
    nextCursor: null,
  });
  // WS7-7-A B5 follow-on (D-WS7-141) — the meal's wipe-and-recreate touches
  // Dish rows, so the Recipes "My Dishes" + dish-detail caches must invalidate
  // too. Prime both to prove updateMeal now clears them.
  qc.setQueryData(["dishes", "list", null], {
    dishes: [{ id: "dish-old", title: "Old patties" }],
    nextCursor: null,
  });
  qc.setQueryData(["dishes", "detail", "dish-old"], {
    id: "dish-old",
    title: "Old patties",
  });

  let patchedUrl: string | null = null;
  let patchedBody: Record<string, unknown> | null = null;
  let patchedMethod: string | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      u.endsWith("/me/meals/meal-edit-1")
    ) {
      patchedMethod = (init?.method ?? "").toUpperCase();
      patchedUrl = u;
      patchedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(
        mockJson({ meal: { id: "meal-edit-1" } }, 200),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { id: string } | null = null;
  await act(async () => {
    result = await app!.updateMeal("meal-edit-1", {
      title: "Patched title",
      difficulty: "medium",
    });
  });

  assert.equal(patchedMethod, "PATCH", "issued a PATCH");
  assert.ok(patchedUrl?.endsWith("/me/meals/meal-edit-1"));
  assert.ok(patchedBody);
  assert.equal((patchedBody as { title: string }).title, "Patched title");
  assert.equal((patchedBody as { difficulty: string }).difficulty, "medium");
  assert.equal(result!.id, "meal-edit-1");

  // Invalidations: meals list, meals detail, and the plans prefix.
  const mealsList = qc.getQueryState(["meals", "list", null]);
  assert.ok(
    !mealsList || mealsList.isInvalidated,
    "meals-list cache was invalidated",
  );
  const mealDetail = qc.getQueryState(["meals", "detail", "meal-edit-1"]);
  assert.ok(
    !mealDetail || mealDetail.isInvalidated,
    "meal-detail cache was invalidated",
  );
  const plansList = qc.getQueryState(["plans", "list", null]);
  assert.ok(
    !plansList || plansList.isInvalidated,
    "plans cache was invalidated (a global meal edit affects every plan that uses it)",
  );
  // WS7-7-A B5 follow-on (D-WS7-141) — dishes caches must invalidate because
  // the meal's wipe-and-recreate deletes + re-mints Dish rows. The detail key
  // is invalidated via the bare ["dishes","detail"] prefix (dish ids churn on
  // recreate, so the client can't target a specific id).
  const dishesList = qc.getQueryState(["dishes", "list", null]);
  assert.ok(
    !dishesList || dishesList.isInvalidated,
    "dishes-list cache was invalidated (Recipes My Dishes must reflect the meal's dish edits)",
  );
  const dishDetail = qc.getQueryState(["dishes", "detail", "dish-old"]);
  assert.ok(
    !dishDetail || dishDetail.isInvalidated,
    "dish-detail cache was invalidated via the bare prefix",
  );
});

test("updateMeal forwards a dishes[] patch (wipe-and-recreate trigger) to the server verbatim", async () => {
  await mountAuthed();

  let patchedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/me/meals/meal-with-dishes")
    ) {
      patchedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(
        mockJson(
          {
            meal: {
              id: "meal-with-dishes",
              dishIds: ["dish-new-A"],
              linksCreated: 1,
            },
          },
          200,
        ),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    await app!.updateMeal("meal-with-dishes", {
      title: "Renamed",
      dishes: [
        {
          kind: "new",
          title: "Replacement",
          role: "main",
          positionIndex: 0,
          ingredients: [{ name: "Garlic", quantity: 2, unit: "clove" }],
          steps: [{ text: "Mince." }],
        },
      ],
    });
  });

  assert.ok(patchedBody);
  assert.ok(
    Array.isArray((patchedBody as { dishes?: unknown[] }).dishes),
    "dishes[] is forwarded to trigger wipe-and-recreate",
  );
  assert.equal(
    ((patchedBody as { dishes: Array<{ kind: string }> }).dishes[0]).kind,
    "new",
  );
});

test("updateDish PATCHes /me/dishes/:id and invalidates dishes + plans caches", async () => {
  const qc = await mountAuthed();

  // Prime three caches we expect updateDish to invalidate.
  qc.setQueryData(["dishes", "list", null], {
    dishes: [{ id: "dish-edit-1", title: "Old title" }],
    nextCursor: null,
  });
  qc.setQueryData(["dishes", "detail", "dish-edit-1"], {
    id: "dish-edit-1",
    title: "Old title",
  });
  qc.setQueryData(["plans", "list", null], {
    plans: [{ id: "plan-1" }],
    nextCursor: null,
  });

  let patchedMethod: string | null = null;
  let patchedUrl: string | null = null;
  let patchedBody: Record<string, unknown> | null = null;
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      u.endsWith("/me/dishes/dish-edit-1")
    ) {
      patchedMethod = (init?.method ?? "").toUpperCase();
      patchedUrl = u;
      patchedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      return Promise.resolve(
        mockJson({ dish: { id: "dish-edit-1" } }, 200),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let result: { id: string } | null = null;
  await act(async () => {
    result = await app!.updateDish("dish-edit-1", {
      title: "Patched dish title",
      difficulty: "medium",
    });
  });

  assert.equal(patchedMethod, "PATCH", "issued a PATCH");
  assert.ok(patchedUrl?.endsWith("/me/dishes/dish-edit-1"));
  assert.ok(patchedBody);
  assert.equal((patchedBody as { title: string }).title, "Patched dish title");
  assert.equal(result!.id, "dish-edit-1");

  // Invalidations: dishes list, dishes detail, AND plans prefix (a global
  // dish edit can affect any plan that links it via a meal's sub-graph).
  const dishesList = qc.getQueryState(["dishes", "list", null]);
  assert.ok(
    !dishesList || dishesList.isInvalidated,
    "dishes-list cache was invalidated",
  );
  const dishDetail = qc.getQueryState(["dishes", "detail", "dish-edit-1"]);
  assert.ok(
    !dishDetail || dishDetail.isInvalidated,
    "dish-detail cache was invalidated",
  );
  const plansList = qc.getQueryState(["plans", "list", null]);
  assert.ok(
    !plansList || plansList.isInvalidated,
    "plans cache was invalidated (global dish edit can affect meals-in-plans)",
  );
});

test("updateMeal propagates a 403 (foreign-owned meal) without touching caches", async () => {
  const qc = await mountAuthed();

  // Prime a cache and assert it stays UN-invalidated on failure.
  qc.setQueryData(["meals", "list", null], {
    meals: [{ id: "x" }],
    nextCursor: null,
  });

  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    if (
      (init?.method ?? "GET").toUpperCase() === "PATCH" &&
      String(url).endsWith("/me/meals/meal-foreign")
    ) {
      return Promise.resolve(
        mockJson({ error: "meal not owned by user" }, 403),
      );
    }
    return prevFetch(url, init);
  }) as unknown as typeof fetch;

  let err: unknown = null;
  await act(async () => {
    try {
      await app!.updateMeal("meal-foreign", { title: "x" });
    } catch (e) {
      err = e;
    }
  });
  assert.ok(err, "updateMeal rejected on 403");

  const mealsList = qc.getQueryState(["meals", "list", null]);
  assert.ok(
    mealsList && !mealsList.isInvalidated,
    "meals-list cache stayed valid because the PATCH failed",
  );
});
