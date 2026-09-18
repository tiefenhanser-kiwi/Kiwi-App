// BUG-296 — the sign-in / sign-up copy decision for a failed auth call.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, UnauthenticatedError } from "@/lib/api/errors";
import {
  INVALID_EMAIL_SHAPE_COPY,
  RATE_LIMIT_FALLBACK_SEC,
  TOO_MANY_ATTEMPTS_COPY,
  authErrorPresentation,
} from "../authErrorCopy";

// What apiClient throws for the limiter's response:
//   429 { error: "Too many requests, slow down." } + Retry-After
function rateLimited(retryAfterSec?: number): ApiError {
  return new ApiError("Too many requests, slow down.", {
    status: 429,
    body: { error: "Too many requests, slow down." },
    userFacingMessage: "Too many requests, slow down.",
    retryAfterSec,
  });
}

test("429 with Retry-After → the too-many-attempts copy and the server's wait", () => {
  const p = authErrorPresentation(rateLimited(7), "Login failed");
  assert.equal(p.message, TOO_MANY_ATTEMPTS_COPY);
  assert.equal(p.retryAfterSec, 7);
});

test("429 without Retry-After → the same copy and the fallback wait", () => {
  const p = authErrorPresentation(rateLimited(undefined), "Login failed");
  assert.equal(p.message, TOO_MANY_ATTEMPTS_COPY);
  assert.equal(p.retryAfterSec, RATE_LIMIT_FALLBACK_SEC);
});

test("the server's verbatim 429 string never reaches the screen", () => {
  const p = authErrorPresentation(rateLimited(3), "Login failed");
  assert.notEqual(p.message, "Too many requests, slow down.");
});

test("400 'invalid request body' (schema-rejected email) → the email-shape copy, no hold", () => {
  const err = new ApiError("invalid request body", {
    status: 400,
    body: { error: "invalid request body" },
    userFacingMessage: "invalid request body",
  });
  const p = authErrorPresentation(err, "Login failed");
  assert.equal(p.message, INVALID_EMAIL_SHAPE_COPY);
  assert.equal(p.retryAfterSec, null);
});

test("any other 400 keeps its own message", () => {
  const err = new ApiError("email already registered", {
    status: 400,
    body: { error: "email already registered" },
    userFacingMessage: "email already registered",
  });
  const p = authErrorPresentation(err, "Signup failed");
  assert.equal(p.message, "email already registered");
  assert.equal(p.retryAfterSec, null);
});

test("401 invalid credentials passes through unchanged", () => {
  const err = new UnauthenticatedError({
    status: 401,
    body: { error: "invalid credentials" },
    userFacingMessage: "invalid credentials",
  });
  const p = authErrorPresentation(err, "Login failed");
  assert.equal(p.message, "invalid credentials");
  assert.equal(p.retryAfterSec, null);
});

test("a non-Error throw renders the caller's fallback", () => {
  const p = authErrorPresentation("nope", "Login failed");
  assert.equal(p.message, "Login failed");
  assert.equal(p.retryAfterSec, null);
});
