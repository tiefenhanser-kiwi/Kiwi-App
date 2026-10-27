// SRV-2 · D-WS9-308 — ONE EMAIL TO HANS PER NEW ACCOUNT.
//
// Hans (2026-10-11) wants to see every real signup the day it happens. Until
// this file he ran a Neon query by hand. Now each account-creating door calls
// `sendSignupAlert` once, after its transaction commits, and the address in
// `SIGNUP_ALERT_TO` gets a plain-text line saying who arrived, from where and
// how.
//
// THE CONTRACT, and each clause is a test in __tests__/signupAlert.test.ts:
//
//   • `SIGNUP_ALERT_TO` is read LAZILY, per call, exactly as sendEmail.ts reads
//     its keys. Unset → return at once: no query, no send, no log line. That
//     is the default on every deploy and in the suite (which loads `.env`).
//   • IT NEVER THROWS. The callers do not await it (the signup response must
//     never wait on Resend), so a throw here would be an unhandled rejection.
//     Every failure becomes ONE `warn` line, `signup_alert_failed`, carrying
//     the userId and the error message — no name, no email address. The
//     account is the userId; Hans looks the rest up himself.
//   • No email address in the subject or the body either. A forwarded alert
//     must not be a list of customer addresses.
//
// The sender is the one BUG-224 built (lib/email/sendEmail.ts — a bare fetch
// against Resend's HTTP API, no SDK). It already refuses to send when
// RESEND_API_KEY / EMAIL_FROM / PUBLIC_APP_URL are incomplete, and returns a
// typed result rather than throwing; a `sent: false` is a failure here.

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  sendEmail as productionSendEmail,
  type EmailMessage,
  type EmailSender,
} from "./email/sendEmail";
import { logger } from "./logger";
import { storedPlanTitle } from "./planTitle";
import { cameFromLine } from "./signupAttribution";
import { prisma as productionPrisma } from "./prisma";

export type SignupMethod = "password" | "google" | "apple";

export interface SignupAlertInput {
  userId: string;
  /** The door, as finishClaimAfterCommit names it: "signup", "oauth_google", "oauth_apple". */
  via: string;
  method: SignupMethod;
  /** Stage 2's plan. Read only for a `test_kitchen` signup, whose plan it is. */
  claimedPlanId?: string | null;
}

export interface SignupAlertDeps {
  prisma?: Pick<PrismaClient, "user" | "mealPlanInstance">;
  sendEmail?: EmailSender;
}

const ENV_SIGNUP_ALERT_TO = "SIGNUP_ALERT_TO";

function alertRecipient(): string {
  const raw = process.env[ENV_SIGNUP_ALERT_TO];
  return raw && raw.trim() !== "" ? raw.trim() : "";
}

/**
 * The accounts that are not customers: staff, the App Review / QA testers,
 * and every fixture address. ONE `count` over this is the "real accounts"
 * line. Insensitive because an OAuth email is stored as the provider sent it.
 */
export const REAL_ACCOUNT_WHERE = {
  NOT: [
    { email: { endsWith: "@kitchenwizard.ai", mode: "insensitive" } },
    { email: { startsWith: "kiwitester", mode: "insensitive" } },
    { email: { endsWith: "@example.com", mode: "insensitive" } },
  ],
} satisfies Prisma.UserWhereInput;

/** "Hans T." — the last name reduced to its initial; "(no name)" when there is none. */
export function displayName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const first = (firstName ?? "").trim();
  const initial = (lastName ?? "").trim().charAt(0).toUpperCase();
  const parts = [first, initial ? `${initial}.` : ""].filter((p) => p !== "");
  return parts.length > 0 ? parts.join(" ") : "(no name)";
}

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export interface SignupAlertFacts {
  firstName: string | null;
  lastName: string | null;
  signupSource: string | null;
  /** SERVER-6 A (ATTR) — User.signupAttribution as stored; null = no link. */
  signupAttribution?: unknown;
  createdAt: Date;
  method: SignupMethod;
  /** `undefined` = not a Test Kitchen signup (no line); `null` = one whose plan was not built. */
  planTitle?: string | null;
  realAccounts: number;
}

/** Pure: the subject and body, from facts already read. No recipient — the caller adds it. */
export function signupAlertMessage(f: SignupAlertFacts): Omit<EmailMessage, "to"> {
  const source = f.signupSource ?? "(no source)";
  const lines = [
    // Some ICU builds put a narrow no-break space before AM/PM; plain text wants a space.
    `Signed up: ${NEW_YORK.format(f.createdAt).replace(/[  ]/g, " ")}`,
    `Source: ${source}`,
    // SERVER-6 A — the link that brought them (ref · utm · landing), when there was one.
    `Came from: ${cameFromLine(f.signupAttribution) ?? "(no link)"}`,
    `Method: ${f.method}`,
  ];
  if (f.planTitle !== undefined) {
    lines.push(`Plan: ${f.planTitle ?? "(not built)"}`);
  }
  lines.push(`Real accounts: ${f.realAccounts}`);
  return {
    subject: `New Kiwi signup: ${displayName(f.firstName, f.lastName)} via ${source} (${f.method})`,
    text: lines.join("\n"),
  };
}

/**
 * Fire-and-forget from the routes: `void sendSignupAlert(...)`. Resolves in
 * every case, including every failure.
 */
export async function sendSignupAlert(
  input: SignupAlertInput,
  deps: SignupAlertDeps = {},
): Promise<void> {
  const to = alertRecipient();
  if (!to) return;

  try {
    const prisma = deps.prisma ?? productionPrisma;
    const send = deps.sendEmail ?? productionSendEmail;

    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { firstName: true, lastName: true, signupSource: true, signupAttribution: true, createdAt: true },
    });
    if (!user) throw new Error("user not found after commit");

    let planTitle: string | null | undefined;
    if (user.signupSource === "test_kitchen") {
      const plan = input.claimedPlanId
        ? await prisma.mealPlanInstance.findUnique({
            where: { id: input.claimedPlanId },
            select: { titleOverride: true, template: { select: { title: true } } },
          })
        : null;
      planTitle = plan ? storedPlanTitle(plan) || null : null;
    }

    const realAccounts = await prisma.user.count({ where: REAL_ACCOUNT_WHERE });

    const result = await send({
      to,
      ...signupAlertMessage({ ...user, method: input.method, planTitle, realAccounts }),
    });
    if (!result.sent) throw new Error(`send refused: ${result.reason}`);
  } catch (err) {
    logger.warn(
      {
        event: "signup_alert_failed",
        userId: input.userId,
        via: input.via,
        error: err instanceof Error ? err.message : String(err),
      },
      "Signup alert email was not sent — the signup itself is unaffected",
    );
  }
}
