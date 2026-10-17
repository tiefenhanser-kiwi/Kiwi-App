// LIFE-1 — POST /api/me/feedback: "Send feedback" from Profile, as an email
// to Hans.
//
// Built on the SIGNUP_ALERT_TO pattern (lib/signupAlert.ts): the recipient is
// an env var read LAZILY, per call — FEEDBACK_TO, `support@kitchenwizard.ai`
// on production. Two differences, both because a person is waiting on this one:
//
//   • Unset FEEDBACK_TO is a 503 `feedback_unavailable`, not a silent no-op.
//     The alert can drop quietly because nobody asked for it; feedback that
//     vanished while the screen said "Sent" would be a lie told to the one
//     person trying to help.
//   • The send is AWAITED, so a Resend refusal is a 502 the screen can show.
//
// Unlike the alert, the body DOES carry the member's email address — Hans needs
// it to answer — and Reply-To is set to it, so replying in his inbox reaches
// the member directly. The log line carries the userId and the length, never
// the text or the address.
//
// Rate-limited per user: a handful in a burst, then about one every 12 minutes.

import type { PrismaClient } from "@prisma/client";
import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  sendEmail as productionSendEmail,
  type EmailMessage,
  type EmailSender,
} from "../lib/email/sendEmail";
import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { createRequireAuth } from "../middleware/auth";

export const ENV_FEEDBACK_TO = "FEEDBACK_TO";
export const FEEDBACK_MAX_CHARS = 4000;

const feedbackSchema = z
  .object({
    message: z.string().trim().min(1).max(FEEDBACK_MAX_CHARS),
    /** The screen the member was on, when the client knows it. */
    screen: z.string().trim().max(80).optional(),
    appVersion: z.string().trim().max(40).optional(),
    platform: z.enum(["ios", "android", "web"]).optional(),
  })
  .strict();

export type FeedbackInput = z.infer<typeof feedbackSchema>;

export interface FeedbackRouterDeps {
  prisma: PrismaClient;
  sendEmail: EmailSender;
  env: NodeJS.ProcessEnv;
  limiterOpts: { capacity: number; refillPerSec: number };
}

/** Pure: the email to Hans. */
export function feedbackMessage(
  user: { email: string; firstName: string | null; lastName: string | null },
  input: FeedbackInput,
): Omit<EmailMessage, "to"> {
  const name = [user.firstName, user.lastName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  const where = [input.platform ?? "unknown platform", input.appVersion ? `v${input.appVersion}` : null]
    .filter(Boolean)
    .join(" ");
  const firstLine = input.message.split("\n")[0]!.slice(0, 60);
  return {
    subject: `Kiwi feedback: ${firstLine}${input.message.length > firstLine.length ? "…" : ""}`,
    replyTo: user.email,
    text: [
      `From: ${name || "(no name)"} <${user.email}>`,
      `App: ${where}`,
      `Screen: ${input.screen || "(not given)"}`,
      "",
      input.message,
      "",
      "-- Reply to this email to answer them directly.",
    ].join("\n"),
  };
}

export function createFeedbackRouter(deps: Partial<FeedbackRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const send = deps.sendEmail ?? productionSendEmail;
  const env = deps.env ?? process.env;
  const requireAuth = createRequireAuth({ prisma });
  const limiter = rateLimit({
    ...(deps.limiterOpts ?? { capacity: 5, refillPerSec: 1 / 720 }),
    keyFn: (req) => `feedback:${req.userId ?? "anonymous"}`,
  });
  const router: IRouter = Router();

  router.post("/me/feedback", requireAuth, limiter, async (req, res) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid body" });

    const to = (env[ENV_FEEDBACK_TO] ?? "").trim();
    if (!to) {
      logger.warn({ event: "feedback_not_configured", var: ENV_FEEDBACK_TO }, "Feedback refused — FEEDBACK_TO is unset");
      return res.status(503).json({ error: "feedback_unavailable" });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { email: true, firstName: true, lastName: true },
      });
      if (!user) return res.status(401).json({ error: "unauthorized" });

      const result = await send({ to, ...feedbackMessage(user, parsed.data) });
      if (!result.sent) {
        logger.warn(
          { event: "feedback_send_failed", userId: req.userId, reason: result.reason },
          "Feedback email was not sent",
        );
        return res.status(502).json({ error: "send_failed" });
      }
      logger.info(
        { event: "feedback_sent", userId: req.userId, chars: parsed.data.message.length },
        "Feedback sent",
      );
      return res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ event: "feedback_failed", userId: req.userId, err }, "POST /me/feedback failed");
      return res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}

const router: IRouter = createFeedbackRouter();
export default router;
