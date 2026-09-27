// Row 9 (1.1) · OAuth Block 2 Part B — THE TWO BODIES, and what separates
// them.
//
// The server's schemas are OAUTH_SHARED_FIELDS plus one credential each
// (artifacts/api-server/src/routes/auth.ts). Everything a password SIGN-UP may
// send rides the OAuth wire too, for the reason that route states in as many
// words: an OAuth sign-in that turns out to be a first sign-in IS a sign-up.
//
// ── THE SIGN-UP / SIGN-IN DIFFERENCE IS EXACTLY THREE FIELDS ─────────────
//
// §2.4 — "from the SIGN-UP screen, send the consent checkboxes' current values
// … and the phone if entered; from the SIGN-IN screen send none."
//
//   signup only:  phone, marketingConsentEmail, marketingConsentSms
//   both:         firstName, lastName, timezone, platform, the guest claim
//
// The consents are the whole point of the split. Unchecked by default is an
// explicit opt-in (CAN-SPAM / TCPA, PRD §3.3), and the sign-IN screen has no
// checkboxes — so sending `false` from there would be this client ASSERTING a
// withdrawal the user never made. The server ignores consents for an existing
// user, but it does not ignore them for a first sign-in, and a first sign-in
// can start on either screen. Absent is the only honest value.
//
// 🔴 NAMES RIDE BOTH MODES, and that is not a hole in §2.4. Apple hands the
// user's name to the client on the FIRST authorisation and never again. Tap
// "Continue with Apple" on the sign-IN screen having never used Kiwi, and that
// tap is the only moment the name exists anywhere. Dropping it because the
// screen is titled "Sign in" would create a nameless account and no later
// request could repair it. §2.4's "send none" is scoped to the consents and
// the phone — fields the sign-in screen does not collect at all.
//
// Timezone and platform ride both for the same reason and a weaker one: they
// are facts about the device, not claims about the person, and the server
// applies them on CREATE only.

import type { AppPlatform } from "./providers";

export type OAuthMode = "signup" | "signin";

/** The Test Kitchen claim, read from the guest store by the completion path. */
export interface OAuthClaimFields {
  guestSessionId?: string;
  localDate?: string;
}

/** What the sign-up screen alone contributes. */
export interface OAuthConsentFields {
  /** Already trimmed; empty means "no phone" and must arrive as undefined. */
  phone?: string;
  marketingConsentEmail?: boolean;
  marketingConsentSms?: boolean;
}

export interface OAuthContext {
  mode: OAuthMode;
  platform: AppPlatform;
  /** `Intl…timeZone`, or undefined when Intl failed (server default applies). */
  timezone?: string;
  /** Apple's first-authorisation payload. Google's name comes from the token. */
  firstName?: string | null;
  lastName?: string | null;
  /** Ignored unless `mode === "signup"`. */
  consents?: OAuthConsentFields;
  claim?: OAuthClaimFields;
}

export interface OAuthSharedBody {
  firstName?: string;
  lastName?: string;
  timezone?: string;
  phone?: string;
  marketingConsentEmail?: boolean;
  marketingConsentSms?: boolean;
  platform: AppPlatform;
  guestSessionId?: string;
  localDate?: string;
}

export interface AppleOAuthBody extends OAuthSharedBody {
  identityToken: string;
  /** The PRE-HASH value. See ./nonce.ts — a base64 digest 401s a valid token. */
  rawNonce: string;
  authorizationCode?: string;
}

export interface GoogleOAuthBody extends OAuthSharedBody {
  idToken: string;
}

function clean(s: string | null | undefined): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Built by ASSIGNMENT rather than as one object literal with spreads, so that
 * an omitted field is an absent KEY and not `{ phone: undefined }`. Zod treats
 * both as absent, but `JSON.stringify` drops the second silently and the wire
 * log then shows a body that does not match the code — which is how a "we do
 * send it" argument survives a bug for a week.
 */
export function oauthSharedBody(ctx: OAuthContext): OAuthSharedBody {
  const body: OAuthSharedBody = { platform: ctx.platform };

  const firstName = clean(ctx.firstName);
  if (firstName) body.firstName = firstName;
  const lastName = clean(ctx.lastName);
  if (lastName) body.lastName = lastName;
  const timezone = clean(ctx.timezone);
  if (timezone) body.timezone = timezone;

  if (ctx.mode === "signup" && ctx.consents) {
    const phone = clean(ctx.consents.phone);
    if (phone) body.phone = phone;
    if (ctx.consents.marketingConsentEmail !== undefined) {
      body.marketingConsentEmail = ctx.consents.marketingConsentEmail;
    }
    // The server answers 400 for SMS consent without a phone, and the form
    // already clears the box when the field empties. This is the wire-level
    // guarantee, and it mirrors AuthContext.signup's `phone ? … : undefined`
    // exactly — one rule, two callers, deliberately the same shape.
    if (phone && ctx.consents.marketingConsentSms !== undefined) {
      body.marketingConsentSms = ctx.consents.marketingConsentSms;
    }
  }

  if (ctx.claim?.guestSessionId) {
    body.guestSessionId = ctx.claim.guestSessionId;
    const localDate = clean(ctx.claim.localDate);
    if (localDate) body.localDate = localDate;
  }

  return body;
}

export interface AppleCredential {
  identityToken: string;
  /** The raw value — NEVER the one handed to Apple. */
  rawNonce: string;
  /**
   * Optional, and its absence never blocks a sign-in: it is what the server
   * exchanges for the refresh token DELETE /me revokes (App Review 5.1.1(v)).
   * Apple's web JS flow does not return one, so on web this is always absent.
   */
  authorizationCode?: string | null;
}

export function appleRequestBody(
  credential: AppleCredential,
  ctx: OAuthContext,
): AppleOAuthBody {
  const body: AppleOAuthBody = {
    identityToken: credential.identityToken,
    rawNonce: credential.rawNonce,
    ...oauthSharedBody(ctx),
  };
  const code = clean(credential.authorizationCode);
  if (code) body.authorizationCode = code;
  return body;
}

export function googleRequestBody(
  credential: { idToken: string },
  ctx: OAuthContext,
): GoogleOAuthBody {
  return { idToken: credential.idToken, ...oauthSharedBody(ctx) };
}
