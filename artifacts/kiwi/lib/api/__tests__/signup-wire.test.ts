// D-WS9-241 A (BUG-261) — wire tests for lib/auth.ts signupRequest: phone
// and both consents are on the POST /auth/signup body, in ONE request, and
// the server's 400 for SMS-consent-without-phone surfaces as an ApiError
// with the server's copy. The form under app/(auth)/ is outside the test
// glob (D-WS9-164) and is device-verified.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { signupRequest } from "../../auth";
import { apiBase } from "../base";
import { ApiError } from "../errors";

const VALID_USER = {
  id: "u1",
  email: "a@b.co",
  firstName: "A",
  lastName: "B",
  phone: "(555) 123-4567",
  zipCode: null,
  timezone: "America/New_York",
  accountStatus: "active",
  subscriptionStatus: "trialing",
  defaultHouseholdSize: 4,
  lastPlanDiscoveryFilters: [],
  lastPlansFilters: [],
  lastMealsFilters: [],
  marketingConsentEmail: true,
  marketingConsentSms: true,
  onboardingComplete: false,
  firstRunChoiceMade: false,
  subscription: null,
  createdAt: "2026-09-13T00:00:00.000Z",
};

interface CallRecord {
  url: string;
  init?: RequestInit;
}
let calls: CallRecord[];
let nextResponse: () => Response;

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  nextResponse = () => mockResponse({ user: VALID_USER, authToken: "tok" }, 201);
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return nextResponse();
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

function sentBody(): Record<string, unknown> {
  assert.equal(calls.length, 1, "exactly one request");
  return JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
}

test("signupRequest puts phone + both consents on the POST /auth/signup body — one request, no Authorization", async () => {
  const res = await signupRequest({
    email: "a@b.co",
    password: "password123",
    firstName: "A",
    lastName: "B",
    timezone: "America/New_York",
    phone: "(555) 123-4567",
    marketingConsentEmail: true,
    marketingConsentSms: true,
  });
  assert.equal(calls[0].url, `${apiBase}/auth/signup`);
  assert.equal(calls[0].init?.method, "POST");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.deepEqual(sentBody(), {
    email: "a@b.co",
    password: "password123",
    firstName: "A",
    lastName: "B",
    timezone: "America/New_York",
    phone: "(555) 123-4567",
    marketingConsentEmail: true,
    marketingConsentSms: true,
  });
  assert.equal(res.authToken, "tok");
  assert.equal(res.user.phone, "(555) 123-4567");
  assert.equal(res.user.marketingConsentSms, true);
});

test("omitted phone / consents are absent from the body (server defaults apply), not sent as null/false", async () => {
  await signupRequest({
    email: "a@b.co",
    password: "password123",
    firstName: "A",
    lastName: "B",
  });
  const body = sentBody();
  assert.equal("phone" in body, false);
  assert.equal("marketingConsentEmail" in body, false);
  assert.equal("marketingConsentSms" in body, false);
});

test("the server's 400 for SMS consent without a phone surfaces as ApiError with the server copy", async () => {
  nextResponse = () => mockResponse({ error: "SMS consent requires a phone number" }, 400);
  await assert.rejects(
    () =>
      signupRequest({
        email: "a@b.co",
        password: "password123",
        firstName: "A",
        lastName: "B",
        marketingConsentSms: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal((err as ApiError).status, 400);
      assert.equal((err as ApiError).message, "SMS consent requires a phone number");
      return true;
    },
  );
  assert.equal(calls.length, 1, "no retry, no follow-up PATCH");
});
