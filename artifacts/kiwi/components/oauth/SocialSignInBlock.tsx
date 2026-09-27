// Row 9 (1.1) · OAuth Block 2 Parts C–E — THE SOCIAL BLOCK, one component for
// both screens.
//
// §2.1 — "Two buttons at the top of BOTH the sign-up and the sign-in screens
// … then an 'or' divider, then the existing email form."
//
// It is one component and not two because the difference between the screens
// is three fields on a request body (§2.4) and one line of copy, and because
// a second copy of "which buttons exist" is a second copy that can disagree
// with lib/oauth/providers.ts.
//
// ── WHAT RENDERS WHERE ───────────────────────────────────────────────────
//
//   iOS      Apple's own AppleAuthenticationButton (App Store Guidelines
//            require the proprietary component, not a custom button) +
//            Google's own GoogleSigninButton
//   Android  GoogleSigninButton alone (§2.2 — Sign in with Apple belongs on
//            Apple platforms)
//   web      Apple's JS-rendered button + Google Identity Services' rendered
//            button, both drawn by the provider's own script (Part D)
//
// ── NOTHING, when nothing is configured ──────────────────────────────────
//
// §2.3. No buttons, NO DIVIDER, and the screens look exactly as they did
// before this block — which is the state CI and every build before Hans
// finishes the console work is in.
//
// ── THE ERROR LINE LIVES HERE ────────────────────────────────────────────
//
// A social sign-in can fail in two places: at the provider (a dismissed
// sheet, a Play-Services-less device) and at Kiwi (401, 503). The first never
// reaches AuthContext, so the copy has one owner and it is this component,
// rendered under the buttons that produced it. AuthContext keeps only the
// 503 hide, because that is session state. §2.6: a cancel sets nothing.

import React from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { oauthFailure } from "@/lib/oauth/errors";
import {
  anyProviderVisible,
  providerButtons,
  type AppPlatform,
  type OAuthProvider,
} from "@/lib/oauth/providers";
import {
  hiddenProviders,
  hideProviderForSession,
  subscribeHiddenProviders,
} from "@/lib/oauth/unavailable";
import type { OAuthAuthResponse } from "@/lib/oauth/api";
import type { AppleWebResult } from "@/lib/oauth/appleWeb";
import type { AppleCredential, OAuthConsentFields, OAuthMode } from "@/lib/oauth/request";
import { Colors, Radius, Spacing, Typography } from "@/constants/tokens";

import { AppleContinueButton } from "./AppleContinueButton";
import { AppleWebButton } from "./AppleWebButton";
import { GoogleContinueButton } from "./GoogleContinueButton";
import { GoogleWebButton } from "./GoogleWebButton";

const PLATFORM = Platform.OS as AppPlatform;

export interface SocialSignInBlockProps {
  /** Which screen this is. Decides whether the consents ride (§2.4). */
  mode: OAuthMode;
  /** Sign-up screen only, and read at TAP time so a late tick still counts. */
  consents?: OAuthConsentFields;
  /** The email form is mid-submit; hold the social buttons too. */
  disabled?: boolean;
  /**
   * A completed sign-in. The screen routes and says its own line — "Account
   * created" reads wrong under a Sign in title, and `isNewUser` is what tells
   * the sign-in screen it was in fact a sign-up.
   */
  onSuccess: (res: OAuthAuthResponse) => void;
}

