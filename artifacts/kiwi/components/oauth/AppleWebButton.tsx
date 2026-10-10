// Row 9 (1.1) · OAuth Block 2 Part D — Apple's JS-rendered button on web.
//
// §2.1 — Apple's rendering, not ours. Apple's script draws the button into an
// element with `id="appleid-signin"`, so this component's whole job is to put
// that element on the page, configure the script for one attempt, and listen
// for the two document events Apple reports the outcome on.
//
// ── WHY A DOM NODE AND NOT A <View> ──────────────────────────────────────
//
// react-native-web renders <View> as a <div>, but it filters unknown props —
// the `data-color` / `data-border` / `data-type` attributes Apple's renderer
// reads would be dropped. So the host View holds a child div created by hand,
// which is also the shape components/TurnstileGate.tsx uses for Cloudflare's
// widget.
//
// ── WHY THE NONCE IS HELD IN A REF ───────────────────────────────────────
//
// Apple's success event carries the id_token and nothing else we sent. The
// RAW nonce — the one value the server compares against — only exists on this
// client, so the attempt that configured the script has to still be holding it
// when the event lands. `prepareAppleWeb()` returns it; this ref is where it
// waits. A mismatched `state` is refused in readAppleWebSuccess for the same
// reason: a stale event paired with a fresh nonce is a guaranteed 401.

import React from "react";
import { StyleSheet, View } from "react-native";

import {
  APPLE_BUTTON_ELEMENT_ID,
  APPLE_FAILURE_EVENT,
  APPLE_SUCCESS_EVENT,
  prepareAppleWeb,
  readAppleWebSuccess,
  type AppleWebResult,
  type AppleWebSuccessDetail,
} from "@/lib/oauth/appleWeb";
import { WEB_SOCIAL_BUTTON } from "@/lib/oauth/webButtonSize";
import { Radius } from "@/constants/tokens";

// WEB-1 (BUG-364) — was 48; now Google's fixed 40 so the pair match. Width is
// the shared box in SocialSignInBlock (≤ 375, Apple's ceiling).
const HEIGHT = WEB_SOCIAL_BUTTON.height;

export interface AppleWebButtonProps {
  onResult: (result: AppleWebResult) => void;
  /** Anything that is not a completed sign-in, cancels included. */
  onFailure: (err: unknown) => void;
  disabled?: boolean;
}

export function AppleWebButton({ onResult, onFailure, disabled }: AppleWebButtonProps) {
  const hostRef = React.useRef<View | null>(null);
  const attemptRef = React.useRef<{ rawNonce: string; state: string } | null>(null);
  // The callbacks change identity on every render of the block (they close over
  // `busy`). Reading them through a ref keeps the effect below from tearing
  // down and re-initialising Apple's script mid-flow.
  const onResultRef = React.useRef(onResult);
  const onFailureRef = React.useRef(onFailure);
  onResultRef.current = onResult;
  onFailureRef.current = onFailure;

  React.useEffect(() => {
    let cancelled = false;
    let d: Document | null = null;
    let created: HTMLElement | null = null;

    const onSuccess = (event: Event) => {
      const detail = (event as CustomEvent<AppleWebSuccessDetail>).detail;
      const attempt = attemptRef.current;
      if (!attempt) {
        onFailureRef.current(new Error("Apple signed in before this button was ready"));
        return;
      }
      try {
        onResultRef.current(readAppleWebSuccess(detail, attempt));
      } catch (err) {
        onFailureRef.current(err);
      } finally {
        // One nonce, one attempt. The next tap re-inits.
        attemptRef.current = null;
      }
    };

    const onError = (event: Event) => {
      // `detail.error` is Apple's reason string — "popup_closed_by_user" and
      // friends, which lib/oauth/errors.ts reads as a cancel. Forwarded as an
      // object with that key rather than an Error, because that IS the shape
      // Apple's other integration rejects with and there is one matcher.
      const detail = (event as CustomEvent<{ error?: string }>).detail;
      attemptRef.current = null;
      onFailureRef.current({ error: detail?.error ?? "unknown" });
    };

    (async () => {
      try {
        d = (globalThis as { document?: Document }).document ?? null;
        if (!d || !hostRef.current) return;
        // react-native-web renders <View> as a div, so the ref IS the host node.
        const host = hostRef.current as unknown as HTMLElement;
        let el = d.getElementById(APPLE_BUTTON_ELEMENT_ID);
        if (!el) {
          el = d.createElement("div");
          el.id = APPLE_BUTTON_ELEMENT_ID;
          el.setAttribute("data-color", "black");
          el.setAttribute("data-border", "true");
          el.setAttribute("data-type", "continue");
          el.setAttribute("data-border-radius", String(Radius.md));
          el.style.width = "100%";
          el.style.height = `${HEIGHT}px`;
          host.appendChild(el);
          created = el;
        }
        const attempt = await prepareAppleWeb();
        if (cancelled) return;
        attemptRef.current = attempt;
        d.addEventListener(APPLE_SUCCESS_EVENT, onSuccess);
        d.addEventListener(APPLE_FAILURE_EVENT, onError);
      } catch (err) {
        // A blocked script, a CSP refusal, missing config. The button simply is
        // not there; the email form below it is untouched (§2.3).
        if (!cancelled) onFailureRef.current(err);
      }
    })();

    return () => {
      cancelled = true;
      try {
        d?.removeEventListener(APPLE_SUCCESS_EVENT, onSuccess);
        d?.removeEventListener(APPLE_FAILURE_EVENT, onError);
        created?.remove();
      } catch {
        // Teardown of a DOM that is already gone.
      }
      attemptRef.current = null;
    };
  }, []);

  return (
    <View
      ref={hostRef}
      pointerEvents={disabled ? "none" : "auto"}
      style={[s.host, disabled && s.held]}
      testID="apple-continue-web"
    />
  );
}

const s = StyleSheet.create({
  host: { height: HEIGHT, overflow: "hidden", borderRadius: Radius.md },
  held: { opacity: 0.5 },
});
