// D-WS9-231 — the two web fallback pages, served at the ROOT of the host
// (NOT under /api): PUBLIC_APP_URL + "/reset-password?token=…" and
// "/verify-email?token=…" are the exact links sendEmail.ts::buildAppLink
// mints, so this router is what makes those links resolve.
//
// Deliberately mounted in app.ts OUTSIDE the /api router: no auth middleware
// (the emailed token is the credential, and it is spent by the POST the page
// makes — /api/auth/password-reset/confirm and /api/me/email/verify-change,
// which keep their own limiters), and no API rate limiter on a GET that
// renders static markup.
//
// `Cache-Control: no-store` for the same reason as BUG-104: a page whose URL
// carries a one-time token must never be replayed out of a shared cache.

import { createHash } from "node:crypto";

import { Router, type IRouter } from "express";

import { RESET_PASSWORD_PATH, resetPasswordHtml } from "../pages/resetPassword";
import { UNSUBSCRIBE_PAGE_PATH, unsubscribeHtml } from "../pages/unsubscribe";
import { VERIFY_EMAIL_PATH, verifyEmailHtml } from "../pages/verifyEmail";

/**
 * SEC-2 #9 — each page's own CSP. app.ts sends `default-src 'none'` on every
 * response; a page needs exactly its one inline <style>, its one inline
 * <script>, and a same-origin fetch to the API — so it gets those, pinned by
 * SHA-256 of the exact bytes it ships, and nothing else. No 'unsafe-inline':
 * an injected script (the pages put a token from the URL into the DOM) would
 * not match a hash. The hashes are computed from the strings at load, so they
 * cannot drift from the markup.
 */
export function pageCsp(html: string): string {
  const hashes = (tag: "script" | "style") =>
    [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
      .map((m) => `'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`)
      .join(" ");
  return [
    "default-src 'none'",
    `script-src ${hashes("script") || "'none'"}`,
    `style-src ${hashes("style") || "'none'"}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function createPagesRouter(): IRouter {
  const router: IRouter = Router();
  const csp = {
    reset: pageCsp(resetPasswordHtml),
    verify: pageCsp(verifyEmailHtml),
    unsubscribe: pageCsp(unsubscribeHtml),
  };

  router.get(RESET_PASSWORD_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", csp.reset);
    res.type("html").send(resetPasswordHtml);
  });

  router.get(VERIFY_EMAIL_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", csp.verify);
    res.type("html").send(verifyEmailHtml);
  });

  // LIFE-1 — the lifecycle emails' footer link. Opts out from the page's own
  // POST, never from this GET (pages/unsubscribe.ts says why).
  router.get(UNSUBSCRIBE_PAGE_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", csp.unsubscribe);
    res.type("html").send(unsubscribeHtml);
  });

  return router;
}

const pagesRouter: IRouter = createPagesRouter();
export default pagesRouter;
