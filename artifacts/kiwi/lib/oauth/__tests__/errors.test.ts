// Row 9 (1.1) · OAuth Block 2 Part B/E — what a failed social sign-in means
// (§2.6), and the session-scoped 503 hide.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, UnauthenticatedError } from "../../api/errors";
import {
  OAUTH_FAILED_COPY,
  OAUTH_REFUSED_COPY,
  isOAuthCancel,
  isProviderUnavailable,
  oauthFailure,
  oauthUnavailableCopy,
} from "../errors";
import {
  hiddenProviders,
  hideProviderForSession,
  resetHiddenProviders,
  subscribeHiddenProviders,
} from "../unavailable";

function apiError(status: number, body: unknown): ApiError {
  return new ApiError("x", { status, body });
}

// ── a dismissed sheet is not an error ────────────────────────────────────

test("Apple's ERR_REQUEST_CANCELED is a cancel, not a failure", () => {
  assert.equal(isOAuthCancel({ code: "ERR_REQUEST_CANCELED" }), true);
  assert.deepEqual(oauthFailure({ code: "ERR_REQUEST_CANCELED" }, "apple"), {
    kind: "cancelled",
  });
});

test("Apple's web popup rejections are cancels — and the reason is under `error`, not `code`", () => {
  for (const error of [
    "popup_closed_by_user",
    "user_cancelled_authorize",
    "user_trigger_new_signin_flow",
  ]) {
    assert.equal(isOAuthCancel({ error }), true, error);
    assert.equal(oauthFailure({ error }, "apple").kind, "cancelled", error);
  }
});

test("Google's SIGN_IN_CANCELLED is a cancel on the paths that still reject", () => {
  assert.equal(isOAuthCancel({ code: "SIGN_IN_CANCELLED" }), true);
  assert.equal(isOAuthCancel({ code: "-5" }), true);
});

test("a real failure is NOT read as a cancel", () => {
  assert.equal(isOAuthCancel({ code: "ERR_REQUEST_FAILED" }), false);
  assert.equal(isOAuthCancel(new Error("boom")), false);
  assert.equal(isOAuthCancel(null), false);
  assert.equal(isOAuthCancel("ERR_REQUEST_CANCELED"), false);
});

// ── the generic 401 ──────────────────────────────────────────────────────

test("a 401 shows ONE generic line — there is nothing to be specific with", () => {
  // The server answers 401 with no reason on the wire by design: an expired
  // token, a wrong audience and a mismatched nonce are one answer.
  const f = oauthFailure(apiError(401, { error: "invalid credentials" }), "google");
  assert.deepEqual(f, { kind: "message", message: OAUTH_REFUSED_COPY });
});

test("an UnauthenticatedError (apiClient's 401 class) takes the same branch", () => {
  const f = oauthFailure(new UnauthenticatedError({ status: 401, body: null }), "apple");
  assert.equal(f.kind, "message");
  assert.equal(f.kind === "message" && f.message, OAUTH_REFUSED_COPY);
});

// ── the 503 ──────────────────────────────────────────────────────────────

test("a 503 with code oauth_unavailable hides that provider and names it", () => {
  const f = oauthFailure(apiError(503, { code: "oauth_unavailable" }), "apple");
  assert.equal(f.kind, "unavailable");
  assert.equal(f.kind === "unavailable" && f.provider, "apple");
  assert.equal(f.kind === "unavailable" && f.message, oauthUnavailableCopy("apple"));
  assert.match(oauthUnavailableCopy("apple"), /Apple/);
  assert.match(oauthUnavailableCopy("google"), /Google/);
});

test("🔴 a 503 WITHOUT that code is not a statement about the provider", () => {
  // A cold start or a proxy answering 503 must not hide a working button for
  // the rest of the session — a state only a relaunch clears.
  assert.equal(isProviderUnavailable(apiError(503, { error: "upstream" })), false);
  assert.equal(isProviderUnavailable(apiError(503, null)), false);
  assert.equal(oauthFailure(apiError(503, {}), "google").kind, "message");
});

test("the code alone, on some other status, is not a 503 either", () => {
  assert.equal(isProviderUnavailable(apiError(500, { code: "oauth_unavailable" })), false);
});

// ── everything else ──────────────────────────────────────────────────────

test("a 500, a 409 and a plain Error all read as 'try again'", () => {
  for (const err of [apiError(500, {}), apiError(409, { code: "guest_session_invalid" }), new Error("offline")]) {
    assert.deepEqual(oauthFailure(err, "google"), {
      kind: "message",
      message: OAUTH_FAILED_COPY,
    });
  }
});

// ── the session-scoped hide ──────────────────────────────────────────────

test("hiding a provider is sticky, idempotent, and notifies subscribers once", () => {
  resetHiddenProviders();
  let notifications = 0;
  const unsubscribe = subscribeHiddenProviders(() => {
    notifications += 1;
  });

  assert.deepEqual(hiddenProviders(), []);
  hideProviderForSession("google");
  assert.deepEqual(hiddenProviders(), ["google"]);
  assert.equal(notifications, 1);

  hideProviderForSession("google");
  assert.equal(notifications, 1, "a second hide is a no-op");

  hideProviderForSession("apple");
  assert.deepEqual([...hiddenProviders()].sort(), ["apple", "google"]);
  assert.equal(notifications, 2);

  unsubscribe();
  resetHiddenProviders();
  hideProviderForSession("apple");
  assert.equal(notifications, 2, "an unsubscribed listener stops hearing");
  resetHiddenProviders();
});

test("🔴 the snapshot is STABLE between changes — useSyncExternalStore would loop otherwise", () => {
  resetHiddenProviders();
  const a = hiddenProviders();
  assert.equal(hiddenProviders(), a, "same reference while nothing changed");
  hideProviderForSession("apple");
  const b = hiddenProviders();
  assert.notEqual(b, a);
  assert.equal(hiddenProviders(), b);
  resetHiddenProviders();
});
