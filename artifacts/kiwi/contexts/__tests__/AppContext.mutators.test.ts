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
