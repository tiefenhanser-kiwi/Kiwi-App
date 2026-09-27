// Row 9 (1.1) · OAuth Block 2 Part E — completeAuth's THIRD AND FOURTH
// CALLERS, end to end through the real request builders, apiClient and
// lib/authCompletion, with only fetch and SecureStore stubbed.
//
// §2.5 — "After success, the routing is IDENTICAL to a password
// sign-in/sign-up … the Test Kitchen guest claim rides the same way
// (readGuestSessionId(), platform, localDate, the 409 resend, the
// claimRetryable keep)". Each clause is a test below, and each one is checked
// on the WIRE rather than on an intermediate object: the body the server
// receives is the only thing that can be wrong in a way a user notices.
//
// §2.6's 503 is here too, because the hide is the one part of the error
// handling that AuthContext owns (the copy belongs to SocialSignInBlock — a
// dismissed sheet never produces a request at all, so a message set here could
// not cover it).
//
// Harness mirrors AuthContext.bootstrap.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { AuthProvider, useAuth } from "../AuthContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";
import { clearGuestSession, storeGuestSession } from "@/lib/guest/guestToken";
import {
  hiddenProviders,
  resetHiddenProviders,
} from "@/lib/oauth/unavailable";
import type { User } from "@/lib/types";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type AuthValue = ReturnType<typeof useAuth>;
type Stub = {
  __resetForTests(): void;
  __setForTests(k: string, v: string): void;
  __setThrowOn(method: string | null): void;
  getItemAsync(k: string): Promise<string | null>;
};
const store = SecureStore as unknown as Stub;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    phone: null,
    zipCode: null,
    timezone: "UTC",
    accountStatus: "active",
    subscriptionStatus: "free",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    marketingConsentEmail: false,
    marketingConsentSms: false,
    onboardingComplete: false,
    firstRunChoiceMade: false,
    subscription: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as User;
}

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

let calls: Call[];
let respond: (call: Call, index: number) => Response;
let captured: AuthValue | null;
let activeRenderer: TestRenderer.ReactTestRenderer | null;

beforeEach(() => {
  captured = null;
  calls = [];
  activeRenderer = null;
  respond = () => mockJson({}, 200);
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length - 1));
  }) as unknown as typeof fetch;
  store.__resetForTests();
  resetAuthBridge();
  clearGuestSession();
  resetHiddenProviders();
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
  store.__resetForTests();
  resetAuthBridge();
  clearGuestSession();
  resetHiddenProviders();
});

function Probe(): null {
  captured = useAuth();
  return null;
}

async function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(AuthProvider, null, React.createElement(Probe)),
      ),
    );
  });
  activeRenderer = renderer;
  return qc;
}

const APPLE = {
  provider: "apple" as const,
  credential: { identityToken: "apple.id.token", rawNonce: "r".repeat(64), authorizationCode: "c0de" },
};
const GOOGLE = { provider: "google" as const, credential: { idToken: "google.id.token" } };

function signedIn(over: Record<string, unknown> = {}) {
  return {
    user: makeUser(),
    authToken: "at-1",
    onboardingRequired: true,
    isNewUser: false,
    ...over,
  };
}

const oauthCalls = () => calls.filter((c) => c.url.includes("/auth/oauth/"));

// ── the two routes, and the bodies they receive ───────────────────────────

test("Apple: POSTs /auth/oauth/apple with the identity token, the RAW nonce and the code", async () => {
  await mount();
  respond = () => mockJson(signedIn({ isNewUser: true }), 201);

  let res!: Awaited<ReturnType<AuthValue["oauthSignIn"]>>;
  await act(async () => {
    res = await captured!.oauthSignIn({ ...APPLE, mode: "signin" });
  });

  const call = oauthCalls()[0]!;
  assert.match(call.url, /\/auth\/oauth\/apple$/);
  assert.equal(call.body.identityToken, "apple.id.token");
  assert.equal(call.body.rawNonce, "r".repeat(64));
  assert.equal(call.body.authorizationCode, "c0de");
  // §2.8's one extra field, and a REPORT of what the server decided.
  assert.equal(res.isNewUser, true);
});

