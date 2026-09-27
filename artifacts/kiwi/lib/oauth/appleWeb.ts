// Row 9 (1.1) · OAuth Block 2 Part D — Sign in with Apple JS.
//
// §2.7 — "Sign in with Apple JS (appleid.auth.js, usePopup: true, clientId =
// the Services ID, redirectURI = https://app.kitchenwizard.ai/auth/apple,
// scope: 'name email', nonce = the hex digest, state random)."
//
// ── THE BUTTON IS APPLE'S, SO THE RESULT ARRIVES AS AN EVENT ──────────────
//
// §2.1 requires Apple's own rendering. Apple's script draws the button into
// an element with `id="appleid-signin"` and then reports the outcome by
// dispatching `AppleIDSignInOnSuccess` / `AppleIDSignInOnFailure` on
// `document` — NOT by resolving the promise `AppleID.auth.signIn()` returns.
// That promise belongs to the other integration (your own button), which §2.1
// rules out. So this module is init + two document listeners, and the
// component owns their lifetime.
//
// ── THE NONCE, AGAIN ─────────────────────────────────────────────────────
//
// `init({ nonce })` is the HASH. Apple embeds it in the id_token; the server
// recomputes sha256hex(rawNonce) and compares. The RAW value never leaves
// this client except in the body of the POST to Kiwi. Re-`init` before every
// attempt, because a nonce that is reused is not a nonce.
//
// ── ONE THING WE DELIBERATELY DO NOT SEND ────────────────────────────────
//
// 🔴 `authorization.code`. Apple's web popup DOES return one — the comment
// that said otherwise in ./request.ts was wrong and is corrected there. It is
// not forwarded because of the SERVER, not the client: exchangeAppleAuthoriz-
// ationCode (api-server/src/lib/oauth/appleTokens.ts) sends `grant_type`,
// `code`, `client_id` and the client secret, and no `redirect_uri` — which
// Apple requires for a code issued to a Services ID. Forwarding it would
// produce a guaranteed `apple_code_exchange_failed` warning on every web
// sign-in and still store nothing to revoke. The cost is that a web-only
// Apple account has no refresh token at DELETE /me, which the server already
// handles and says so. Server-side follow-up; see the report.

import { expoRandomBytes, expoSha256 } from "./crypto";
import { makeNoncePair, randomNonce } from "./nonce";
import { readOAuthClientConfig } from "./providers";
import type { AppleCredential } from "./request";
import { loadProviderScript } from "./webScripts";

const SCRIPT_ID = "apple-signin-js";
// The `en_US` segment is part of Apple's published path; the locale only
// affects the button's own label, which Apple localises from it.
const SCRIPT_SRC =
  "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

export const APPLE_SUCCESS_EVENT = "AppleIDSignInOnSuccess";
export const APPLE_FAILURE_EVENT = "AppleIDSignInOnFailure";

interface AppleIDAuth {
  init: (opts: {
    clientId: string;
    scope: string;
    redirectURI: string;
    state: string;
    nonce: string;
    usePopup: boolean;
  }) => void;
  renderButton?: () => void;
}

interface AppleIDGlobal {
  auth: AppleIDAuth;
}

/** What `AppleIDSignInOnSuccess`'s `detail` carries. */
export interface AppleWebSuccessDetail {
  authorization?: {
    code?: string;
    id_token?: string;
    state?: string;
  };
  /** FIRST authorisation only, and only when `name` was in scope. */
  user?: {
    name?: { firstName?: string; lastName?: string };
    email?: string;
  };
}

function appleId(): AppleIDGlobal | null {
  try {
    return (globalThis as { AppleID?: AppleIDGlobal }).AppleID ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the script and configure it for ONE attempt. Returns the raw nonce the
 * eventual success has to be paired with — the caller holds it until the event
 * arrives, because it is the one value Apple will never echo back.
 */
export async function prepareAppleWeb(): Promise<{ rawNonce: string; state: string }> {
  const cfg = readOAuthClientConfig();
  if (!cfg.appleServicesId || !cfg.appleWebRedirectUri) {
    // providers.ts already refused to render the button, so this is a
    // programmer error rather than a deploy state.
    throw new Error("prepareAppleWeb: EXPO_PUBLIC_APPLE_SERVICES_ID / _WEB_REDIRECT_URI unset");
  }
  await loadProviderScript(SCRIPT_ID, SCRIPT_SRC);
  const api = appleId();
  if (!api) throw new Error("prepareAppleWeb: appleid.auth.js loaded but AppleID is absent");

  const nonce = await makeNoncePair({ sha256: expoSha256, randomBytes: expoRandomBytes });
  // 16 bytes of hex. Apple echoes it in `authorization.state`, and
  // `readAppleWebSuccess` refuses a mismatch — the OAuth 2.0 §10.12 check,
  // and here specifically a guard against a success event left over from a
  // flow this mount did not start.
  const state = randomNonce(expoRandomBytes, 16);
  api.auth.init({
    // The Services ID, NOT the bundle identifier. Apple treats them as
    // different clients and the token's `aud` is this value.
    clientId: cfg.appleServicesId,
    scope: "name email",
    // Must match a Return URL registered on that Services ID, character for
    // character. In popup mode nothing is actually navigated there — Apple
    // still validates it, which is why app/auth/apple.tsx exists.
    redirectURI: cfg.appleWebRedirectUri,
    state,
    nonce: nonce.hashed,
    usePopup: true,
  });
  // Present when the button element appeared after the script loaded, which is
  // every mount after the first.
  api.auth.renderButton?.();
  return { rawNonce: nonce.raw, state };
}

export interface AppleWebResult {
  credential: AppleCredential;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Turn Apple's event detail into the shape the request builder takes, or throw.
 *
 * `authorization.code` is deliberately dropped — see the header.
 */
export function readAppleWebSuccess(
  detail: AppleWebSuccessDetail | null | undefined,
  expected: { rawNonce: string; state: string },
): AppleWebResult {
  const echoed = detail?.authorization?.state;
  if (echoed !== expected.state) {
    // Not "reject the sign-in Apple approved" for its own sake: this event did
    // not come from the attempt holding `rawNonce`, so the raw nonce we would
    // pair with it is the wrong one and the server would 401 anyway. Failing
    // here produces a message; failing there produces a mystery.
    throw Object.assign(new Error("Apple's state did not match this attempt"), {
      code: "ERR_REQUEST_FAILED",
    });
  }
  const idToken = detail?.authorization?.id_token;
  if (!idToken) {
    throw Object.assign(new Error("Apple returned no identity token"), {
      code: "ERR_REQUEST_FAILED",
    });
  }
  return {
    credential: { identityToken: idToken, rawNonce: expected.rawNonce },
    firstName: detail?.user?.name?.firstName ?? null,
    lastName: detail?.user?.name?.lastName ?? null,
  };
}

/**
 * The element id Apple's script looks for. Exported so the component and this
 * module cannot disagree about it.
 */
export const APPLE_BUTTON_ELEMENT_ID = "appleid-signin";
