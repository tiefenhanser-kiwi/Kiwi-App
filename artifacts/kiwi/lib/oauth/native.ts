// Row 9 (1.1) · OAuth Block 2 Part C — THE TWO NATIVE FLOWS.
//
// Everything above this file is pure and tested (./nonce, ./providers,
// ./request, ./errors). This is where the native modules are touched, and it
// holds no decisions of its own beyond the order of three calls — which is
// why it is thin, and why it is not in the test glob.
//
// ── expo-apple-authentication IS IMPORT-SAFE ON WEB, checked ──────────────
//
// src/ExpoAppleAuthentication.ts uses `requireOptionalNativeModule` and falls
// back to a pretend module whose `isAvailableAsync()` resolves false. So
// importing this file on web costs a module, not a crash. (The BUTTON is a
// different matter: src/ExpoAppleAuthenticationButton.ts is `undefined`
// off-iOS, so rendering it anywhere else would throw. ./providers.ts keeps
// that from happening by answering false.)
//
// ── @react-native-google-signin IS A STUB ON WEB, also checked ────────────
//
// 🔴 Its web build warns on `configure()` and THROWS on `signIn()`:
// "Web support is only available to sponsors." That is not a gap in the
// install — it is the package's published web behaviour, and it is why §2.7
// sends web to Google Identity Services instead. Nothing here may run on web,
// and `signInWithGoogleNative` says so out loud rather than letting the
// sponsor message surface as the user's error.

import * as AppleAuthentication from "expo-apple-authentication";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { Platform } from "react-native";

import { expoRandomBytes, expoSha256 } from "./crypto";
import { makeNoncePair } from "./nonce";
import { readOAuthClientConfig } from "./providers";
import type { AppleCredential } from "./request";

/** `isAvailableAsync()` — false below iOS 13 and on a build with no entitlement. */
export function appleNativeAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync();
}

export interface AppleNativeResult {
  credential: AppleCredential;
  /** Apple's FIRST-authorisation gift. Null on every subsequent sign-in. */
  firstName: string | null;
  lastName: string | null;
}

/**
 * The nonce is generated HERE, not by the caller, because the pair must not be
 * separable: Apple is handed `hashed` and Kiwi is handed `raw`, and a caller
 * holding both is a caller that can send the wrong one. See ./nonce.ts.
 */
export async function signInWithAppleNative(): Promise<AppleNativeResult> {
  const nonce = await makeNoncePair({
    sha256: expoSha256,
    randomBytes: expoRandomBytes,
  });

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    // The HASH. Apple echoes it inside the signed token; the server recomputes
    // sha256hex(rawNonce) and compares.
    nonce: nonce.hashed,
  });

  // `signInAsync` already throws ERR_REQUEST_FAILED when identityToken is
  // missing, so this is belt-and-braces — but the cast it saves is real: the
  // type is `string | null` and the request body's is `string`.
  if (!credential.identityToken) {
    throw Object.assign(new Error("Apple returned no identity token"), {
      code: "ERR_REQUEST_FAILED",
    });
  }

  return {
    credential: {
      identityToken: credential.identityToken,
      // The RAW value. This is the line the whole nonce contract rests on.
      rawNonce: nonce.raw,
      authorizationCode: credential.authorizationCode,
    },
    firstName: credential.fullName?.givenName ?? null,
    lastName: credential.fullName?.familyName ?? null,
  };
}

/**
 * Configure once per process. `configure()` is synchronous and idempotent, but
 * calling it on every tap would also call it on web — where it logs the
 * sponsor warning — so it is gated and remembered.
 */
let googleConfigured = false;

function configureGoogle(): void {
  if (googleConfigured) return;
  const cfg = readOAuthClientConfig();
  // ./providers.ts already refused to render the button without these, so a
  // null here is a programmer error, not a deploy state.
  if (!cfg.googleWebClientId) {
    throw new Error("configureGoogle: EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is unset");
  }
  GoogleSignin.configure({
    // The WEB client id, on iOS and Android both: it is the audience the ID
    // TOKEN is minted for, and the server checks the token against exactly
    // this list. Android's own OAuth client is never named here — it exists
    // so Google will accept the package name + SHA-1.
    webClientId: cfg.googleWebClientId,
    ...(cfg.googleIosClientId ? { iosClientId: cfg.googleIosClientId } : {}),
    // No `offlineAccess`: that asks for a serverAuthCode, and Kiwi's server
    // revokes Google nothing (only Apple's refresh token is stored, and only
    // because App Review 5.1.1(v) requires it).
  });
  googleConfigured = true;
}

/** Null when the user dismissed the sheet — a cancel is a RESULT in v16, not a throw. */
export async function signInWithGoogleNative(): Promise<{ idToken: string } | null> {
  if (Platform.OS === "web") {
    // Unreachable through the UI (./providers.ts + the web button send web to
    // Google Identity Services), and stated rather than left to the package's
    // "only available to sponsors" message reaching a user.
    throw new Error("signInWithGoogleNative: web uses Google Identity Services");
  }
  configureGoogle();
  if (Platform.OS === "android") {
    // Throws PLAY_SERVICES_NOT_AVAILABLE on a device without them, which
    // ./errors.ts reads as an ordinary failure. Left as a throw rather than a
    // pre-check: a device that cannot do this cannot be talked into it.
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }
  const result = await GoogleSignin.signIn();
  if (result.type === "cancelled") return null;
  const idToken = result.data.idToken;
  if (!idToken) {
    // `idToken` is `string | null`, and null means configure() got no
    // webClientId — which configureGoogle() refuses above, so this is the
    // impossible branch made visible instead of sent to the server as "null".
    throw new Error("Google returned no ID token");
  }
  return { idToken };
}
