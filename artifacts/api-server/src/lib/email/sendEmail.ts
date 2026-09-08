// BUG-224 — the email seam. Until this file existed the server had NO provider
// of any kind: both mail-bearing flows minted a token, logged it, and returned
// success. `fa1859c` stopped the logging (BUG-219); this restores the purpose.
//
// SHAPE, and it is deliberately the one runAICall already proved:
//
//   • The client config is read LAZILY, not captured at import, so a missing
//     key cannot blow up module load (runAICall.ts:112-120).
//   • A missing key resolves to a TYPED no-op — { sent: false, reason:
//     "no_api_key" } — exactly as runAICall returns reason "no_api_key". The
//     caller logs and returns its normal response. For the two flows wired to
//     this, that normal response is the anti-enumeration `{ success: true }`
//     they already returned, so behaviour with no key is identical to today's.
//   • KEY PRESENCE IS THE GATE, NOT `NODE_ENV`. A NODE_ENV check would be
//     wrong: bug219LogFixture.ts runs with NODE_ENV=production on purpose, and
//     a Neon-branch smoke run would too. Test environments have no key, so
//     they cannot send; that is the whole mechanism.
//
// NO SDK, ON PURPOSE — see the note above sendViaResend().

import { logger } from "../logger";

export interface EmailMessage {
  /** Single recipient. Nothing here needs multi-recipient, so nothing takes it. */
  to: string;
  subject: string;
  /** Plain text only. Rich HTML stays deferred by D-WS7-022. */
  text: string;
}

export type SendResult =
  | { sent: true; id: string }
  | { sent: false; reason: "no_api_key" }
  | { sent: false; reason: "missing_config" }
  | { sent: false; reason: "send_failed"; status?: number };

export type EmailSender = (msg: EmailMessage) => Promise<SendResult>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

function readEnv(key: string): string {
  const raw = process.env[key];
  return raw && raw.trim() !== "" ? raw.trim() : "";
}

function apiKey(): string {
  return readEnv("RESEND_API_KEY");
}

function fromAddress(): string {
  return readEnv("EMAIL_FROM");
}

function publicAppUrl(): string {
  return readEnv("PUBLIC_APP_URL").replace(/\/+$/, "");
}

// ── Boot-time contract ──────────────────────────────────────────────────
//
// A key WITHOUT a link host would send real mail carrying a link to nowhere —
// on the one message whose entire job is to rescue a locked-out account. That
// is worse than not sending, so the process refuses to start.
//
// ⚠️ CALLED FROM index.ts, NOT AT MODULE LOAD, AND THE DIFFERENCE IS LOAD-
// BEARING. This module is imported by auth.ts and me.ts, so a module-load
// throw would take down every test that touches either router — measured, it
// took down the whole 1,900-test suite the moment RESEND_API_KEY appeared in
// .env without its two companions. Mail config is not a precondition for
// unit-testing an unrelated route. index.ts IS the boot path and already
// validates PORT there; this sits beside it.
//
// The send path guards itself independently (see sendViaResend), so the
// "never send a link to nowhere" guarantee does not depend on this running.
export function assertMailEnvComplete(): void {
  if (!apiKey()) return;
  const missing: string[] = [];
  if (!fromAddress()) missing.push("EMAIL_FROM");
  if (!publicAppUrl()) missing.push("PUBLIC_APP_URL");
  if (missing.length === 0) return;
  const plural = missing.length > 1;
  throw new Error(
    `RESEND_API_KEY is set but ${missing.join(" and ")} ${plural ? "are" : "is"} not. ` +
      `Mail cannot be sent without ${plural ? "them" : "it"} — see .env.example.`,
  );
}

