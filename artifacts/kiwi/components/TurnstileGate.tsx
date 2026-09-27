// Row 13 "Test Kitchen" · Block 2 (R12) — the Cloudflare Turnstile widget.
//
// Renders NOTHING while EXPO_PUBLIC_TURNSTILE_SITE_KEY is unset, which is the
// state this block ships in (keys land in Block 3). The script injection below
// is real, not a stub, so Block 3's job is to set two env vars and watch it —
// but it is also unexercised until then, and that is stated here rather than
// discovered later.
//
// Web-only, like everything in the Test Kitchen (R1): `document` is reached
// through a guarded read, so importing this file on native (or in a node test)
// costs nothing and renders null.

import React from "react";
import { StyleSheet, View } from "react-native";

import { Spacing } from "@/constants/tokens";
import { turnstileSiteKey } from "@/lib/guest/turnstile";

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
  const siteKey = turnstileSiteKey();
  const hostRef = React.useRef<View | null>(null);
  const rendered = React.useRef(false);

  React.useEffect(() => {
    if (!siteKey || rendered.current) return;
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

  if (!siteKey) return null;
  return <View ref={hostRef} style={s.host} testID="turnstile-gate" />;
}

const s = StyleSheet.create({
  host: {
    marginTop: Spacing[3],
    minHeight: 65,
  },
});
