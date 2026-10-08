// Row 13 "Test Kitchen" · Block 2 (R12) — the Turnstile gate, as data.
//
// Keys arrive in Block 3. Until then BOTH halves are unset and both sides agree
// on what that means: the server lets the check pass through while
// TURNSTILE_SECRET_KEY is unset, and this client sends nothing. "Send nothing"
// is the ruling's word — not an empty string, which is a token the server would
// be entitled to reject once a secret IS set.

/**
 * The build's own environment, as the default every function below reads.
 *
 * 🔴 RESUB C1 — THE KEY IS READ AS A LITERAL `process.env.EXPO_PUBLIC_…`, AND IT
 * HAS TO BE. babel-preset-expo inlines an EXPO_PUBLIC_ variable only where the
 * source spells out that member expression
 * (node_modules/babel-preset-expo/build/inline-env-vars.js matches
 * `process.env.<KEY>`). The old default was `env = process.env` followed by
 * `env.EXPO_PUBLIC_TURNSTILE_SITE_KEY`, which survives the build as a RUNTIME
 * read of a `process.env` that holds no EXPO_PUBLIC_ values — measured with
 * the production native transform: the key's value never reached the output.
 * So every build read the key as unset, the widget never rendered, and the
 * moment the server's secret is set every POST /guest/session would be a 403.
 */
function buildEnv(): Record<string, string | undefined> {
  return { EXPO_PUBLIC_TURNSTILE_SITE_KEY: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY };
}

/**
 * The site key, or null. Read through a function rather than as a module const
 * so a test can assert both branches without re-importing the module: Expo
 * inlines `process.env.EXPO_PUBLIC_*` at build time, so the VALUE is fixed per
 * build, but the decision below stays testable.
 */
