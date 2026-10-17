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

import { Router, type IRouter } from "express";

import { RESET_PASSWORD_PATH, resetPasswordHtml } from "../pages/resetPassword";
import { UNSUBSCRIBE_PAGE_PATH, unsubscribeHtml } from "../pages/unsubscribe";
import { VERIFY_EMAIL_PATH, verifyEmailHtml } from "../pages/verifyEmail";

export function createPagesRouter(): IRouter {
  const router: IRouter = Router();

  router.get(RESET_PASSWORD_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(resetPasswordHtml);
  });

  router.get(VERIFY_EMAIL_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(verifyEmailHtml);
  });

  // LIFE-1 — the lifecycle emails' footer link. Opts out from the page's own
  // POST, never from this GET (pages/unsubscribe.ts says why).
  router.get(UNSUBSCRIBE_PAGE_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(unsubscribeHtml);
  });

  return router;
}

const pagesRouter: IRouter = createPagesRouter();
export default pagesRouter;
