// D-WS9-241 B (BUG-258) — fetchMeWithDeadline: the AbortController deadline
// around the bootstrap's /auth/me, and the three outcomes it has to keep
// distinct: abort/network → throws (failure), 401 → null (cascade), 5xx →
// throws (failure). The fetch stub honours `signal` the way a real fetch
// does — it rejects with an AbortError when the controller fires.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { fetchMeWithDeadline } from "../../auth";
import { ApiError, ApiNetworkError } from "../errors";
import { __resetForTests, subscribeSessionEvents } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";

const VALID_USER = {
  id: "u1",
  email: "a@b.co",
  firstName: "A",
  lastName: "B",
  phone: null,
  zipCode: null,
  timezone: "America/New_York",
  accountStatus: "active",
  subscriptionStatus: "trialing",
  defaultHouseholdSize: 4,
  lastPlanDiscoveryFilters: [],
  lastPlansFilters: [],
  lastMealsFilters: [],
  marketingConsentEmail: false,
  marketingConsentSms: false,
  onboardingComplete: false,
  firstRunChoiceMade: false,
  subscription: null,
  createdAt: "2026-05-19T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that never resolves on its own but rejects when `signal` aborts. */
function hangingFetch(signals: AbortSignal[]) {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signals.push(signal);
      signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    });
}

let fetchCalls: number;

beforeEach(() => {
  fetchCalls = 0;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "test-token",
  );
  __resetForTests();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  __resetForTests();
});

function setFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls += 1;
    return impl(url, init);
  }) as unknown as typeof fetch;
}

test("deadline: a hanging /auth/me is aborted at the deadline and surfaces as ApiNetworkError", async () => {
  const signals: AbortSignal[] = [];
  setFetch(hangingFetch(signals));

  const started = Date.now();
  await assert.rejects(
    () => fetchMeWithDeadline(40),
    (err: unknown) => {
      assert.ok(err instanceof ApiNetworkError, `expected ApiNetworkError, got ${String(err)}`);
      const cause = (err as ApiNetworkError).cause as Error;
      assert.equal(cause?.name, "AbortError");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 35, `fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 2000, `fired too late: ${elapsed}ms`);
  assert.equal(signals.length, 1, "one signal handed to fetch");
  assert.equal(signals[0].aborted, true, "the controller actually fired");
  assert.equal(fetchCalls, 1, "exactly one attempt — no retry inside the deadline wrapper");
});

test("deadline: a fast success resolves with the user and does not fire the abort", async () => {
  const signals: AbortSignal[] = [];
  setFetch((_url, init) => {
    if (init?.signal) signals.push(init.signal);
    return jsonResponse({ user: VALID_USER });
  });
  const user = await fetchMeWithDeadline(40);
  assert.equal(user?.id, "u1");
  // Let the (cleared) timer window pass; the signal must stay un-aborted.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(signals[0]?.aborted, false, "timer was cleared on settle");
});

test("401 still maps to null AND fires the cascade (token-clearing path unchanged)", async () => {
  setFetch(() => jsonResponse({ error: "expired" }, 401));
  const seen: string[] = [];
  const unsub = subscribeSessionEvents((e) => seen.push(e));
  try {
    const user = await fetchMeWithDeadline(1000);
    assert.equal(user, null);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, ["expired"]);
  } finally {
    unsub();
  }
});

test("5xx throws ApiError (a failure, not a sign-out) and does NOT fire the cascade", async () => {
  setFetch(() => jsonResponse({ error: "boom" }, 503));
  const seen: string[] = [];
  const unsub = subscribeSessionEvents((e) => seen.push(e));
  try {
    await assert.rejects(
      () => fetchMeWithDeadline(1000),
      (err: unknown) => err instanceof ApiError && (err as ApiError).status === 503,
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, []);
  } finally {
    unsub();
  }
});

test("network rejection throws ApiNetworkError and does NOT fire the cascade", async () => {
  setFetch(() => Promise.reject(new TypeError("Network request failed")));
  const seen: string[] = [];
  const unsub = subscribeSessionEvents((e) => seen.push(e));
  try {
    await assert.rejects(() => fetchMeWithDeadline(1000), ApiNetworkError);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, []);
  } finally {
    unsub();
  }
});