/**
 * Build the link a mail-bearing flow puts in front of a user.
 *
 * 🔴 THE SCHEME IS AN OPEN DECISION — D-WS9-231, status OPEN as of the
 * 2026-09-08 01:32Z canon mirror, which records three options and says in
 * terms: "CHAT-CLAUDE'S READ, NOT A RULING … Hans decides".
 *
 * This mints the `https://` shape, which is what BOTH live options produce:
 * option 1 (universal / app links) and option 2 (an https page that hands off
 * to the app) are identical from the server's side and differ only in what is
 * hosted at the other end. Option 3 (keep `kiwi://`) is the only one that
 * would change this function, and D-WS9-231 calls it "indefensible at launch".
 *
 * ⚠️ IF HANS RULES OPTION 3, THIS FUNCTION IS THE ONLY EDIT. That is why the
 * scheme lives here rather than inlined at the two call sites.
 */
export function buildAppLink(path: string, token: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${publicAppUrl()}${clean}?token=${encodeURIComponent(token)}`;
}

// ── The provider call ───────────────────────────────────────────────────
//
// A thin `fetch` against Resend's HTTP API rather than the `resend` npm SDK,
// and the reasoning is the repo's own:
//
//   1. pnpm-workspace.yaml carries a minimumReleaseAge supply-chain policy in
//      the strongest terms in this codebase ("DO NOT DISABLE THIS SETTING").
//      Adding a dependency is the thing that policy exists to make expensive,
//      and this one buys a single POST.
//   2. Node has global fetch, and the repo already uses exactly this shape —
//      fetch plus an AbortController deadline — in recipeImport.ts and
//      usda/fdcClient.ts.
//   3. No lockfile churn, which matters for a change landing unattended.
//
// If a later message needs attachments, batching or webhooks, revisit.
async function sendViaResend(msg: EmailMessage): Promise<SendResult> {
  const key = apiKey();
  if (!key) return { sent: false, reason: "no_api_key" };

  // Independent of assertMailEnvComplete(), so a caller that never ran the
  // boot check still cannot put a link to nowhere in front of a locked-out
  // user. Refusing to send is strictly better than sending a broken link.
  if (!fromAddress() || !publicAppUrl()) {
    logger.warn(
      {
        event: "email_send_skipped",
        missingFrom: !fromAddress(),
        missingAppUrl: !publicAppUrl(),
      },
      "RESEND_API_KEY is set but EMAIL_FROM/PUBLIC_APP_URL are not — refusing to send",
    );
    return { sent: false, reason: "missing_config" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // NOTHING identifying goes in this log — not the recipient (an address is
      // PII in a retained sink, per Hans's ruling that took `newEmail` out of
      // the email-change lines), and not the body, which carries the link and
      // therefore the token.
      logger.warn(
        { event: "email_send_failed", status: res.status },
        "Email provider rejected the send",
      );
      return { sent: false, reason: "send_failed", status: res.status };
    }

    const body = (await res.json()) as { id?: string };
    return { sent: true, id: body.id ?? "" };
  } catch (err) {
    logger.warn(
      { event: "email_send_failed", err },
      "Email send threw or timed out",
    );
    return { sent: false, reason: "send_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** Production sender. Routes take this via DI so tests can record instead. */
export const sendEmail: EmailSender = sendViaResend;

// ── Message bodies ──────────────────────────────────────────────────────
// Plain text, per D-WS7-022 ("Plain-text first; rich HTML deferred").

export function passwordResetMessage(to: string, link: string): EmailMessage {
  return {
    to,
    subject: "Reset your Kiwi password",
    text: [
      "Someone asked to reset the password for this Kiwi account.",
      "",
      "Open this link to choose a new one:",
      link,
      "",
      "The link expires in 1 hour.",
      "If this wasn't you, you can ignore this email — your password stays as it is.",
    ].join("\n"),
  };
}

export function emailChangeMessage(to: string, link: string): EmailMessage {
  return {
    to,
    subject: "Confirm your new Kiwi email address",
    text: [
      "Someone asked to change the email address on a Kiwi account to this one.",
      "",
      "Open this link to confirm it:",
      link,
      "",
      "The link expires in 1 hour.",
      "If this wasn't you, you can ignore this email — nothing changes.",
    ].join("\n"),
  };
}