export function turnstileSiteKey(
  env: Record<string, string | undefined> = buildEnv(),
): string | null {
  const key = env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

/** R12 — render the widget, and require a token before the door opens. */
export function turnstileEnabled(
  env: Record<string, string | undefined> = buildEnv(),
): boolean {
  return turnstileSiteKey(env) !== null;
}

/**
 * The body field for POST /guest/session. `{}` when Turnstile is off — the
 * server's schema has `turnstileToken` optional, and an absent field is the only
 * honest way to say "this client was not asked to prove anything".
 */
export function turnstileRequestFields(
  token: string | null,
  env: Record<string, string | undefined> = buildEnv(),
): { turnstileToken?: string } {
  if (!turnstileEnabled(env)) return {};
  return token ? { turnstileToken: token } : {};
}

// ── Resub C1 — the NATIVE widget, which runs inside a WebView ─────────────
//
// The web gate injects Cloudflare's script into the page's own DOM. A phone has
// no DOM, so on iOS and Android the widget runs in a react-native-webview whose
// page is the string below, and its three callbacks come back to React Native
// as postMessage strings. The server rule does not move: POST /guest/session
// still verifies whatever token this produces.

/**
 * The origin the WebView's page claims, via `source={{ html, baseUrl }}`.
 * Turnstile checks the page's hostname against the hostnames registered for
 * the site key, and an inline HTML string has no hostname of its own — so it
 * borrows the WEB Test Kitchen's. ⚠️ This host must be on the site key's
 * hostname list in the Cloudflare dashboard, or every native solve fails with
 * the widget's own error (110200, "domain not allowed") and the gate shows its
 * retry.
 */
export const TURNSTILE_NATIVE_BASE_URL = "https://app.kitchenwizard.ai/";

/**
 * No token by then → "We couldn't check this device." Never a hang.
 *
 * Resub C4 (BUG-369) — the budget covers the LOAD only: the page reaching a
 * token or Cloudflare's checkbox. Once the widget posts `interactive` a person
 * is looking at the checkbox, and their time is theirs — the gate leaves
 * "waiting" for "interactive" and the timer (armed only while waiting) is
 * cleared. A load that never reaches either still times out.
 */
export const TURNSTILE_NATIVE_TIMEOUT_MS = 20_000;

export const TURNSTILE_NATIVE_FAILED = "We couldn't check this device. Try again.";
export const TURNSTILE_NATIVE_RETRY = "Try again";

const API_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=kiwiTurnstileLoad";

/**
 * The WebView's whole page. The callbacks are defined BEFORE the script tag
 * that loads Cloudflare's API, so `onload` and a failed script load both find
 * them. The key goes in through JSON.stringify with `<` escaped, so no key
 * value can close the <script> it sits in.
 */
export function turnstileHtml(siteKey: string): string {
  const key = JSON.stringify(siteKey).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
html, body { margin: 0; padding: 0; background: transparent; }
#kiwi-turnstile { display: flex; justify-content: center; }
</style>
<script>
function kiwiPost(m) {
  try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {}
}
window.kiwiTurnstileLoad = function () {
  try {
    window.turnstile.render("#kiwi-turnstile", {
      sitekey: ${key},
      callback: function (token) { kiwiPost({ type: "turnstile", token: token }); },
      "error-callback": function () { kiwiPost({ type: "error" }); },
      "expired-callback": function () { kiwiPost({ type: "expired" }); },
      "before-interactive-callback": function () { kiwiPost({ type: "interactive" }); }
    });
  } catch (e) {
    kiwiPost({ type: "error" });
  }
};
</script>
<script src="${API_SRC}" async defer onerror="kiwiPost({ type: 'error' })"></script>
</head>
<body>
<div id="kiwi-turnstile"></div>
</body>
</html>`;
}

/**
 * Resub C3 (BUG-361) — `interactive` is Turnstile's "before-interactive-callback"
 * ("invoked before the challenge enters interactive mode", Cloudflare's widget
 * configurations page, checked October 7): the widget is about to show its
 * checkbox. The VISIBLE gate needs nothing from it — the person sees the
 * checkbox. The hidden prewarm uses it to stand down so the tap shows the gate.
 */
export type TurnstileMessage =
  | { type: "turnstile"; token: string }
  | { type: "error" }
  | { type: "expired" }
  | { type: "interactive" };

/**
 * The page's postMessage string, or null for anything else. A WebView can
 * receive messages this file did not write (a frame, an extension), so the
 * shape is checked rather than trusted.
 */
export function parseTurnstileMessage(data: unknown): TurnstileMessage | null {
  if (typeof data !== "string") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: unknown; token?: unknown };
  if (m.type === "turnstile") {
    return typeof m.token === "string" && m.token.length > 0
      ? { type: "turnstile", token: m.token }
      : null;
  }
  if (m.type === "error") return { type: "error" };
  if (m.type === "expired") return { type: "expired" };
  if (m.type === "interactive") return { type: "interactive" };
  return null;
}

export type TurnstileGateState = "waiting" | "interactive" | "solved" | "failed";

export type TurnstileGateEvent = TurnstileMessage | { type: "timeout" } | { type: "retry" };

/**
 * The native gate's four states. `timeout` only lands while still waiting —
 * a token that arrived at 19 s is not undone by the timer at 20 s, and (Resub
 * C4, BUG-369) neither is a person who reached the checkbox at 5 s and is
 * still reading it at 20 s: `interactive` is not "waiting". `expired`
 * goes back to waiting: the widget re-solves on its own (refresh-expired is
 * "auto" by default) and the next token arrives as a fresh message.
 */
export function turnstileGateReducer(
  state: TurnstileGateState,
  event: TurnstileGateEvent,
): TurnstileGateState {
  switch (event.type) {
    case "turnstile":
      return "solved";
    case "error":
      return state === "solved" ? state : "failed";
    case "timeout":
      return state === "waiting" ? "failed" : state;
    case "expired":
    case "retry":
      return "waiting";
    case "interactive":
      // The checkbox is on screen in the visible gate: the load is done, so the
      // load's timeout no longer applies (BUG-369). A solved gate stays solved.
      return state === "waiting" ? "interactive" : state;
  }
}

/**
 * Which navigations the widget's WebView may make. Every sub-frame load is
 * Cloudflare's own challenge iframe and is allowed, as are `about:blank` and
 * `about:srcdoc` (Cloudflare's WebView requirement) and the page's own
 * baseUrl. A TOP-frame load anywhere else is a link inside the widget (its
 * Privacy / Terms) and would replace the widget with that page inside a
 * 70-point frame — so it is refused here and opened in the system browser by
 * the caller instead.
 */
export function turnstileAllowsNavigation(url: string, isTopFrame: boolean | undefined): boolean {
  if (isTopFrame === false) return true;
  if (url.startsWith("about:")) return true;
  if (url.startsWith(TURNSTILE_NATIVE_BASE_URL)) return true;
  return url.startsWith("https://challenges.cloudflare.com/");
}
