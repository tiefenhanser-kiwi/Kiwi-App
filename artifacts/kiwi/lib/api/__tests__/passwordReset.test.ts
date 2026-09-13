// WS9A BUG-235 / D-WS9-241 (C) — wire tests for lib/api/passwordReset.ts.
//
// Same fetch stub as client.test.ts: globalThis.fetch is replaced per test,
// calls are captured, and `nextResponse` supplies the server's answer. Every
// expectation below is a literal — nothing is computed from the module under
// test (§27.4). The screens under app/(auth)/ are outside the test glob
// (D-WS9-164) and are device-verified, not covered here.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

// `expo-secure-store` is stubbed by _loader.mjs — see _stubs.mjs.
import * as SecureStore from "expo-secure-store";

import { confirmPasswordReset, requestPasswordReset } from "../passwordReset";
import { apiBase } from "../base";
import { ApiError } from "../errors";

const TOKEN_KEY = "kiwi_authToken";

interface CallRecord {
  url: string;
  init?: RequestInit;
}
let calls: CallRecord[];
let nextResponse: () => Response | Promise<Response>;

function mockResponse(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  nextResponse = () => mockResponse({ success: true }, 200);
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url, init });
    return nextResponse();
  }) as unknown as typeof fetch;
  // A token IS stored, so a missing Authorization header below proves the
  // wrapper passed auth:false rather than merely finding no token to send.
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "test-token",
  );
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

test("requestPasswordReset POSTs {email} to /auth/password-reset/request with no Authorization", async () => {
  const result = await requestPasswordReset("a@b.co");

  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${apiBase}/auth/password-reset/request`);
  const init = calls[0].init!;
  assert.equal(init.method, "POST");
  assert.equal(init.body, '{"email":"a@b.co"}');
  const headers = (init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Authorization"], undefined);
});

test("confirmPasswordReset POSTs {token,newPassword} to /auth/password-reset/confirm with no Authorization", async () => {
  const result = await confirmPasswordReset("tok-0123456789abcdef", "hunter22");

  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${apiBase}/auth/password-reset/confirm`);
  const init = calls[0].init!;
  assert.equal(init.method, "POST");
  assert.equal(
    init.body,
    '{"token":"tok-0123456789abcdef","newPassword":"hunter22"}',
  );
  const headers = (init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Authorization"], undefined);
});

test("confirmPasswordReset on the opaque 400 rejects with ApiError status 400 + server copy", async () => {
  nextResponse = () =>
    mockResponse({ error: "invalid or expired reset token" }, 400);

  await assert.rejects(
    () => confirmPasswordReset("tok-0123456789abcdef", "hunter22"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.message, "invalid or expired reset token");
      return true;
    },
  );
});

test("requestPasswordReset on 429 rejects with ApiError status 429 + the limiter's copy", async () => {
  nextResponse = () =>
    mockResponse({ error: "Too many requests, slow down." }, 429);

  await assert.rejects(
    () => requestPasswordReset("a@b.co"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 429);
      assert.equal(err.message, "Too many requests, slow down.");
      return true;
    },
  );
});
