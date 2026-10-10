// Row 9 (1.1) · OAuth Block 2 Part D — Google Identity Services' own button.
//
// §2.1 — "its own rendered button on web". GIS draws it into a host node and
// reports through the callback registered at `initialize`, so there is no
// onPress to intercept: the credential simply arrives, and it IS the ID token
// (§2.7). That inverts the flow relative to native, which is why this
// component takes `onCredential` rather than `onPress`.
//
// `text: "continue_with"` gives "Continue with Google" — the wording §2.1
// asks for, and the wording the native button cannot be told to use. See
// GoogleContinueButton.tsx for that divergence.

import React from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { initGoogleWeb, renderGoogleWebButton } from "@/lib/oauth/googleWeb";
import { WEB_SOCIAL_BUTTON } from "@/lib/oauth/webButtonSize";
import { Radius } from "@/constants/tokens";

// WEB-1 (BUG-364) — was 48 around GIS's 40 px "large" button, so the host stood
// taller than the button and taller than Apple's. Now the button's own height.
const HEIGHT = WEB_SOCIAL_BUTTON.height;
/** GIS clamps to [200, 400]; this is the width before a layout pass lands. */
const FALLBACK_WIDTH = 320;

export interface GoogleWebButtonProps {
  onCredential: (idToken: string) => void;
  onFailure: (err: unknown) => void;
  disabled?: boolean;
}

export function GoogleWebButton({
  onCredential,
  onFailure,
  disabled,
}: GoogleWebButtonProps) {
  const hostRef = React.useRef<View | null>(null);
  const [width, setWidth] = React.useState(FALLBACK_WIDTH);
  const rendered = React.useRef(false);
  // Same reason as AppleWebButton: these change identity every render of the
  // block, and re-initialising GIS mid-flow would drop the callback.
  const onCredentialRef = React.useRef(onCredential);
  const onFailureRef = React.useRef(onFailure);
  onCredentialRef.current = onCredential;
  onFailureRef.current = onFailure;

  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setWidth(w);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = await initGoogleWeb(
          (idToken) => onCredentialRef.current(idToken),
          () =>
            onFailureRef.current(
              new Error("Google returned no credential"),
            ),
        );
        if (cancelled || !hostRef.current || rendered.current) return;
        // react-native-web renders <View> as a div, so the ref IS the host node.
        rendered.current = true;
        renderGoogleWebButton(api, hostRef.current, width);
      } catch (err) {
        // A blocked script, a CSP refusal, missing config. No button; the email
        // form below is untouched (§2.3).
        if (!cancelled) onFailureRef.current(err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `width` is deliberately NOT a dependency: re-rendering Google's button on
    // every layout tick would replace the node the user is mid-tap on. The
    // first measured width wins, and GIS clamps it anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View
      ref={hostRef}
      onLayout={onLayout}
      pointerEvents={disabled ? "none" : "auto"}
      style={[s.host, disabled && s.held]}
      testID="google-continue-web"
    />
  );
}

const s = StyleSheet.create({
  host: { minHeight: HEIGHT, borderRadius: Radius.md, overflow: "hidden" },
  held: { opacity: 0.5 },
});
