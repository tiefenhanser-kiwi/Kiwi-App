// Row 9 (1.1) · OAuth Block 2 Part C — "Continue with Apple", Apple's own
// rendering.
//
// §2.1 — "Apple's button must be Apple's rendering (the native
// AppleAuthenticationButton on iOS; Apple's JS-rendered button on web)."
//
// This is not a style preference. expo-apple-authentication's own docs:
// "The App Store Guidelines require you to use this component to start the
// authentication process instead of a custom button", and the component
// refuses `backgroundColor` / `borderRadius` through `style` because setting
// them is against those guidelines. `cornerRadius` is the sanctioned knob and
// it is the only one used here.
//
// `buttonType: CONTINUE` is what makes the label read "Continue with Apple"
// rather than "Sign in with Apple" — the wording §2.1 asks for, drawn by
// Apple, localised by Apple.
//
// ⚠️ RENDERING THIS OFF-iOS WOULD THROW: the underlying view manager
// (src/ExpoAppleAuthenticationButton.ts) is `undefined` on every other
// platform. lib/oauth/providers.ts is what keeps that from happening — it
// answers false for Android outright and gates iOS on `isAvailableAsync()`.

import * as AppleAuthentication from "expo-apple-authentication";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";

import { Radius } from "@/constants/tokens";
import type { OAuthMode } from "@/lib/oauth/request";

/** Apple's own metric for the button; below ~44 the label clips. */
const HEIGHT = 48;

export interface AppleContinueButtonProps {
  mode: OAuthMode;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}

export function AppleContinueButton({
  mode,
  onPress,
  disabled,
  busy,
}: AppleContinueButtonProps) {
  if (Platform.OS === "web") {
    // SocialSignInBlock renders AppleWebButton on web and never reaches here.
    // The guard stays because the cost of being wrong is not a bad layout:
    // src/ExpoAppleAuthenticationButton.ts is `undefined` off-iOS, so
    // rendering the component below on web would throw.
    return null;
  }
  return (
    <View
      // The button swallows touches itself, so "disabled" is expressed the one
      // way a native view will honour: stop it receiving them. Opacity says so
      // visually. (There is no `disabled` prop on Apple's component.)
      pointerEvents={disabled || busy ? "none" : "auto"}
      style={[s.host, (disabled || busy) && s.held]}
    >
      <AppleAuthentication.AppleAuthenticationButton
        // §2.1's wording, drawn and localised by Apple. SIGN_UP does not
        // exist as a type; CONTINUE is the neutral one and it is correct on
        // both screens, because either tap may be a first sign-in.
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={Radius.md}
        style={s.button}
        onPress={onPress}
        testID={`apple-continue-${mode}`}
      />
    </View>
  );
}

const s = StyleSheet.create({
  host: { height: HEIGHT },
  // Apple's component needs explicit width AND height or it does not appear.
  button: { width: "100%", height: HEIGHT },
  held: { opacity: 0.5 },
});
