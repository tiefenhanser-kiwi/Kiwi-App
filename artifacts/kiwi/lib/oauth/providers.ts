// Row 9 (1.1) · OAuth Block 2 Part B — WHICH BUTTONS EXIST, and why that is a
// pure function of env plus one runtime fact.
//
// ── THE TWO RULINGS THIS FILE IS ─────────────────────────────────────────
//
// §2.2 — iOS = Apple + Google · Android = Google · web = Apple + Google.
//   Apple's App Store guideline requires Sign in with Apple only on Apple
//   platforms; an Apple web flow bolted onto Android is not in 1.1.
//
// §2.3 — "A button renders only when its client config exists (env,
//   EXPO_PUBLIC_*): unset → the button is absent, the email form is
//   unchanged." So the app builds, tests and ships before Hans finishes the
//   Apple and Google console work, and the screens do not sprout a button
//   that can only fail.
//
// ── ONE DIVERGENCE FROM §2.3'S LETTER, STATED RATHER THAN HIDDEN ─────────
//
// 🔴 APPLE ON iOS IS NOT ENV-GATED, because it has no env to gate on. The
// native flow's "client id" is the bundle identifier, and its configuration
// is the `com.apple.developer.applesignin` entitlement — compiled into the
// binary by the config plugin, not read at runtime. §2.8's own variable list
// says the same thing by omission: it names EXPO_PUBLIC_APPLE_SERVICES_ID and
// EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI, both web-only, and no iOS pair.
//
// The equivalent runtime check is `AppleAuthentication.isAvailableAsync()`,
// which answers false on a device below iOS 13 and on a build without the
// entitlement. That is a promise, so it cannot live in a pure function; it
// arrives here as `facts.appleNativeAvailable` and the screen owns the await.

export type AppPlatform = "ios" | "android" | "web";
export type OAuthProvider = "apple" | "google";

/** The four client-side values, each already trimmed and never `""`. */
export interface OAuthClientConfig {
  /** Apple WEB only: the Services ID, which is the `client_id` of the JS flow. */
  appleServicesId: string | null;
  /** Apple WEB only: must match a Return URL registered on that Services ID. */
  appleWebRedirectUri: string | null;
  /**
   * The WEB client id, on every platform. Native Google signs in with the
   * platform client but mints the ID TOKEN for this audience — which is why
   * Android needs it even though Android's own OAuth client exists solely so
   * Google will accept the package name + SHA-1.
   */
  googleWebClientId: string | null;
  /** iOS only: the iOS OAuth client id GoogleSignin.configure() needs. */
  googleIosClientId: string | null;
}

function read(env: Record<string, string | undefined>, key: string): string | null {
  const v = env[key];
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Read through a FUNCTION, not a module const — the same shape
 * lib/guest/turnstile.ts uses and for the same reason: Expo inlines
 * `process.env.EXPO_PUBLIC_*` at build time, so the value is fixed per build,
 * but the decisions below stay testable in both directions without a
 * re-import.
 */
export function readOAuthClientConfig(
  env: Record<string, string | undefined> = process.env,
): OAuthClientConfig {
  return {
    appleServicesId: read(env, "EXPO_PUBLIC_APPLE_SERVICES_ID"),
    appleWebRedirectUri: read(env, "EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI"),
    googleWebClientId: read(env, "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID"),
    googleIosClientId: read(env, "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"),
  };
}

/**
 * Apple's JS flow needs BOTH halves. A Services ID with no redirect URI is
 * not a partial configuration that could still work — `appleid.auth.init`
 * requires `redirectURI`, and Apple refuses any value not registered on that
 * Services ID, so half a pair is a guaranteed failure wearing a button.
 */
export function appleWebConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const cfg = readOAuthClientConfig(env);
  return cfg.appleServicesId !== null && cfg.appleWebRedirectUri !== null;
}

/**
 * Google, per platform.
 *
 * web / android — the web client id alone. Android's id token is minted for
 *   the web audience (the server's `googleClientIds` list is what it is
 *   checked against), and the Android OAuth client is never named in code.
 * ios — both. `GoogleSignin.configure({ webClientId, iosClientId })` needs
 *   the iOS client to run the native flow and the web client to choose the
 *   token's audience; with only one of them the sign-in either cannot start
 *   or comes back with a token the server will refuse.
 */
export function googleConfigured(
  platform: AppPlatform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const cfg = readOAuthClientConfig(env);
  if (cfg.googleWebClientId === null) return false;
  if (platform === "ios") return cfg.googleIosClientId !== null;
  return true;
}

/** What the screens read. Both halves default to hidden. */
export interface ProviderButtons {
  apple: boolean;
  google: boolean;
}

export interface ProviderFacts {
  /**
   * `AppleAuthentication.isAvailableAsync()`. Only consulted on iOS; false
   * while the screen is still awaiting it, so a button never flashes in and
   * out during the first frame.
   */
  appleNativeAvailable: boolean;
  /**
   * §2.6 — a provider that answered 503 `oauth_unavailable` is hidden FOR THE
   * SESSION. Passed in rather than read from a module-level set so this stays
   * a pure function; the set itself is ./unavailable.ts.
   */
  hidden?: ReadonlyArray<OAuthProvider>;
}

export function providerButtons(
  platform: AppPlatform,
  facts: ProviderFacts,
  env: Record<string, string | undefined> = process.env,
): ProviderButtons {
  const hidden = facts.hidden ?? [];
  const apple =
    platform === "ios"
      ? facts.appleNativeAvailable
      : platform === "web"
        ? appleWebConfigured(env)
        : // Android. §2.2 — not a configuration question, a ruling.
          false;
  return {
    apple: apple && !hidden.includes("apple"),
    google: googleConfigured(platform, env) && !hidden.includes("google"),
  };
}

/**
 * True when the "or" divider and the social block should render at all. With
 * neither button configured the screens must look exactly as they did before
 * this block — not a stranded divider over an empty row (§2.3).
 */
export function anyProviderVisible(buttons: ProviderButtons): boolean {
  return buttons.apple || buttons.google;
}
