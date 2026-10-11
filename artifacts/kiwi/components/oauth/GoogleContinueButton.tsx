// Row 9 (1.1) · OAuth Block 2 Part C — the native "Continue with Google".
//
// WEB-2 Part E (BUG-364) — HAND-ROLLED. Hans, October 7: the SDK's
// GoogleSigninButton read "pretty square and less styled" than the rest of the
// auth screens; submit as is, hand-roll after launch. This is that button.
//
// It was Google's own rendering (D-WS9-270 item 6) for brand safety, at the
// price of the wording: the RN wrapper exposes no text option, so it read
// "Sign in with Google" against §2.1's "Continue with Google". Google's
// branding rules allow a custom button on two conditions this keeps: the "G"
// logo exactly as issued (GoogleGLogo.tsx) and the approved wording —
// "Continue with Google" is on that list. The light theme's fill, stroke and
// ink below are Google's published values for it, not Kiwi palette, for the
// same reason.
//
// Metrics are AppleContinueButton's — same height, full column width, same
// Radius.md — so the two stack as a pair on iOS. The tap still goes to the one
// sign-in function native has always used: SocialSignInBlock's onGoogle →
// lib/oauth/native.ts signInWithGoogleNative → GoogleSignin.signIn(). Only the
// rendering changed; the SDK's native module is still what signs in, so this is
// JS only and ships over the air.

import React from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";

import { Radius, Spacing, Typography } from "@/constants/tokens";

import { GoogleGLogo } from "./GoogleGLogo";

/** AppleContinueButton's height. */
const HEIGHT = 48;
export const GOOGLE_CONTINUE_LABEL = "Continue with Google";

/** Google's light-theme button values (branding guidelines), not Kiwi tokens. */
const GOOGLE_LIGHT = { fill: "#FFFFFF", stroke: "#747775", ink: "#1F1F1F" } as const;

export interface GoogleContinueButtonProps {
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}

export function GoogleContinueButton({
  onPress,
  disabled,
  busy,
}: GoogleContinueButtonProps) {
  if (Platform.OS === "web") {
    // SocialSignInBlock renders GoogleWebButton on web and never reaches here.
    // The guard stays because signInWithGoogleNative throws on web (the SDK's
    // web build is a sponsors-only stub).
    return null;
  }
  const held = !!disabled || !!busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={held}
      accessibilityRole="button"
      accessibilityLabel={GOOGLE_CONTINUE_LABEL}
      accessibilityState={{ disabled: held, busy: !!busy }}
      testID="google-continue"
      style={({ pressed }) => [s.button, pressed && s.pressed, held && s.held]}
    >
      <GoogleGLogo size={18} />
      <Text style={s.label} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {GOOGLE_CONTINUE_LABEL}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  // Logo then label, centred as one group — the way Apple's CONTINUE button
  // sits directly above it.
  button: {
    height: HEIGHT,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing[3],
    paddingHorizontal: Spacing[4],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: GOOGLE_LIGHT.stroke,
    backgroundColor: GOOGLE_LIGHT.fill,
  },
  pressed: { opacity: 0.85 },
  held: { opacity: 0.5 },
  // Google's spec face is Roboto Medium: the system face at 500 IS Roboto on
  // Android; iOS draws its own system face (no font asset ships for this).
  label: {
    fontSize: Typography.fontSize.lg,
    fontWeight: Typography.fontWeight.medium,
    color: GOOGLE_LIGHT.ink,
    flexShrink: 1,
  },
});