test("Google: POSTs /auth/oauth/google with the id token and no nonce", async () => {
  await mount();
  respond = () => mockJson(signedIn(), 200);
  await act(async () => {
    await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
  });
  const call = oauthCalls()[0]!;
  assert.match(call.url, /\/auth\/oauth\/google$/);
  assert.equal(call.body.idToken, "google.id.token");
  assert.equal("rawNonce" in call.body, false);
});

test("platform and timezone ride every social request", async () => {
  await mount();
  respond = () => mockJson(signedIn(), 200);
  await act(async () => {
    await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
  });
  const body = oauthCalls()[0]!.body;
  // Platform.OS under the react-native stub. The point is that it is SENT,
  // and that it is one of the three the server's enum admits.
  assert.ok(["web", "ios", "android"].includes(body.platform as string), String(body.platform));
  assert.equal(typeof body.timezone, "string");
});

// ── §2.4 on the wire ─────────────────────────────────────────────────────

test("🔴 a SIGN-IN request carries no phone and no consents", async () => {
  await mount();
  respond = () => mockJson(signedIn(), 200);
  await act(async () => {
    await captured!.oauthSignIn({
      ...GOOGLE,
      mode: "signin",
      // A caller passing the sign-up screen's state into a sign-in must not
      // leak it. The server applies consents on CREATE, and a first sign-in
      // IS a create.
      consents: { phone: "555 0100", marketingConsentEmail: true, marketingConsentSms: true },
    });
  });
  const body = oauthCalls()[0]!.body;
  assert.equal("phone" in body, false);
  assert.equal("marketingConsentEmail" in body, false);
  assert.equal("marketingConsentSms" in body, false);
});

test("a SIGN-UP request carries the phone and both consents", async () => {
  await mount();
  respond = () => mockJson(signedIn({ isNewUser: true }), 201);
  await act(async () => {
    await captured!.oauthSignIn({
      ...APPLE,
      mode: "signup",
      firstName: "Ada",
      lastName: "Lovelace",
      consents: { phone: "555 0100", marketingConsentEmail: true, marketingConsentSms: false },
    });
  });
  const body = oauthCalls()[0]!.body;
  assert.equal(body.phone, "555 0100");
  assert.equal(body.marketingConsentEmail, true);
  assert.equal(body.marketingConsentSms, false);
  assert.equal(body.firstName, "Ada");
  assert.equal(body.lastName, "Lovelace");
});

test("Apple's name rides a SIGN-IN too — it is offered once, on whichever screen", async () => {
  await mount();
  respond = () => mockJson(signedIn({ isNewUser: true }), 201);
  await act(async () => {
    await captured!.oauthSignIn({
      ...APPLE,
      mode: "signin",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });
  const body = oauthCalls()[0]!.body;
  assert.equal(body.firstName, "Ada");
  assert.equal(body.lastName, "Lovelace");
});

// ── §2.5: the session, and the claim ─────────────────────────────────────

test("a 2xx stores the token, seeds the user, and authenticates", async () => {
  await mount();
  respond = () => mockJson(signedIn({ authToken: "at-social" }), 200);
  await act(async () => {
    await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
  });
  assert.equal(captured!.token, "at-social");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "at-social");
  assert.equal(captured!.user?.email, "ada@example.com");
  assert.equal(captured!.isAuthenticated, true);
  assert.equal(oauthCalls().length, 1, "no /auth/me round trip — the response carried the user");
});

test("the guest claim rides with the LOCAL date, and is cleared on success", async () => {
  await mount();
  storeGuestSession({
    guestSessionId: "gs_1",
    token: "gt_1",
    expiresAt: "2026-12-31T00:00:00Z",
  });
  respond = () => mockJson(signedIn({ claimedPlanId: "p1", claimRetryable: false }), 200);
  await act(async () => {
    await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
  });
  const body = oauthCalls()[0]!.body;
  assert.equal(body.guestSessionId, "gs_1");
  assert.match(String(body.localDate), /^\d{4}-\d{2}-\d{2}$/);
  const { readGuestSessionId } = await import("@/lib/guest/guestToken");
  assert.equal(readGuestSessionId(), null, "spent");
});

test("🔴 claimRetryable KEEPS the guest session for the next sign-in", async () => {
  await mount();
  storeGuestSession({
    guestSessionId: "gs_1",
    token: "gt_1",
    expiresAt: "2026-12-31T00:00:00Z",
  });
  respond = () => mockJson(signedIn({ claimedPlanId: null, claimRetryable: true }), 200);
  await act(async () => {
    await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
  });
  const { readGuestSessionId } = await import("@/lib/guest/guestToken");
  assert.equal(readGuestSessionId(), "gs_1");
});

test("🔴 409 guest_session_invalid resends WITHOUT the claim, once", async () => {
  await mount();
  storeGuestSession({
    guestSessionId: "gs_1",
    token: "gt_1",
    expiresAt: "2026-12-31T00:00:00Z",
  });
  respond = (_call, i) =>
    i === 0
      ? mockJson({ code: "guest_session_invalid" }, 409)
      : mockJson(signedIn({ isNewUser: true, claimedPlanId: "p9", claimRetryable: true }), 201);

  let res!: Awaited<ReturnType<AuthValue["oauthSignIn"]>>;
  await act(async () => {
    res = await captured!.oauthSignIn({ ...APPLE, mode: "signin" });
  });

  const sent = oauthCalls();
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.body.guestSessionId, "gs_1");
  assert.equal("guestSessionId" in sent[1]!.body, false);
  // Whatever the second response echoed, the plan did not come over.
  assert.equal(res.claimedPlanId, null);
  assert.equal(res.claimRetryable, false);
  assert.equal(res.isNewUser, true, "…and it WAS a sign-up");
  assert.equal(captured!.token, "at-1");
});

