// Row 9 (1.1) · OAuth Block 1 Part A — the environment contract for
// "Continue with Apple" and "Continue with Google".
//
// ── THE POSTURE, WHICH IS THIS SERVER'S POSTURE EVERYWHERE ───────────────
//
// An unset feature variable means the feature is OFF and SAYS SO. Turnstile
// (D-WS9-262), Instacart (Row 8) and the spend guard (BUG-263) all work this
// way, and this is the same shape: no audience configured for a provider →
// `POST /auth/oauth/<provider>` answers 503 `oauth_unavailable`, and ONE line
// at boot names the state so the real posture is on the first page of every
// revision's logs rather than inferred from silence.
//
// ⚠️ THE AUDIENCE LIST IS THE ON/OFF SWITCH, and it has to be the one that is:
// it is the only variable a provider cannot work without. Apple's signing key
// trio (TEAM_ID / KEY_ID / PRIVATE_KEY) governs only the REVOCATION half
// (§2.6), which is best-effort by ruling — so Apple sign-in must still work
// with the trio unset, loudly, rather than 503 because a key file is missing.
// The boot line says which half is live.
//
// 🔴 NOTHING IN THIS FILE EVER LOGS A VALUE. `APPLE_PRIVATE_KEY` is a live
// signing key and `APPLE_REFRESH_TOKEN_ENC_KEY` decrypts every stored Apple
// refresh token; the audiences and client ids are not secret but are logged as
// COUNTS anyway, because a client id in a log line is a needless fingerprint
// of the deploy. BUG-219's rule — a credential does not go in a log sink — is
// what this paragraph exists to keep. The tests assert it (`da8969b`'s "no env
// leakage" pattern, extended to the two new secrets).

import { logger } from "../logger";

export const ENV_APPLE_OAUTH_AUDIENCES = "APPLE_OAUTH_AUDIENCES";
export const ENV_GOOGLE_OAUTH_CLIENT_IDS = "GOOGLE_OAUTH_CLIENT_IDS";
export const ENV_APPLE_TEAM_ID = "APPLE_TEAM_ID";
export const ENV_APPLE_KEY_ID = "APPLE_KEY_ID";
export const ENV_APPLE_PRIVATE_KEY = "APPLE_PRIVATE_KEY";
export const ENV_APPLE_REFRESH_TOKEN_ENC_KEY = "APPLE_REFRESH_TOKEN_ENC_KEY";

/**
 * "a, b ,,c" → ["a","b","c"]. Unset or blank → [] — which is the OFF state,
 * not a permissive one. Case is PRESERVED: an Apple bundle id and a Google
 * client id are compared byte-for-byte against the token's `aud`, and
 * lower-casing them would make a mixed-case bundle id silently unverifiable.
 * (This is the one thing it does differently from `parseEmailAllowlist` in
 * lib/googleOidc.ts, whose values are email addresses — hence a sibling
 * function rather than a reuse.)
 */
export function parseAudienceList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The Apple `.p8` key, as it arrives from Secret Manager.
 *
 * ⚠️ `\n` UNESCAPED. A PEM is multi-line and a great many deploy paths (a
 * `--set-env-vars` flag, a .env file, a CI variable box) can only carry one
 * line, so the value reaches us with literal backslash-n. `createSign` refuses
 * such a string with a completely uninformative error. Both forms are accepted
 * here; the value is never logged either way.
 */
export function normalizePrivateKey(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export interface AppleSigningConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
}

export interface OAuthConfig {
  /** Accepted `aud` values for an Apple identity token. Empty = Apple is OFF. */
  appleAudiences: string[];
  /** Accepted `aud` values for a Google ID token. Empty = Google is OFF. */
  googleClientIds: string[];
  /** All three of the trio, or null. Governs code exchange + revocation only. */
  appleSigning: AppleSigningConfig | null;
  /** The secret the refresh-token encryption key is derived from, or null. */
  appleRefreshEncSecret: string | null;
}

