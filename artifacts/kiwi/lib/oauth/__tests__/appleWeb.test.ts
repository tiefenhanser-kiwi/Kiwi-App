// Row 9 (1.1) · OAuth Block 2 Part D — reading Apple's web success event.
//
// The rest of appleWeb.ts is script loading and a call into Apple's own
// `init`, which needs a browser. This function is where a real mistake fits:
// pairing an id_token with the wrong raw nonce produces a 401 with no reason
// on the wire, which is the single hardest failure in this whole block to
// diagnose from the outside.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readAppleWebSuccess } from "../appleWeb";

const EXPECTED = { rawNonce: "a".repeat(64), state: "deadbeef" };

function detail(over: Record<string, unknown> = {}) {
  return {
    authorization: { code: "c0de", id_token: "tok", state: "deadbeef" },
    ...over,
  };
}

test("a good event yields the id_token paired with THIS attempt's raw nonce", () => {
  const r = readAppleWebSuccess(detail(), EXPECTED);
  assert.equal(r.credential.identityToken, "tok");
  assert.equal(r.credential.rawNonce, EXPECTED.rawNonce);
});

test("🔴 the authorization CODE is deliberately dropped on web", () => {
  // Apple's web popup does return one. It is not forwarded because the
  // server's exchange sends no `redirect_uri`, which Apple requires for a code
  // issued to a Services ID — so forwarding it would guarantee an
  // apple_code_exchange_failed warning on every web sign-in and still store
  // nothing. See the module header.
  const r = readAppleWebSuccess(detail(), EXPECTED);
  assert.equal("authorizationCode" in r.credential, false);
});

test("🔴 a state that does not match THIS attempt is refused", () => {
  // A stale success event paired with a fresh nonce is a guaranteed 401.
  // Failing here produces a message; failing there produces a mystery.
  assert.throws(
    () =>
      readAppleWebSuccess(
        detail({ authorization: { id_token: "tok", state: "someone-elses" } }),
        EXPECTED,
      ),
    /state did not match/,
  );
});

test("a missing state is refused too — absent is not a match", () => {
  assert.throws(
    () => readAppleWebSuccess(detail({ authorization: { id_token: "tok" } }), EXPECTED),
    /state did not match/,
  );
});

test("a success with no id_token is refused, and reads as a FAILURE not a cancel", async () => {
  const { isOAuthCancel } = await import("../errors");
  let thrown: unknown;
  try {
    readAppleWebSuccess(
      detail({ authorization: { code: "c0de", state: "deadbeef" } }),
      EXPECTED,
    );
  } catch (err) {
    thrown = err;
  }
  assert.match(String((thrown as Error).message), /no identity token/);
  assert.equal(isOAuthCancel(thrown), false);
});

test("a null detail is refused rather than dereferenced", () => {
  assert.throws(() => readAppleWebSuccess(null, EXPECTED), /state did not match/);
  assert.throws(() => readAppleWebSuccess(undefined, EXPECTED), /state did not match/);
});

// ── Apple's first-authorisation name ──────────────────────────────────────

test("the name rides when Apple sends it", () => {
  const r = readAppleWebSuccess(
    detail({ user: { name: { firstName: "Ada", lastName: "Lovelace" } } }),
    EXPECTED,
  );
  assert.equal(r.firstName, "Ada");
  assert.equal(r.lastName, "Lovelace");
});

test("no `user` block — every sign-in after the first — reads as null, not undefined", () => {
  // Null rather than undefined because lib/oauth/request.ts drops both, and a
  // null says "Apple told us nothing" where undefined reads as "we forgot to
  // look".
  const r = readAppleWebSuccess(detail(), EXPECTED);
  assert.equal(r.firstName, null);
  assert.equal(r.lastName, null);
});

test("a partial name is carried as far as it goes", () => {
  const r = readAppleWebSuccess(detail({ user: { name: { firstName: "Ada" } } }), EXPECTED);
  assert.equal(r.firstName, "Ada");
  assert.equal(r.lastName, null);
});
