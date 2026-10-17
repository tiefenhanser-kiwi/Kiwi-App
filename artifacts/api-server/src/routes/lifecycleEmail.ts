// LIFE-1 — POST /api/email/unsubscribe: the one-click lifecycle opt-out.
//
// UNAUTHENTICATED BY DESIGN: the signed token (lib/lifecycle/unsubscribe.ts)
// is the credential, exactly as the reset link's token is. Two callers:
//
//   • the web page at GET /email/unsubscribe (routes/pages.ts), which POSTs
//     `{ token }` as JSON on load — the visible link in every footer;
//   • a mail client honouring RFC 8058 (Gmail, Yahoo, Apple Mail), which POSTs
//     `List-Unsubscribe=One-Click` as a form body to the URL in the
//     List-Unsubscribe header, with the token in the query string.
//
// So the token is read from the JSON body first, then the query.
//
// WHY THE VISIBLE LINK IS A PAGE THAT POSTS, NOT A GET THAT WRITES: mail
// security scanners (Outlook Safe Links, corporate gateways) fetch every link
// in a message before the person sees it. A GET that opted out would
// unsubscribe people who never clicked. A scanner fetches the page's HTML and
// stops; a person's browser runs the script and opts out — still one click.
//
// IDEMPOTENT AND QUIET: write-if-null, so the first opt-out time is kept; an
// account deleted since the email was sent answers the same 200 (there is
// nothing left to email, and the answer should not say whether it existed).

import type { PrismaClient } from "@prisma/client";
import { Router, type IRouter } from "express";

import { UNSUBSCRIBE_API_PATH, verifyUnsubscribeToken } from "../lib/lifecycle/unsubscribe";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";

export interface LifecycleEmailRouterDeps {
  prisma: Pick<PrismaClient, "user">;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

// Per IP: a person clicks once; a mail client posts once per message.
const unsubscribeLimiter = rateLimit({ capacity: 20, refillPerSec: 20 / 60 });

export function createLifecycleEmailRouter(
  deps: Partial<LifecycleEmailRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const router: IRouter = Router();

  router.post(UNSUBSCRIBE_API_PATH, unsubscribeLimiter, async (req, res) => {
    const body = req.body as { token?: unknown } | undefined;
    const raw = body && typeof body.token === "string" ? body.token : req.query["token"];
    const userId = verifyUnsubscribeToken(raw, env);
    if (!userId) return res.status(400).json({ error: "invalid_token" });

    try {
      const r = await prisma.user.updateMany({
        where: { id: userId, lifecycleEmailOptOutAt: null },
        data: { lifecycleEmailOptOutAt: now() },
      });
      logger.info(
        { event: "lifecycle_email_unsubscribed", userId, changed: r.count > 0 },
        "Lifecycle email opt-out",
      );
      return res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ event: "lifecycle_email_unsubscribe_failed", userId, err }, "Unsubscribe write failed");
      return res.status(503).json({ error: "unavailable", retryable: true });
    }
  });

  return router;
}

const router: IRouter = createLifecycleEmailRouter();
export default router;
