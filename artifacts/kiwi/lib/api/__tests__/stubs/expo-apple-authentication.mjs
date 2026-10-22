// SEC-3 B — physical expo-apple-authentication stub for node:test. Loaded via
// the _loader.mjs resolve hook. components/ReauthFields.tsx renders
// SocialSignInBlock, whose iOS Apple button imports this module; its package
// build has an extensionless import Node cannot resolve. Only the names the
// button and lib/oauth/native.ts read exist here, and nothing signs in.
import React from "react";

export function AppleAuthenticationButton(props) {
  return React.createElement("apple-authentication-button", props);
}

export const AppleAuthenticationButtonType = { SIGN_IN: 0, CONTINUE: 1, SIGN_UP: 2 };
export const AppleAuthenticationButtonStyle = { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 };
export const AppleAuthenticationScope = { FULL_NAME: 0, EMAIL: 1 };

export async function isAvailableAsync() {
  return false;
}

export async function signInAsync() {
  throw new Error("expo-apple-authentication stub: no sign-in under node:test");
}
