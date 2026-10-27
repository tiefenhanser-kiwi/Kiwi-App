// SERVER-6 A (ATTR) — WHERE EACH SIGNUP CAME FROM.
//
// `User.signupSource` names the door (test_kitchen / web / ios / android). This
// names the link that led to it: a creator's `ref`, the campaign's utm_* tags,
// and the page the visitor landed on. The client captures them on arrival and
// sends them once, as an optional `attribution` object, on every account-
// creating body (POST /auth/signup, POST /auth/oauth/google|apple — a Test
// Kitchen claim rides those same bodies).
//
// THE RULES, each a test in __tests__/signupAttribution.test.ts:
//   • Five keys and no others. Anything else on the object is DROPPED, never a
//     400: a sign-up must not fail over a tracking tag.
//   • Each value is a string, trimmed, control characters removed, cut to 120
//     characters. A non-string, or a string that is empty after that, is dropped.
//   • Nothing usable at all → null, so the column says "no link" rather than {}.
//   • WRITE-ONCE: only createAccountInTx writes it. An existing account signing
//     in with an attribution body changes nothing.
//
// The person's own answer ("How did you hear about Kiwi?") is a different fact
// and lives beside it: `howHeard` + `howHeardDetail`, set once through
// PATCH /me/profile (SIGNUP_HOW_HEARD below).

export const ATTRIBUTION_KEYS = ["ref", "utmSource", "utmMedium", "utmCampaign", "landingPath"] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
export type SignupAttribution = Partial<Record<AttributionKey, string>>;

export const ATTRIBUTION_VALUE_MAX = 120;

// C0 and C1 control characters, DEL included. A tag is a word, not a layout.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** The stored attribution for an account-creating body, or null when it carried nothing usable. */
export function sanitizeAttribution(raw: unknown): SignupAttribution | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: SignupAttribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const v = source[key];
    if (typeof v !== "string") continue;
    const clean = v.replace(CONTROL, "").trim().slice(0, ATTRIBUTION_VALUE_MAX).trim();
    if (clean.length > 0) out[key] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** "How did you hear about Kiwi?" — the fixed list PATCH /me/profile accepts. */
export const SIGNUP_HOW_HEARD = [
  "friend",
  "instagram",
  "tiktok",
  "reddit",
  "google",
  "app_store",
  "creator",
  "other",
] as const;
export type SignupHowHeard = (typeof SIGNUP_HOW_HEARD)[number];

export const HOW_HEARD_DETAIL_MAX = 80;

/** The signup alert's "Came from" line: the link's facts, or null when there was no link. */
export function cameFromLine(attribution: unknown): string | null {
  const a = sanitizeAttribution(attribution);
  if (!a) return null;
  const parts: string[] = [];
  if (a.ref) parts.push(`ref ${a.ref}`);
  const utm = [a.utmSource, a.utmMedium, a.utmCampaign].filter((v): v is string => Boolean(v));
  if (utm.length > 0) parts.push(`utm ${[a.utmSource ?? "-", a.utmMedium ?? "-", a.utmCampaign ?? "-"].join(" / ")}`);
  if (a.landingPath) parts.push(`landed on ${a.landingPath}`);
  return parts.join(" · ");
}