export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const teamId = readSecret(env, ENV_APPLE_TEAM_ID);
  const keyId = readSecret(env, ENV_APPLE_KEY_ID);
  const privateKey = normalizePrivateKey(readSecret(env, ENV_APPLE_PRIVATE_KEY));
  return {
    appleAudiences: parseAudienceList(env[ENV_APPLE_OAUTH_AUDIENCES]),
    googleClientIds: parseAudienceList(env[ENV_GOOGLE_OAUTH_CLIENT_IDS]),
    // ALL THREE or nothing. Two of three is a half-configured deploy, and
    // signing with a key whose `kid` header is missing produces an Apple
    // rejection that reads like a bad key rather than a missing variable.
    appleSigning: teamId && keyId && privateKey ? { teamId, keyId, privateKey } : null,
    appleRefreshEncSecret: readSecret(env, ENV_APPLE_REFRESH_TOKEN_ENC_KEY),
  };
}

/** Which of the trio are missing — for the boot line. NAMES, never values. */
export function missingAppleSigningVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return [ENV_APPLE_TEAM_ID, ENV_APPLE_KEY_ID, ENV_APPLE_PRIVATE_KEY].filter(
    (n) => readSecret(env, n) === null,
  );
}

interface BootLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * BUG-263's rule, applied to this feature: every variable that is SET is
 * validated at boot, and the effective state is one line. Called once from
 * app.ts beside `validateSpendGuardEnv` and `logTurnstileConfig`.
 *
 * Nothing here can stop the server booting. A missing OAuth variable must not
 * take down an API whose password lane is fine — the route answers 503 and the
 * log says why.
 */
export function logOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: BootLogger = logger,
): OAuthConfig {
  const config = readOAuthConfig(env);

  const appleOn = config.appleAudiences.length > 0;
  const googleOn = config.googleClientIds.length > 0;

  if (!appleOn) {
    log.warn(
      { event: "oauth_provider_disabled", provider: "apple", vars: [ENV_APPLE_OAUTH_AUDIENCES] },
      `OAuth apple: NOT configured (${ENV_APPLE_OAUTH_AUDIENCES} unset) — POST /auth/oauth/apple answers 503`,
    );
  }
  if (!googleOn) {
    log.warn(
      { event: "oauth_provider_disabled", provider: "google", vars: [ENV_GOOGLE_OAUTH_CLIENT_IDS] },
      `OAuth google: NOT configured (${ENV_GOOGLE_OAUTH_CLIENT_IDS} unset) — POST /auth/oauth/google answers 503`,
    );
  }

  // 🔴 App Review 5.1.1(v) is the reason this is an ERROR and not a warning
  // when Apple is on: an app that offers Sign in with Apple and cannot revoke
  // the token on account deletion is REJECTABLE. The route still works — the
  // revocation is best-effort by ruling — but a deploy in this state is a
  // shipping problem, and it should read like one.
  const missingTrio = missingAppleSigningVars(env);
  if (appleOn && config.appleSigning === null) {
    log.error(
      { event: "oauth_apple_revocation_unavailable", vars: missingTrio },
      `OAuth apple: sign-in is ON but token REVOCATION is unavailable (${missingTrio.join(", ")} unset) — DELETE /me cannot call Apple, which App Review guideline 5.1.1(v) requires`,
    );
  }
  if (appleOn && config.appleSigning !== null && config.appleRefreshEncSecret === null) {
    log.error(
      { event: "oauth_apple_refresh_storage_unavailable", vars: [ENV_APPLE_REFRESH_TOKEN_ENC_KEY] },
      `OAuth apple: ${ENV_APPLE_REFRESH_TOKEN_ENC_KEY} unset — the Apple refresh token cannot be stored encrypted, so it is NOT stored and DELETE /me has nothing to revoke`,
    );
  }

  log.info(
    {
      event: "oauth_config",
      apple: appleOn ? "configured" : "disabled",
      // COUNTS, not the ids themselves — see this file's header.
      appleAudienceCount: config.appleAudiences.length,
      google: googleOn ? "configured" : "disabled",
      googleClientIdCount: config.googleClientIds.length,
      appleRevocation:
        config.appleSigning && config.appleRefreshEncSecret ? "configured" : "disabled",
      missingAppleSigningVars: missingTrio,
    },
    `OAuth: apple ${appleOn ? "on" : "off"} · google ${googleOn ? "on" : "off"} · apple revocation ${
      config.appleSigning && config.appleRefreshEncSecret ? "on" : "off"
    }`,
  );

  return config;
}
