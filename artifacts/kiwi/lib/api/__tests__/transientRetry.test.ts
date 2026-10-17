// FIX-3 / BUG-395 + BUG-103 — the retry policy GET /home and GET /auth/me share.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, ApiNetworkError, ApiSchemaError, UnauthenticatedError } from "../errors";
import {
  isTransientError,
  shouldRetryTransient,
  transientRetryDelayMs,
} from "../transientRetry";

const apiErr = (status: number, retryAfterSec?: number) =>
  new ApiError("x", { status, body: null, retryAfterSec });
const abortErr = () => {
  const cause = new Error("The operation was aborted.");
  cause.name = "AbortError";
  return new ApiNetworkError("aborted", cause);
};

test("transient: 5xx and a failed fetch; not 4xx, not a schema error, not an abort", () => {
  for (const s of [500, 502, 503, 504]) assert.equal(isTransientError(apiErr(s)), true, `${s}`);
  for (const s of [400, 402, 404, 409, 429]) assert.equal(isTransientError(apiErr(s)), false, `${s}`);
  assert.equal(isTransientError(new UnauthenticatedError({ status: 401, body: null })), false);
  assert.equal(isTransientError(new ApiNetworkError("Network request failed", new TypeError("x"))), true);
  assert.equal(isTransientError(abortErr()), false, "our own deadline must not be retried");
  assert.equal(isTransientError(new ApiSchemaError("bad", [], {})), false);
  assert.equal(isTransientError(new Error("plain")), false);
});

test("at most two retries (React Query's failureCount is 0 on the first failure)", () => {
  const e = apiErr(503);
  assert.equal(shouldRetryTransient(0, e), true);
  assert.equal(shouldRetryTransient(1, e), true);
  assert.equal(shouldRetryTransient(2, e), false);
  assert.equal(shouldRetryTransient(0, apiErr(404)), false);
});

test("delay honours Retry-After, capped; else 1 s then 2 s", () => {
  assert.equal(transientRetryDelayMs(0, apiErr(503, 2)), 2000);
  assert.equal(transientRetryDelayMs(1, apiErr(503, 0)), 0);
  assert.equal(transientRetryDelayMs(0, apiErr(503, 3600)), 5000, "capped");
  assert.equal(transientRetryDelayMs(0, apiErr(503)), 1000);
  assert.equal(transientRetryDelayMs(1, apiErr(503)), 2000);
  assert.equal(transientRetryDelayMs(0, new ApiNetworkError("x", new TypeError("x"))), 1000);
});
