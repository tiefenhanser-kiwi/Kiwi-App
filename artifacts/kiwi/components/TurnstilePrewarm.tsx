// Resub C3 (BUG-361) — Turnstile, started while Welcome is showing.
//
// Mounted by app/(auth)/welcome.tsx, NOT at the app root: a signed-in member
// must not pay a Cloudflare round trip at every launch. It runs the same page
// the visible native gate runs (lib/guest/turnstile.ts turnstileHtml), hidden,
// and puts what it gets into GuestContext's store; the Test Kitchen entry reads
// the store at the tap (lib/guest/turnstilePrewarm.ts decideTurnstileEntry).
//
// ⚠️ OFF-SCREEN, NOT ZERO-SIZED AND NOT display:none. A WebView that is not laid
// out may not run, and Cloudflare's widget is a 300 × 65 iframe that a 0-wide
// viewport gives nowhere to lay out. So the frame is the widget's real size,
// placed far off the left edge, transparent, untouchable and hidden from screen
// readers.
//
// The WebView is mounted ONLY WHILE WARMING. Once there is a token (or a verdict
// of interactive / failed) it is unmounted: the token lives in the store, and a
// hidden widget left running would re-solve every few minutes for as long as
// Welcome sits under the Test Kitchen in the stack. Lingering is handled by the
// discard timer below — a token older than TURNSTILE_TOKEN_FRESH_MS is dropped
// and, while Welcome is focused, a new warm starts.
//
// On "interactive" the hidden widget is LEFT ALONE (unmounted, never solved
// unseen) and the tap shows the visible gate, which shows the checkbox.

import React from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { useFocusEffect } from "expo-router";

import { useGuestOptional } from "@/contexts/GuestContext";
import {
  parseTurnstileMessage,
  turnstileAllowsNavigation,
  turnstileHtml,
  turnstileSiteKey,
  TURNSTILE_NATIVE_BASE_URL,
  TURNSTILE_NATIVE_TIMEOUT_MS,
} from "@/lib/guest/turnstile";
import {
  TURNSTILE_TOKEN_FRESH_MS,
  type TurnstileWarmEvent,
  type TurnstileWarmStore,
} from "@/lib/guest/turnstilePrewarm";

export function TurnstilePrewarm() {
  // Web is unchanged (its gate injects the script at the tap), and no site key
  // means the server is not checking — there is nothing to warm.
  const guest = useGuestOptional();
  const siteKey = turnstileSiteKey();
  if (!guest || !siteKey || Platform.OS === "web") return null;
  return (
    <TurnstilePrewarmNative
      siteKey={siteKey}
      store={guest.turnstile}
      dispatch={guest.dispatchTurnstile}
    />
  );
}

function TurnstilePrewarmNative({
  siteKey,
  store,
  dispatch,
}: {
  siteKey: string;
  store: TurnstileWarmStore;
  dispatch: (event: TurnstileWarmEvent) => void;
}) {
  const html = React.useMemo(() => turnstileHtml(siteKey), [siteKey]);
  // Bumped per warm: a new key is a fresh page and a fresh widget.
  const [attempt, setAttempt] = React.useState(0);
  // Welcome stays mounted under the Test Kitchen; a warm starts only while it is
  // the screen on top.
  const [focused, setFocused] = React.useState(true);
  useFocusEffect(
    React.useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // Start a warm whenever there is nothing held and Welcome is showing: on
  // mount, after a stale token is discarded, and on returning to Welcome after
  // the Test Kitchen spent the last one. `warming` with attempt 0 is a warm an
  // earlier, unmounted Welcome left behind — its WebView is gone, so restart it.
  React.useEffect(() => {
    if (!focused) return;
    const orphaned = store.status === "warming" && attempt === 0;
    if (store.status !== "idle" && !orphaned) return;
    setAttempt((n) => n + 1);
    dispatch({ type: "warm" });
  }, [focused, store.status, attempt, dispatch]);

  // No token in time → failed, and the tap shows the visible gate. (Cloudflare
  // documents before-interactive-callback, so a challenge that wants a person
  // arrives as "interactive", not as this timeout.)
  React.useEffect(() => {
    if (store.status !== "warming") return;
    const timer = setTimeout(() => dispatch({ type: "failed" }), TURNSTILE_NATIVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [store.status, attempt, dispatch]);

  // A lingering visitor: drop the token before Cloudflare's 300 s are up.
  React.useEffect(() => {
    if (store.status !== "ready" || store.issuedAt === null) return;
    const left = Math.max(0, store.issuedAt + TURNSTILE_TOKEN_FRESH_MS - Date.now());
    const timer = setTimeout(() => dispatch({ type: "discard" }), left);
    return () => clearTimeout(timer);
  }, [store.status, store.issuedAt, dispatch]);

  const onMessage = React.useCallback(
    (e: WebViewMessageEvent) => {
      const msg = parseTurnstileMessage(e.nativeEvent.data);
      if (!msg) return;
      switch (msg.type) {
        case "turnstile":
          dispatch({ type: "token", token: msg.token, at: Date.now() });
          return;
        case "interactive":
          dispatch({ type: "interactive" });
          return;
        case "expired":
          // The widget re-solves by itself; its next token lands as "turnstile".
          dispatch({ type: "expired" });
          return;
        case "error":
          dispatch({ type: "failed" });
          return;
      }
    },
    [dispatch],
  );

  const onShouldStartLoadWithRequest = React.useCallback((req: ShouldStartLoadRequest) => {
    if (turnstileAllowsNavigation(req.url, req.isTopFrame)) return true;
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  if (store.status !== "warming") return null;

  return (
    <View
      style={s.offscreen}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="turnstile-prewarm"
    >
      <WebView
        key={attempt}
        source={{ html, baseUrl: TURNSTILE_NATIVE_BASE_URL }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        scrollEnabled={false}
        style={s.webView}
        testID="turnstile-prewarm-webview"
      />
    </View>
  );
}

const s = StyleSheet.create({
  // The visible gate's frame size (300 × 65 widget, 72 tall with its border),
  // a long way off the left edge.
  offscreen: {
    position: "absolute",
    left: -10_000,
    top: 0,
    width: 320,
    height: 72,
    opacity: 0,
  },
  webView: {
    flex: 1,
    backgroundColor: "transparent",
  },
});
