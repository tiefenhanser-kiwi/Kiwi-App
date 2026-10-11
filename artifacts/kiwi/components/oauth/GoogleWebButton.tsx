// Row 9 (1.1) · OAuth Block 2 Part D — Google Identity Services' own button.
//
// §2.1 — "its own rendered button on web". GIS draws it into a host node and
// reports through the callback registered at `initialize`, so there is no
// onPress to intercept: the credential simply arrives, and it IS the ID token
// (§2.7). That inverts the flow relative to native, which is why this
// component takes `onCredential` rather than `onPress`.
//
// `text: "continue_with"` gives "Continue with Google" — the wording §2.1
// asks for.
//
// WEB-2 Part E — why web is NOT hand-rolled like native (BUG-364). Kiwi's
// server takes a Google ID TOKEN (POST /auth/oauth/google, `idToken`), and in
// GIS only two things hand one to a page: this rendered button and the One Tap
// prompt. The oauth2 token client returns an ACCESS token and the code client
// an authorization CODE — neither is an ID token, and exchanging a code needs
// a server change. One Tap (`prompt()`) is not a button: Google suppresses it
// on a cooldown after a dismissal, so a custom button wired to it would
// sometimes do nothing. So web keeps Google's rendering, and BUG-389 is fixed
// here instead: the button is re-drawn when its host's width changes.

import React from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { gsiButtonWidth, initGoogleWeb, renderGoogleWebButton } from "@/lib/oauth/googleWeb";
import { WEB_SOCIAL_BUTTON } from "@/lib/oauth/webButtonSize";
import { Radius } from "@/constants/tokens";

// WEB-1 (BUG-364) — was 48 around GIS's 40 px "large" button, so the host stood
// taller than the button and taller than Apple's. Now the button's own height.
const HEIGHT = WEB_SOCIAL_BUTTON.height;
/** GIS clamps to [200, 400]; this is the width before a layout pass lands. */
const FALLBACK_WIDTH = 320;
/** A window drag fires layout continuously; re-draw once it settles. */
export const GSI_RERENDER_DEBOUNCE_MS = 150;

type GsiApi = Awaited<ReturnType<typeof initGoogleWeb>>;

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
  // The initialised GIS api once the script is in, and the clamped width the
  // host currently holds a button for (null = nothing drawn yet).
  const [api, setApi] = React.useState<GsiApi | null>(null);
  const drawnWidth = React.useRef<number | null>(null);
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
        const ready = await initGoogleWeb(
          (idToken) => onCredentialRef.current(idToken),
          () =>
            onFailureRef.current(
              new Error("Google returned no credential"),
            ),
        );
        if (!cancelled) setApi(ready);
      } catch (err) {
        // A blocked script, a CSP refusal, missing config. No button; the email
        // form below is untouched (§2.3).
        if (!cancelled) onFailureRef.current(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Draw once the api is in, and again whenever the host's width changes the
  // button GIS would draw (BUG-389: it used to keep its first width forever).
  // The first draw is immediate; a re-draw waits for the layout to settle, so
  // the node is not replaced on every tick of a window drag.
  React.useEffect(() => {
    if (!api) return;
    const target = gsiButtonWidth(width);
    if (drawnWidth.current === target) return;
    const draw = () => {
      // react-native-web renders <View> as a div, so the ref IS the host node.
      const host = hostRef.current as unknown as { replaceChildren?: () => void } | null;
      if (!host) return;
      // GIS appends into the parent; clear the old button first.
      if (drawnWidth.current !== null) host.replaceChildren?.();
      drawnWidth.current = target;
      renderGoogleWebButton(api, host, target);
    };
    if (drawnWidth.current === null) {
      draw();
      return;
    }
    const t = setTimeout(draw, GSI_RERENDER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [api, width]);

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
