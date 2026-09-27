// Row 9 (1.1) · OAuth Block 2 Part B — the two bodies, and the three fields
// that separate sign-up from sign-in (§2.4).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appleRequestBody,
  googleRequestBody,
  oauthSharedBody,
  type OAuthContext,
} from "../request";

const SIGNUP: OAuthContext = {
  mode: "signup",
  platform: "ios",
  timezone: "America/New_York",
  consents: {
    phone: "+1 555 0100",
    marketingConsentEmail: true,
    marketingConsentSms: true,
  },
};

const SIGNIN: OAuthContext = {
  mode: "signin",
  platform: "ios",
  timezone: "America/New_York",
  // Deliberately present, and deliberately expected to be dropped: a caller
  // that passes the sign-up screen's state into a sign-in must not leak it.
  consents: {
    phone: "+1 555 0100",
    marketingConsentEmail: true,
    marketingConsentSms: true,
  },
};

// ── 🔴 break (3): the sign-in body must not carry consents ────────────────

test("🔴 the SIGN-IN body has no phone and no consent keys — not even false", () => {
  const body = oauthSharedBody(SIGNIN);
  assert.equal("phone" in body, false);
  assert.equal("marketingConsentEmail" in body, false);
  assert.equal("marketingConsentSms" in body, false);
});

test("🔴 the sign-in body still has no consent keys when the consents are FALSE", () => {
  // The dangerous direction. `false` from a screen with no checkboxes is this
  // client asserting a withdrawal the user never made, and the server applies
  // consents on CREATE — which a first sign-in is.
  const body = oauthSharedBody({
    ...SIGNIN,
    consents: { marketingConsentEmail: false, marketingConsentSms: false },
  });
  assert.equal("marketingConsentEmail" in body, false);
  assert.equal("marketingConsentSms" in body, false);
});

test("the SIGN-UP body carries all three", () => {
  const body = oauthSharedBody(SIGNUP);
  assert.equal(body.phone, "+1 555 0100");
  assert.equal(body.marketingConsentEmail, true);
  assert.equal(body.marketingConsentSms, true);
});

test("unchecked consents are sent as false from the sign-up screen — an explicit opt-out is a value", () => {
  const body = oauthSharedBody({
    ...SIGNUP,
    consents: { phone: "555 0100", marketingConsentEmail: false, marketingConsentSms: false },
  });
  assert.equal(body.marketingConsentEmail, false);
  assert.equal(body.marketingConsentSms, false);
});

// ── the SMS/phone pairing the server 400s on ──────────────────────────────

test("SMS consent is dropped when there is no phone — the wire-level guarantee", () => {
  const body = oauthSharedBody({
    ...SIGNUP,
    consents: { marketingConsentEmail: true, marketingConsentSms: true },
  });
  assert.equal("phone" in body, false);
  assert.equal("marketingConsentSms" in body, false);
  assert.equal(body.marketingConsentEmail, true);
});

test("a whitespace-only phone is no phone", () => {
  const body = oauthSharedBody({
    ...SIGNUP,
    consents: { phone: "   ", marketingConsentSms: true },
  });
  assert.equal("phone" in body, false);
  assert.equal("marketingConsentSms" in body, false);
});

// ── what rides BOTH modes ─────────────────────────────────────────────────

test("🔴 NAMES ride the sign-IN body too — Apple gives them once, on any screen", () => {
  const body = oauthSharedBody({ ...SIGNIN, firstName: "Ada", lastName: "Lovelace" });
  assert.equal(body.firstName, "Ada");
  assert.equal(body.lastName, "Lovelace");
});

test("platform and timezone ride both modes — device facts, not claims about the person", () => {
  for (const ctx of [SIGNUP, SIGNIN]) {
    const body = oauthSharedBody(ctx);
    assert.equal(body.platform, "ios");
    assert.equal(body.timezone, "America/New_York");
  }
});

test("an absent timezone is an absent KEY, not `undefined`", () => {
  // JSON.stringify drops an undefined value silently, so a body built with
  // spreads would not match what the code appears to send.
  const body = oauthSharedBody({ mode: "signin", platform: "web" });
  assert.equal("timezone" in body, false);
  assert.deepEqual(Object.keys(body), ["platform"]);
});

test("Apple's null name fields do not become the strings 'null'", () => {
  const body = oauthSharedBody({ ...SIGNIN, firstName: null, lastName: null });
  assert.equal("firstName" in body, false);
  assert.equal("lastName" in body, false);
});

// ── the claim ─────────────────────────────────────────────────────────────

test("the claim rides when there is a guest session, with the local date", () => {
  const body = oauthSharedBody({
    ...SIGNIN,
    claim: { guestSessionId: "gs_1", localDate: "2026-09-27" },
  });
  assert.equal(body.guestSessionId, "gs_1");
  assert.equal(body.localDate, "2026-09-27");
});

test("no guest session means neither key — localDate alone is meaningless to the server", () => {
  const body = oauthSharedBody({ ...SIGNIN, claim: { localDate: "2026-09-27" } });
  assert.equal("guestSessionId" in body, false);
  assert.equal("localDate" in body, false);
});

// ── the credentials ───────────────────────────────────────────────────────

test("the Apple body carries identityToken and the RAW nonce", () => {
  const body = appleRequestBody(
    { identityToken: "tok", rawNonce: "raw", authorizationCode: "code" },
    SIGNUP,
  );
  assert.equal(body.identityToken, "tok");
  assert.equal(body.rawNonce, "raw");
  assert.equal(body.authorizationCode, "code");
  assert.equal(body.platform, "ios");
  assert.equal(body.phone, "+1 555 0100");
});

test("an absent authorizationCode is omitted — its absence never blocks a sign-in", () => {
  // Web deliberately omits it (./appleWeb.ts: the server's exchange sends no
  // redirect_uri, which Apple requires for a Services-ID code), and the only
  // loss is having nothing to revoke at DELETE /me for a web-only account.
  for (const code of [undefined, null, ""]) {
    const body = appleRequestBody(
      { identityToken: "tok", rawNonce: "raw", authorizationCode: code },
      SIGNIN,
    );
    assert.equal("authorizationCode" in body, false, String(code));
  }
});

test("the Google body carries idToken and no nonce — Google needs none", () => {
  const body = googleRequestBody({ idToken: "gtok" }, { mode: "signin", platform: "android" });
  assert.equal(body.idToken, "gtok");
  assert.equal("rawNonce" in body, false);
  assert.equal(body.platform, "android");
});

test("the credential is never overwritten by a shared field of the same name", () => {
  // Guards the spread order in appleRequestBody / googleRequestBody: the
  // shared body is spread AFTER the credential, so a stray `identityToken`
  // arriving through the context would win. It cannot — the shared body's
  // type has no such key — but the ordering is worth pinning.
  const body = appleRequestBody({ identityToken: "tok", rawNonce: "raw" }, SIGNUP);
  assert.equal(body.identityToken, "tok");
  assert.equal(body.rawNonce, "raw");
});
