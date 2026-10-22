// SEC-3 B — re-auth for the email change and account deletion (lib/reauth.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, UnauthenticatedError } from "../api/errors.ts";
import {
  PASSWORD_INCORRECT,
  REAUTH_CODES,
  REAUTH_COPY,
  REAUTH_REQUIRED,
  accountHasPassword,
  learnedHasPassword,
  offersSignInAgain,
  reauthMethod,
  reauthBody,
  reauthFailure,
  reauthMessage,
  reauthReady,
  showsPasswordField,
} from "../reauth.ts";

const refusal = (status: number, code: string) =>
  status === 401
    ? new UnauthenticatedError({ status, body: { code } })
    : new ApiError("x", { status, body: { code } });

test("the two refusals are read by code: 401 reauth_required, 403 password_incorrect", () => {
  assert.equal(reauthFailure(refusal(401, "reauth_required")), REAUTH_REQUIRED);
  assert.equal(reauthFailure(refusal(403, "password_incorrect")), PASSWORD_INCORRECT);
  // By code, not by status: a server that answers either with the other status still reads right.
  assert.equal(reauthFailure(refusal(401, "password_incorrect")), PASSWORD_INCORRECT);
  assert.equal(reauthFailure(refusal(403, "reauth_required")), REAUTH_REQUIRED);
});

test("anything else is not a re-auth refusal (the screen keeps its own copy)", () => {
  assert.equal(reauthFailure(refusal(401, "token_expired")), null);
  assert.equal(reauthFailure(new ApiError("x", { status: 500, body: null })), null);
  assert.equal(reauthFailure(new Error("network")), null);
  assert.equal(reauthFailure(null), null);
});

test("🔴 both codes are kept out of the 401 cascade", () => {
  assert.deepEqual([...REAUTH_CODES].sort(), ["password_incorrect", "reauth_required"]);
});

test("hasPassword is read from the user payload when it is there, null when it is not", () => {
  assert.equal(accountHasPassword({ hasPassword: true }), true);
  assert.equal(accountHasPassword({ hasPassword: false }), false);
  assert.equal(accountHasPassword({}), null);
  assert.equal(accountHasPassword({ hasPassword: "yes" }), null);
  assert.equal(accountHasPassword(null), null);
});

test("the password field shows unless the account is known to have none", () => {
  assert.equal(showsPasswordField(true), true);
  assert.equal(showsPasswordField(null), true);
  assert.equal(showsPasswordField(false), false);
});

test("a password account must type one; the others may send without", () => {
  assert.equal(reauthReady(true, ""), false);
  assert.equal(reauthReady(true, "pw"), true);
  assert.equal(reauthReady(null, ""), true);
  assert.equal(reauthReady(false, ""), true);
});

test("the body carries the password only when one was typed (absent, not empty)", () => {
  assert.deepEqual(reauthBody("hunter22"), { currentPassword: "hunter22" });
  assert.deepEqual(reauthBody(""), {});
  assert.equal("currentPassword" in reauthBody(""), false);
});

test("plain messages: wrong password, too-old sign-in, and the unknown case", () => {
  assert.equal(reauthMessage(PASSWORD_INCORRECT, true), "That password isn't right. Please try again.");
  assert.equal(reauthMessage(PASSWORD_INCORRECT, null), REAUTH_COPY.passwordIncorrect);
  assert.equal(
    reauthMessage(REAUTH_REQUIRED, false),
    "It's been a while since you signed in. Sign in again to confirm.",
  );
  assert.equal(reauthMessage(REAUTH_REQUIRED, true), "Enter your current password to confirm.");
  assert.equal(
    reauthMessage(REAUTH_REQUIRED, null),
    "Enter your current password, or sign in again to confirm.",
  );
});

// SEC-2's real shape (e8c10293): 403s, and reauth_required names its method.
test("SEC-2's 403 reauth_required carries the method; the refusal teaches which account this is", () => {
  const needsPassword = new ApiError("x", { status: 403, body: { code: "reauth_required", method: "password" } });
  const needsSignIn = new ApiError("x", { status: 403, body: { code: "reauth_required", method: "sign_in" } });
  const wrong = new ApiError("x", { status: 403, body: { code: "password_incorrect" } });
  assert.equal(reauthFailure(needsPassword), REAUTH_REQUIRED);
  assert.equal(reauthMethod(needsPassword), "password");
  assert.equal(reauthMethod(needsSignIn), "sign_in");
  assert.equal(reauthMethod(wrong), null);
  assert.equal(learnedHasPassword(REAUTH_REQUIRED, "password"), true);
  assert.equal(learnedHasPassword(REAUTH_REQUIRED, "sign_in"), false);
  assert.equal(learnedHasPassword(PASSWORD_INCORRECT, null), true);
  assert.equal(learnedHasPassword(REAUTH_REQUIRED, null), null);
  // And what is then said: a Google/Apple account is told to sign in again.
  assert.equal(reauthMessage(REAUTH_REQUIRED, learnedHasPassword(REAUTH_REQUIRED, "sign_in")), REAUTH_COPY.signInTooOld);
  assert.equal(offersSignInAgain(REAUTH_REQUIRED, false), true);
  assert.equal(reauthMessage(REAUTH_REQUIRED, learnedHasPassword(REAUTH_REQUIRED, "password")), REAUTH_COPY.passwordNeeded);
});

test("'Sign in again' is offered for reauth_required, never to a known password account", () => {
  assert.equal(offersSignInAgain(REAUTH_REQUIRED, false), true);
  assert.equal(offersSignInAgain(REAUTH_REQUIRED, null), true);
  assert.equal(offersSignInAgain(REAUTH_REQUIRED, true), false);
  assert.equal(offersSignInAgain(PASSWORD_INCORRECT, null), false);
});