// ── §2.6: what a refusal does ────────────────────────────────────────────

test("🔴 a 401 rejects, stores nothing, and does NOT fire the session cascade", async () => {
  // The cascade would clear a token the caller does not have and overwrite the
  // screen's line with "Your session expired" — apiClient gates it on
  // `wantsAuth`, and these two calls send `auth: false`.
  await mount();
  respond = () => mockJson({ error: "invalid credentials" }, 401);
  await assert.rejects(
    async () => {
      await act(async () => {
        await captured!.oauthSignIn({ ...APPLE, mode: "signin" });
      });
    },
    /Unauthenticated|invalid credentials/,
  );
  assert.equal(captured!.token, null);
  assert.equal(await store.getItemAsync(TOKEN_KEY), null);
  assert.equal(captured!.error, null, "no 'session expired' — there was no session");
});

test("🔴 a 503 oauth_unavailable HIDES that provider for the session", async () => {
  await mount();
  respond = () => mockJson({ code: "oauth_unavailable" }, 503);
  assert.deepEqual(hiddenProviders(), []);
  await assert.rejects(
    async () => {
      await act(async () => {
        await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
      });
    },
  );
  assert.deepEqual(hiddenProviders(), ["google"]);
});

test("🔴 a 503 WITHOUT the code hides nothing", async () => {
  // A cold start or a proxy answering 503 is not a statement about the
  // provider, and hiding a working button over one needs a relaunch to undo.
  await mount();
  respond = () => mockJson({ error: "upstream unavailable" }, 503);
  await assert.rejects(
    async () => {
      await act(async () => {
        await captured!.oauthSignIn({ ...APPLE, mode: "signin" });
      });
    },
  );
  assert.deepEqual(hiddenProviders(), []);
});

test("AuthContext sets NO message for a social failure — the block owns the copy", async () => {
  // A dismissed Apple sheet never produces a request, so a message set here
  // could not cover the most common failure. One owner, under the buttons.
  await mount();
  respond = () => mockJson({ error: "invalid credentials" }, 401);
  await assert.rejects(
    async () => {
      await act(async () => {
        await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
      });
    },
  );
  assert.equal(captured!.error, null);
});

test("a stale password error is cleared when a social attempt starts", async () => {
  await mount();
  respond = () => mockJson({ error: "Invalid email or password" }, 401);
  await assert.rejects(
    async () => {
      await act(async () => {
        await captured!.login("a@b.c", "wrong");
      });
    },
  );
  // The rejection escapes act() before React has flushed the setError render
  // (node:test surfaces that as the "update ... not wrapped in act" warning),
  // so one empty act is needed before the context value is readable.
  await act(async () => {});
  assert.ok(captured!.error, "password failure left a line");

  respond = () => mockJson(signedIn(), 200);
  await act(async () => {
    await captured!.oauthSignIn({ ...GOOGLE, mode: "signin" });
  });
  assert.equal(captured!.error, null);
});
