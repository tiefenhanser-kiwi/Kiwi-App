// Row 13 "Test Kitchen" · Block 2 (R12) — the Cloudflare Turnstile widget.
//
// Renders NOTHING while EXPO_PUBLIC_TURNSTILE_SITE_KEY is unset, which is the
// state this block ships in (keys land in Block 3). The script injection below
// is real, not a stub, so Block 3's job is to set two env vars and watch it —
// but it is also unexercised until then, and that is stated here rather than
// discovered later.
//
// Resub C1 — TWO GATES BEHIND ONE COMPONENT. The web gate below is unchanged:
// it injects Cloudflare's script into the page's own DOM (`document` is reached
// through a guarded read, so importing this file in a node test costs nothing).
// On iOS and Android there is no DOM — the web gate used to wait forever for a
// script that could never load — so the native gate renders the widget inside a
// react-native-webview instead. Its decisions (the page, the message shape, the
// state machine, which navigations it may make) are lib/guest/turnstile.ts.

import React from "react";
import { Linking, Platform, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";

import { Button } from "@/components/Button";
import { Colors, Spacing, Typography } from "@/constants/tokens";
import {
  parseTurnstileMessage,
  turnstileAllowsNavigation,
  turnstileGateReducer,
  turnstileHtml,
  turnstileSiteKey,
  TURNSTILE_NATIVE_BASE_URL,
  TURNSTILE_NATIVE_FAILED,
  TURNSTILE_NATIVE_RETRY,
  TURNSTILE_NATIVE_TIMEOUT_MS,
} from "@/lib/guest/turnstile";

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    el: unknown,
    opts: { sitekey: string; callback: (token: string) => void; "error-callback"?: () => void },
  ) => string | undefined;
}

function turnstileApi(): TurnstileApi | null {
  try {
    return (globalThis as { turnstile?: TurnstileApi }).turnstile ?? null;
  } catch {
    return null;
  }
}

function ensureScript(onReady: () => void): void {
  try {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return;
    if (turnstileApi()) return onReady();
    const existing = doc.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", onReady, { once: true });
      return;
    }
    const el = doc.createElement("script");
    el.id = SCRIPT_ID;
    el.src = SCRIPT_SRC;
    el.async = true;
    el.addEventListener("load", onReady, { once: true });
    doc.head.appendChild(el);
  } catch {
    // No DOM, or a CSP that refuses the script. The gate stays closed-but-silent:
    // onToken never fires, the entry's button stays disabled, and the visitor
    // sees the widget's own absence rather than a broken frame.
  }
}

export interface TurnstileGateProps {
  /** Fires once with the solved token. */
  onToken: (token: string) => void;
}

export function TurnstileGate({ onToken }: TurnstileGateProps) {
  // Site key unset → nothing, on every platform. The server passes the check
  // while its secret is unset, so the entry starts without a token.
  const siteKey = turnstileSiteKey();
  if (!siteKey) return null;
  if (Platform.OS !== "web") return <TurnstileNativeGate siteKey={siteKey} onToken={onToken} />;
  return <TurnstileWebGate siteKey={siteKey} onToken={onToken} />;
}

function TurnstileWebGate({ siteKey, onToken }: TurnstileGateProps & { siteKey: string }) {
  const hostRef = React.useRef<View | null>(null);
  const rendered = React.useRef(false);

  React.useEffect(() => {
    if (rendered.current) return;
    ensureScript(() => {
      const api = turnstileApi();
      // react-native-web renders <View> as a div, so the ref IS the host node.
      if (!api || !hostRef.current || rendered.current) return;
      rendered.current = true;
      api.render(hostRef.current, {
        sitekey: siteKey,
        callback: onToken,
        "error-callback": () => {
          rendered.current = false;
        },
      });
    });
  }, [siteKey, onToken]);

  return <View ref={hostRef} style={s.host} testID="turnstile-gate" />;
}

// ── native ───────────────────────────────────────────────────────────────

/**
 * The widget in a WebView, per Cloudflare's mobile requirements: JavaScript and
 * DOM storage on, cookies that persist (`sharedCookiesEnabled` on iOS,
 * `thirdPartyCookiesEnabled` on Android), `about:blank` / `about:srcdoc`
 * allowed (`originWhitelist={["*"]}`), and NO custom user agent — "Changing the
 * User Agent during a session causes Turnstile challenges to fail."
 *
 * The widget stays VISIBLE (a small card): managed mode may ask for a tap.
 */
function TurnstileNativeGate({ siteKey, onToken }: TurnstileGateProps & { siteKey: string }) {
  const [state, dispatch] = React.useReducer(turnstileGateReducer, "waiting");
  // Bumped by "Try again": a new key remounts the WebView, so the retry is a
  // fresh page and a fresh widget rather than a second render into the old one.
  const [attempt, setAttempt] = React.useState(0);
  const html = React.useMemo(() => turnstileHtml(siteKey), [siteKey]);

  // 20 s per attempt, and a token that lands first wins: the reducer ignores a
  // timeout that arrives after "solved". Resub C4 (BUG-369) — armed only while
  // "waiting", i.e. while the page LOADS: `interactive` moves the state on,
  // and this effect's cleanup clears the timer under the person at the box.
  React.useEffect(() => {
    if (state !== "waiting") return;
    const timer = setTimeout(() => dispatch({ type: "timeout" }), TURNSTILE_NATIVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state, attempt]);

  const onMessage = React.useCallback(
    (e: WebViewMessageEvent) => {
      const msg = parseTurnstileMessage(e.nativeEvent.data);
      if (!msg) return;
      dispatch(msg);
      if (msg.type === "turnstile") onToken(msg.token);
    },
    [onToken],
  );

  const onShouldStartLoadWithRequest = React.useCallback((req: ShouldStartLoadRequest) => {
    if (turnstileAllowsNavigation(req.url, req.isTopFrame)) return true;
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  if (state === "failed") {
    return (
      <View style={s.failed} testID="turnstile-gate-failed">
        <Text style={s.failedText}>{TURNSTILE_NATIVE_FAILED}</Text>
        <Button
          label={TURNSTILE_NATIVE_RETRY}
          variant="ghost"
          onPress={() => {
            setAttempt((n) => n + 1);
            dispatch({ type: "retry" });
          }}
          testID="turnstile-gate-retry"
        />
      </View>
    );
  }

  return (
    <View style={s.nativeHost} testID="turnstile-gate">
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
        testID="turnstile-webview"
      />
    </View>
  );
}

const s = StyleSheet.create({
  host: {
    marginTop: Spacing[3],
    minHeight: 65,
  },
  // Cloudflare's normal widget is 300 × 65; the extra height keeps its border
  // clear of the frame edge.
  nativeHost: {
    marginTop: Spacing[3],
    height: 72,
    alignSelf: "stretch",
  },
  webView: {
    flex: 1,
    backgroundColor: "transparent",
  },
  failed: {
    marginTop: Spacing[3],
    gap: Spacing[2],
  },
  failedText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    lineHeight: 18,
  },
});
