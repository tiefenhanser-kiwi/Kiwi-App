import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";

// `expo-secure-store` is stubbed by _loader.mjs — see _stubs.mjs for the
// in-memory replacement that lib/auth.ts ends up bound to under test.
import * as SecureStore from "expo-secure-store";

import { apiClient } from "../client";
import {
  ApiError,
  ApiNetworkError,
  ApiSchemaError,
  UnauthenticatedError,
  UpgradeRequiredError,
} from "../errors";
import { __resetForTests, subscribeSessionEvents } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";

// Stub fetch + capture call args.
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
  nextResponse = () => mockResponse({}, 200);
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url, init });
    return nextResponse();
  }) as unknown as typeof fetch;
  // Set token by default for auth-required tests.
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "test-token",
  );
  __resetForTests();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

test("rejects non-leading-slash path with a programmer-error throw", async () => {
  await assert.rejects(
    () => apiClient("auth/me"),
    /must start with/,
  );
});

test("GET with default opts sends Authorization + parses JSON", async () => {
  nextResponse = () => mockResponse({ ok: true });
  const data = await apiClient("/some/path");
  assert.deepEqual(data, { ok: true });
  assert.equal(calls.length, 1);
  const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-token");
});

test("POST with object body sets Content-Type and JSON-stringifies", async () => {
  await apiClient("/x", { method: "POST", body: { a: 1 } });
  const init = calls[0].init!;
  const headers = (init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(init.body, JSON.stringify({ a: 1 }));
});

test("auth: false skips token + Authorization header", async () => {
  await apiClient("/public", { auth: false });
  const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["Authorization"], undefined);
});

test("missing token + auth required → UnauthenticatedError + cascade fires", async () => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();

  const seen: string[] = [];
  subscribeSessionEvents((e) => seen.push(e));

  await assert.rejects(() => apiClient("/me"), UnauthenticatedError);

  // Microtask drain.
  await new Promise<void>((r) => queueMicrotask(r));
  assert.deepEqual(seen, ["expired"]);
});

test("401 from server → UnauthenticatedError + cascade fires", async () => {
  nextResponse = () => mockResponse({ error: "expired" }, 401);

  const seen: string[] = [];
  subscribeSessionEvents((e) => seen.push(e));

  await assert.rejects(() => apiClient("/me"), UnauthenticatedError);
  await new Promise<void>((r) => queueMicrotask(r));
  assert.deepEqual(seen, ["expired"]);
});

test("402 from server → UpgradeRequiredError, NO cascade", async () => {
  nextResponse = () =>
    mockResponse(
      { error: "trial ended", userFacingMessage: "Upgrade to keep going" },
      402,
    );

  const seen: string[] = [];
  subscribeSessionEvents((e) => seen.push(e));

  await assert.rejects(async () => {
    await apiClient("/wizard/build-plans", { method: "POST", body: {} });
  }, (err: unknown) => {
    assert.ok(err instanceof UpgradeRequiredError);
    assert.equal(err.userFacingMessage, "Upgrade to keep going");
    return true;
  });
  await new Promise<void>((r) => queueMicrotask(r));
  assert.deepEqual(seen, []);
});

test("other 4xx → ApiError with status + body + extracted userFacingMessage", async () => {
  nextResponse = () =>
    mockResponse({ error: "Plan not found" }, 404);
  await assert.rejects(
    () => apiClient("/plans/xx"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.ok(!(err instanceof UnauthenticatedError));
      assert.equal(err.status, 404);
      assert.deepEqual(err.body, { error: "Plan not found" });
      assert.equal(err.userFacingMessage, "Plan not found");
      return true;
    },
  );
});

test("network-level fetch rejection → ApiNetworkError", async () => {
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    throw new TypeError("Network request failed");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => apiClient("/x"),
    (err: unknown) => {
      assert.ok(err instanceof ApiNetworkError);
      return true;
    },
  );
});

test("schema mismatch on 2xx → ApiSchemaError with received body", async () => {
  nextResponse = () => mockResponse({ wrong: true });
  const schema = z.object({ count: z.number() });
  await assert.rejects(
    () => apiClient("/x", { schema }),
    (err: unknown) => {
      assert.ok(err instanceof ApiSchemaError);
      assert.deepEqual(err.received, { wrong: true });
      return true;
    },
  );
});

test("schema success returns the parsed value", async () => {
  nextResponse = () => mockResponse({ count: 7 });
  const schema = z.object({ count: z.number() });
  const out = await apiClient("/x", { schema });
  assert.deepEqual(out, { count: 7 });
});

test("envelope mode: 200 → { success: true, data }", async () => {
  nextResponse = () => mockResponse({ k: "v" });
  const res = await apiClient("/x", { errorMode: "envelope" });
  assert.deepEqual(res, { success: true, data: { k: "v" } });
});

test("envelope mode: 404 → { success: false, error: ApiError }", async () => {
  nextResponse = () => mockResponse({ error: "nope" }, 404);
  const res = await apiClient("/x", { errorMode: "envelope" });
  assert.equal(res.success, false);
  if (!res.success) {
    assert.ok(res.error instanceof ApiError);
    assert.equal(res.error.status, 404);
  }
});

test("envelope mode: 401 → fires cascade AND returns envelope failure", async () => {
  nextResponse = () => mockResponse({ error: "x" }, 401);
  const seen: string[] = [];
  subscribeSessionEvents((e) => seen.push(e));
  const res = await apiClient("/x", { errorMode: "envelope" });
  assert.equal(res.success, false);
  if (!res.success) {
    assert.ok(res.error instanceof UnauthenticatedError);
  }
  await new Promise<void>((r) => queueMicrotask(r));
  assert.deepEqual(seen, ["expired"]);
});

test("apiBase + path concatenation uses leading-slash path verbatim", async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://api.example.com/api";
  try {
    nextResponse = () => mockResponse({});
    // Re-imports happen lazily — for this assertion, we rely on the
    // currently-loaded apiBase. Test just checks the leading-slash
    // concatenation works against whatever base resolved at module load.
    await apiClient("/hello");
    const url = calls[0].url;
    assert.ok(url.endsWith("/hello"), `expected url to end with /hello, got ${url}`);
  } finally {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  }
});

test("parseAs: 'none' skips body parsing", async () => {
  nextResponse = () => new Response(":not-json:", { status: 200 });
  // Would throw with parseAs: 'json' (default). With 'none' it just resolves.
  const out = await apiClient("/x", { parseAs: "none" });
  assert.equal(out, undefined);
});

test("parseAs: 'text' returns the raw text body", async () => {
  nextResponse = () => new Response("hello world", { status: 200 });
  const out = await apiClient("/x", { parseAs: "text" });
  assert.equal(out, "hello world");
});

test("non-JSON body on 2xx with parseAs: 'json' → ApiSchemaError", async () => {
  nextResponse = () => new Response("<<<not-json>>>", { status: 200 });
  await assert.rejects(
    () => apiClient("/x"),
    (err: unknown) => {
      assert.ok(err instanceof ApiSchemaError);
      return true;
    },
  );
});
