// Row 9 (1.1) · OAuth Block 2 Part D — Google Identity Services.
//
// §2.7 — "Google Identity Services (accounts.google.com/gsi/client,
// initialize + renderButton, the credential IS the id token)."
//
// That last clause is the whole reason this file is short. GIS hands back a
// `{ credential }` where `credential` is already the signed ID token — no
// exchange, no second round trip, and nothing for this client to verify. It
// goes straight to POST /auth/oauth/google as `idToken`.
//
// ── WHY NOT @react-native-google-signin ON WEB ───────────────────────────
//
// 🔴 Its web build is a STUB. `configure()` logs and `signIn()` throws:
// "RNGoogleSignIn: you are calling a not-implemented method on web platform.
// Web support is only available to sponsors." Read from
// lib/module/signIn/GoogleSignin.web.js, not inferred. GIS is not a
// workaround here, it is the supported web path.
//
// ── NO NONCE ─────────────────────────────────────────────────────────────
//
// GIS accepts one and the server does not check it (verify.ts says why in as
// many words: requiring a nonce Google treats as optional would refuse correct
// clients, and replay protection there rests on the short `exp` and on TLS).
// Sending one Kiwi does not verify would be decoration.

import { readOAuthClientConfig } from "./providers";
import { loadProviderScript } from "./webScripts";

const SCRIPT_ID = "google-gsi-client";
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

/** The subset of `google.accounts.id` this uses. */
interface GsiId {
  initialize: (opts: {
    client_id: string;
    callback: (res: { credential?: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_prompt?: boolean;
  }) => void;
  renderButton: (
    parent: unknown,
    opts: {
      type: "standard" | "icon";
      theme: "outline" | "filled_blue" | "filled_black";
      size: "small" | "medium" | "large";
      text: "signin_with" | "signup_with" | "continue_with" | "signin";
      shape: "rectangular" | "pill" | "circle" | "square";
      logo_alignment: "left" | "center";
      width?: number;
    },
  ) => void;
  disableAutoSelect: () => void;
}

function gsi(): GsiId | null {
  try {
    return (
      (globalThis as { google?: { accounts?: { id?: GsiId } } }).google?.accounts?.id ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Load the script and register the credential callback. Safe to call on every
 * mount: `initialize` is documented as replacing its own configuration, and
 * the callback closes over the current handler.
 */
export async function initGoogleWeb(
  onCredential: (idToken: string) => void,
  onEmpty: () => void,
): Promise<GsiId> {
  const cfg = readOAuthClientConfig();
  if (!cfg.googleWebClientId) {
    // providers.ts already refused to render the button.
    throw new Error("initGoogleWeb: EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is unset");
  }
  await loadProviderScript(SCRIPT_ID, SCRIPT_SRC);
  const api = gsi();
  if (!api) throw new Error("initGoogleWeb: gsi/client loaded but google.accounts.id is absent");

  api.initialize({
    client_id: cfg.googleWebClientId,
    callback: (res) => {
      const idToken = res?.credential;
      if (typeof idToken === "string" && idToken.length > 0) onCredential(idToken);
      // A callback with no credential is not a sign-in. It is reported
      // separately rather than swallowed, because the button looks like it
      // worked and the caller needs to stop its spinner.
      else onEmpty();
    },
    // No One Tap prompt from this block: the ruling asks for a BUTTON on the
    // two auth screens, and auto-selecting an account for someone who tapped
    // "Sign in" is a different product decision. `auto_select: false` is the
    // default and is stated because the opposite is a silent sign-in.
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  return api;
}

/**
 * Draw Google's own button into `parent` — §2.1's "its own rendered button on
 * web". `text: "continue_with"` is what makes it read "Continue with Google",
 * which the NATIVE button cannot be told to say.
 */
export function renderGoogleWebButton(api: GsiId, parent: unknown, width: number): void {
  api.renderButton(parent, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "left",
    // GIS clamps to [200, 400]; outside that it silently draws its default.
    width: Math.max(200, Math.min(400, Math.round(width))),
  });
}
