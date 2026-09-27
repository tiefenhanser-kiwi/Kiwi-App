// Row 9 (1.1) · OAuth Block 2 Part C — Google's button, Google's rendering.
//
// §2.1 — "Google's follows Google's branding rules (its own rendered button on
// web; a branded button on native)."
//
// `GoogleSigninButton` from @react-native-google-signin IS Google's own
// rendered button: on Android it is the platform SignInButton, on iOS the
// GIDSignInButton. Choosing it over a hand-rolled row with a "G" asset is a
// brand-risk decision, not a convenience — the logo, its clear space, the
// typeface and the pressed state all come from Google's SDK and cannot drift.
//
// 🔴 ONE CONSEQUENCE, AND IT IS A DIVERGENCE FROM §2.1'S LABEL. The native
// button's text is the SDK's, and the RN wrapper exposes only `size`, `color`
// and `disabled` — no text option. So on iOS and Android this reads "Sign in
// with Google", not "Continue with Google". Apple's component has a CONTINUE
// type and Google's has no equivalent. The alternatives were to hand-roll the
// button (drift risk on the one asset Google reviews) or to ship a label that
// is not Google's; neither is obviously better than one word of difference, so
// this is reported rather than decided. Web says "Continue with Google"
// because Google Identity Services offers `text: "continue_with"` (Part D) —
// so the two platforms will not match, which is Google's doing, not ours.

import { GoogleSigninButton } from "@react-native-google-signin/google-signin";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";

const HEIGHT = 48;

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
    // The guard stays because the package's web build is a stub that throws
    // "Web support is only available to sponsors" — a fall-through would put
    // that sentence in front of a user.
    return null;
  }
  return (
    <View style={s.host}>
      <GoogleSigninButton
        size={GoogleSigninButton.Size.Wide}
        color={GoogleSigninButton.Color.Light}
        disabled={disabled || busy}
        onPress={onPress}
        style={s.button}
        testID="google-continue"
      />
    </View>
  );
}

const s = StyleSheet.create({
  // Google's button draws its own shadow and will not stretch past its
  // intrinsic width, so the host centres it rather than fighting it.
  host: { height: HEIGHT, alignItems: "stretch", justifyContent: "center" },
  button: { width: "100%", height: HEIGHT },
});
