// LIFE-1 — the signed one-click unsubscribe link.
//
// The token is `<userId>.<sig>`, sig = base64url(HMAC-SHA256(key, label + userId)).
// It never expires and is not single-use: an unsubscribe link must keep working
// for as long as the email it came in exists, and clicking it twice is
// harmless (the opt-out is write-if-null).
//
// THE KEY is derived from JWT_SECRET under a fixed label rather than being a
// new Secret Manager entry: production already has JWT_SECRET, so this ships
// with no secret to push. The label separates the domains — an unsubscribe
// signature is not a session signature and cannot be used as one. The cost:
// rotating JWT_SECRET invalidates every unsubscribe link already sent (those
// people would see "Link not valid" and could still reply to opt out).
//
// Read LAZILY, per call (the sendEmail.ts rule), and an absent JWT_SECRET
// yields no token at all — the runner then refuses to send any email that
// needs one, because a commercial email without a working unsubscribe is the
// thing CAN-SPAM forbids.

import { createHmac, timingSafeEqual } from "node:crypto";

const KEY_LABEL = "kiwi-lifecycle-unsubscribe-key:v1";
const SIG_LABEL = "unsubscribe:";

/** The page the visible link opens (routes/pages.ts). It POSTs to UNSUBSCRIBE_API_PATH on load. */
export const UNSUBSCRIBE_PAGE_PATH = "/email/unsubscribe";
/** The API route: the page's POST, and the RFC 8058 List-Unsubscribe-Post target. Mounted under /api. */
export const UNSUBSCRIBE_API_PATH = "/email/unsubscribe";

function keyFrom(env: NodeJS.ProcessEnv): Buffer | null {
  const secret = env["JWT_SECRET"]?.trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

function sign(key: Buffer, userId: string): string {
  return createHmac("sha256", key).update(SIG_LABEL + userId).digest("base64url");
}

export function makeUnsubscribeToken(userId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = keyFrom(env);
  if (!key) return null;
  return `${userId}.${sign(key, userId)}`;
}

/** The userId the token was signed for, or null for anything else. */
export function verifyUnsubscribeToken(
  token: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const key = keyFrom(env);
  if (!key) return null;
  const want = Buffer.from(sign(key, userId));
  const got = Buffer.from(given);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return userId;
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  return (env["PUBLIC_APP_URL"] ?? "").trim().replace(/\/+$/, "");
}

/**
 * The two unsubscribe URLs for one account, or null when either half is
 * missing (no JWT_SECRET, no PUBLIC_APP_URL).
 *   page — the visible footer link; a browser page that opts out on load
 *   post — the List-Unsubscribe header target, for one-click in Gmail/Yahoo
 */
export function unsubscribeUrls(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): { page: string; post: string } | null {
  const token = makeUnsubscribeToken(userId, env);
  const base = baseUrl(env);
  if (!token || !base) return null;
  const q = `?token=${encodeURIComponent(token)}`;
  return {
    page: `${base}${UNSUBSCRIBE_PAGE_PATH}${q}`,
    post: `${base}/api${UNSUBSCRIBE_API_PATH}${q}`,
  };
}