export function SocialSignInBlock({
  mode,
  consents,
  disabled,
  onSuccess,
}: SocialSignInBlockProps) {
  const { oauthSignIn } = useAuth();

  // Hooks first, every one of them, before any decision about what to render.
  const [appleNativeReady, setAppleNativeReady] = React.useState(false);
  const [busy, setBusy] = React.useState<OAuthProvider | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const hidden = React.useSyncExternalStore(
    subscribeHiddenProviders,
    hiddenProviders,
    hiddenProviders,
  );

  // iOS Apple is gated on isAvailableAsync(), not on env — see
  // lib/oauth/providers.ts. Starts false so the button does not flash in and
  // out on the first frame, and the import is lazy so the native module is
  // never reached on web or Android.
  React.useEffect(() => {
    if (PLATFORM !== "ios") return;
    let cancelled = false;
    (async () => {
      try {
        const { appleNativeAvailable } = await import("@/lib/oauth/native");
        const ok = await appleNativeAvailable();
        if (!cancelled) setAppleNativeReady(ok);
      } catch {
        // A build without the entitlement, or a module that would not load.
        // Either way: no button, and the email form is untouched.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const buttons = providerButtons(PLATFORM, {
    appleNativeAvailable: appleNativeReady,
    hidden,
  });

  /**
   * One wrapper for both providers. `get` returns the credential, or null when
   * the person dismissed the sheet — the cancel that §2.6 says is not an error.
   */
  const run = React.useCallback(
    async <T extends AppleCredential | { idToken: string }>(
      provider: OAuthProvider,
      get: () => Promise<{
        credential: T;
        firstName?: string | null;
        lastName?: string | null;
      } | null>,
    ) => {
      if (busy || disabled) return;
      setError(null);
      setBusy(provider);
      try {
        const got = await get();
        if (!got) return; // dismissed: say nothing, do nothing
        const res = await oauthSignIn({
          provider,
          mode,
          credential: got.credential,
          firstName: got.firstName,
          lastName: got.lastName,
          // Passed only on the sign-up screen. lib/oauth/request.ts drops them
          // on `mode === "signin"` regardless, so this is belt and braces —
          // and the belt is the one that is tested.
          consents: mode === "signup" ? consents : undefined,
        });
        onSuccess(res);
      } catch (err) {
        const failure = oauthFailure(err, provider);
        // The hide is idempotent, and AuthContext already did it for a refusal
        // that reached the server. This covers the case where it did not.
        if (failure.kind === "unavailable") hideProviderForSession(provider);
        if (failure.kind !== "cancelled") setError(failure.message);
      } finally {
        setBusy(null);
      }
    },
    [busy, disabled, mode, consents, oauthSignIn, onSuccess],
  );

  const onApple = React.useCallback(
    () =>
      run("apple", async () => {
        const { signInWithAppleNative } = await import("@/lib/oauth/native");
        return signInWithAppleNative();
      }),
    [run],
  );

  const onGoogle = React.useCallback(
    () =>
      run("google", async () => {
        const { signInWithGoogleNative } = await import("@/lib/oauth/native");
        const got = await signInWithGoogleNative();
        return got ? { credential: got } : null;
      }),
    [run],
  );

  // ── Part D — the web flows arrive INVERTED ────────────────────────────
  //
  // Both web buttons are drawn by the provider's own script (§2.1), so
  // neither has an onPress this component can wrap. The credential simply
  // turns up: Google through the callback registered at initialize(), Apple
  // through a document event. So the web halves feed `run` a getter that
  // already holds the answer, and a failure feeds it a rejection — which
  // keeps ONE classifier (§2.6) rather than a second copy of the catch.
  const onAppleWebResult = React.useCallback(
    (result: AppleWebResult) => run("apple", async () => result),
    [run],
  );
  const onGoogleWebCredential = React.useCallback(
    (idToken: string) => run("google", async () => ({ credential: { idToken } })),
    [run],
  );
  const onProviderFailure = React.useCallback(
    (provider: OAuthProvider, err: unknown) => run(provider, () => Promise.reject(err)),
    [run],
  );
  const onAppleWebFailure = React.useCallback(
    (err: unknown) => onProviderFailure("apple", err),
    [onProviderFailure],
  );
  const onGoogleWebFailure = React.useCallback(
    (err: unknown) => onProviderFailure("google", err),
    [onProviderFailure],
  );

  // §2.3 — absent, not empty. No stranded divider over a blank row.
  if (!anyProviderVisible(buttons) && error === null) return null;

  const held = !!busy || !!disabled;

  return (
    <View style={s.wrap} testID="social-sign-in">
      {buttons.apple ? (
        PLATFORM === "web" ? (
          <AppleWebButton
            onResult={onAppleWebResult}
            onFailure={onAppleWebFailure}
            disabled={held}
          />
        ) : (
          <AppleContinueButton
            mode={mode}
            onPress={onApple}
            disabled={held}
            busy={busy === "apple"}
          />
        )
      ) : null}
      {buttons.google ? (
        PLATFORM === "web" ? (
          <GoogleWebButton
            onCredential={onGoogleWebCredential}
            onFailure={onGoogleWebFailure}
            disabled={held}
          />
        ) : (
          <GoogleContinueButton onPress={onGoogle} disabled={held} busy={busy === "google"} />
        )
      ) : null}
      {busy ? (
        <View style={s.busy}>
          <ActivityIndicator color={Colors.sage[700]} />
        </View>
      ) : null}
      {error ? (
        <Text style={s.error} testID="social-sign-in-error">
          {error}
        </Text>
      ) : null}
      {anyProviderVisible(buttons) ? <OrDivider /> : null}
    </View>
  );
}

function OrDivider() {
  return (
    <View style={s.divider} accessible={false}>
      <View style={s.rule} />
      <Text style={s.or}>or</Text>
      <View style={s.rule} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: Spacing[3] },
  busy: { alignItems: "center" },
  error: {
    color: Colors.terracotta[700],
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[500],
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    marginVertical: Spacing[1],
  },
  rule: { flex: 1, height: 1, backgroundColor: Colors.neutral[400], borderRadius: Radius.sm },
  or: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
  },
});
