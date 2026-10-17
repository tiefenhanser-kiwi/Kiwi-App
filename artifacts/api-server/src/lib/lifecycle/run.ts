// LIFE-1 — THE SENDER: one scheduler tick, and the welcome at signup.
//
//   runLifecycleTick  — POST /api/internal/lifecycle/emails (hourly, OIDC).
//                       Finds the accounts that could have something due,
//                       sends at most one email to each, returns a summary.
//   sendWelcomeEmail  — fire-and-forget from the signup doors (routes/auth.ts),
//                       beside sendSignupAlert. The tick is its backstop: a
//                       welcome that failed at signup is retried hourly for the
//                       rest of its 24 h window.
//
// THE KILL SWITCH. Nothing is sent unless LIFECYCLE_EMAIL_ENABLED is exactly
// "true" (any case). Read per call, so it is a Cloud Run env change with no
// code path that caches it. Off → the tick answers { enabled: false } and the
// welcome returns before touching the database.
//
// AT MOST ONCE. Each send CLAIMS its (user, kind) row first — the unique key
// makes a second claim fail, so two overlapping ticks, or a tick racing the
// signup's welcome, cannot both send. Resend refusing the send deletes the
// claim (the next tick retries inside the window); the process dying between
// claim and send leaves the claim (never sent beats sent twice).
//
// NEVER LOGGED: an email address, a name, a body, a token. A send is
// `lifecycle_email_sent { userId, kind }`.

import type { PrismaClient, SubscriptionStatus, BillingSource } from "@prisma/client";

import { readBillingConfig } from "../billing/config";
import {
  sendEmail as productionSendEmail,
  type EmailSender,
  type SendResult,
} from "../email/sendEmail";
import { logger } from "../logger";
import { prisma as productionPrisma } from "../prisma";
import { FOOTER, REPLY_TO } from "./copy";
import { renderLifecycleEmail } from "./render";
import {
  ENDED_WINDOW_H,
  ENDING_LEAD_H,
  SIGNUP_OFFSETS_H,
  SIGNUP_WINDOW_H,
  dueKinds,
  formatEndDate,
  type LifecycleFacts,
  type LifecycleKind,
} from "./schedule";
import { unsubscribeUrls } from "./unsubscribe";

export const ENV_LIFECYCLE_EMAIL_ENABLED = "LIFECYCLE_EMAIL_ENABLED";
/** Optional From for these emails only, e.g. "Hans at Kiwi <hans@kitchenwizard.ai>". Unset → EMAIL_FROM. */
export const ENV_LIFECYCLE_EMAIL_FROM = "LIFECYCLE_EMAIL_FROM";

/** Resend's default API limit is 2 requests/s; one send per 600 ms stays under it. */
export const SEND_SPACING_MS = 600;
/** One tick's ceiling. Far above a launch week's volume; it bounds a bad query, not real traffic. */
export const MAX_SENDS_PER_TICK = 100;

const HOUR = 60 * 60 * 1000;

export function lifecycleEmailEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env[ENV_LIFECYCLE_EMAIL_ENABLED] ?? "").trim().toLowerCase() === "true";
}

/**
 * Addresses that cannot receive mail: the reserved example domains and
 * special-use TLDs every test fixture uses. Sending to them is a bounce, and
 * bounces cost the sending domain its reputation. Real-looking staff and
 * tester accounts are NOT excluded — Hans tests the experience on them.
 */
export function isUndeliverable(email: string): boolean {
  return /@(?:example\.(?:com|org|net)|(?:[^@]+\.)?(?:test|example|invalid|localhost))$/i.test(
    email.trim(),
  );
}

type PrismaLike = Pick<PrismaClient, "user" | "lifecycleEmailSend" | "mealPlanInstance">;

export interface LifecycleDeps {
  prisma?: PrismaLike;
  sendEmail?: EmailSender;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  timezone: true,
  createdAt: true,
  firstPlanCreatedAt: true,
  lifecycleEmailOptOutAt: true,
  subscription: { select: { status: true, source: true, trialEndsAt: true } },
  lifecycleEmailSends: { select: { kind: true } },
} as const;

export interface CandidateUser {
  id: string;
  email: string;
  firstName: string | null;
  timezone: string | null;
  createdAt: Date;
  firstPlanCreatedAt: Date | null;
  lifecycleEmailOptOutAt: Date | null;
  subscription: {
    status: SubscriptionStatus;
    source: BillingSource | null;
    trialEndsAt: Date | null;
  } | null;
  lifecycleEmailSends: { kind: string }[];
}

/** The schedule's facts from one account row. `hasPlan` is the stamp only; see confirmNoPlan. */
export function factsFor(u: CandidateUser, billingEnforced: boolean): LifecycleFacts {
  const sub = u.subscription;
  const paying =
    sub !== null && (sub.status === "active" || sub.status === "past_due" || sub.source !== null);
  const freeTimeEndsAt =
    sub !== null && sub.status === "trialing" && sub.source === null ? sub.trialEndsAt : null;
  return {
    createdAt: u.createdAt,
    timezone: u.timezone,
    optedOut: u.lifecycleEmailOptOutAt !== null,
    hasPlan: u.firstPlanCreatedAt !== null,
    freeTimeEndsAt,
    paying,
    billingEnforced,
    sent: new Set(u.lifecycleEmailSends.map((s) => s.kind)),
  };
}

/**
 * Day 1's skip rule, made robust. `firstPlanCreatedAt` is stamped at every
 * plan-commit seam (lib/firstPlan.ts), but an account older than that stamp
 * could hold a plan without it, so a missing stamp is checked against the
 * plans themselves: any committed (non-draft, non-wizard-draft) plan counts.
 */
async function hasCommittedPlan(prisma: PrismaLike, userId: string): Promise<boolean> {
  const n = await prisma.mealPlanInstance.count({
    where: { userId, isWizardDraft: false, status: { not: "draft" } },
  });
  return n > 0;
}

export type SendOutcome =
  | { sent: true; kind: LifecycleKind }
  | {
      sent: false;
      kind: LifecycleKind;
      reason:
        | "already_claimed"
        | "undeliverable"
        | "no_unsubscribe_link"
        | "no_end_date"
        | Exclude<SendResult, { sent: true }>["reason"];
    };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

async function sendOne(
  u: CandidateUser,
  facts: LifecycleFacts,
  kind: LifecycleKind,
  prisma: PrismaLike,
  send: EmailSender,
  env: NodeJS.ProcessEnv,
): Promise<SendOutcome> {
  if (isUndeliverable(u.email)) return { sent: false, kind, reason: "undeliverable" };

  // Every email but the welcome carries the one-click unsubscribe, and is not
  // sent without it.
  const unsub = kind === "welcome" ? null : unsubscribeUrls(u.id, env);
  if (kind !== "welcome" && !unsub) return { sent: false, kind, reason: "no_unsubscribe_link" };

  let endDate: string | null = null;
  if (kind === "trial_ending" || kind === "trial_ended") {
    if (!facts.freeTimeEndsAt) return { sent: false, kind, reason: "no_end_date" };
    endDate = formatEndDate(facts.freeTimeEndsAt, u.timezone);
  }

  const rendered = renderLifecycleEmail({
    kind,
    firstName: u.firstName,
    endDate,
    unsubscribeUrl: unsub?.page ?? null,
  });

  let claimId: string;
  try {
    const claim = await prisma.lifecycleEmailSend.create({
      data: { userId: u.id, kind },
      select: { id: true },
    });
    claimId = claim.id;
  } catch (err) {
    if (isUniqueViolation(err)) return { sent: false, kind, reason: "already_claimed" };
    throw err;
  }

  const from = (env[ENV_LIFECYCLE_EMAIL_FROM] ?? "").trim();
  const result = await send({
    to: u.email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    replyTo: REPLY_TO,
    ...(from ? { from } : {}),
    ...(unsub
      ? {
          headers: {
            "List-Unsubscribe": `<${unsub.post}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  });

  if (!result.sent) {
    await prisma.lifecycleEmailSend.delete({ where: { id: claimId } }).catch(() => undefined);
    logger.warn(
      {
        event: "lifecycle_email_failed",
        userId: u.id,
        kind,
        reason: result.reason,
        ...(result.reason === "send_failed" && result.status ? { status: result.status } : {}),
      },
      "Lifecycle email was not sent — the claim is released for the next tick",
    );
    return { sent: false, kind, reason: result.reason };
  }

  await prisma.lifecycleEmailSend.update({
    where: { id: claimId },
    data: { sentAt: new Date(), providerMessageId: result.id || null },
  });
  logger.info({ event: "lifecycle_email_sent", userId: u.id, kind }, "Lifecycle email sent");
  return { sent: true, kind };
}

/** The first due kind for this account, with Day 1's plan check confirmed against the plans. */
async function nextDue(
  u: CandidateUser,
  facts: LifecycleFacts,
  now: Date,
  prisma: PrismaLike,
): Promise<LifecycleKind | null> {
  let due = dueKinds(facts, now);
  if (due[0] === "day1" && (await hasCommittedPlan(prisma, u.id))) {
    due = dueKinds({ ...facts, hasPlan: true }, now);
  }
  return due[0] ?? null;
}

export interface TickSummary {
  enabled: boolean;
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
  byKind: Partial<Record<LifecycleKind, number>>;
  /** Set when the tick stopped early because mail is not configured. */
  stoppedFor?: string;
}

export async function runLifecycleTick(deps: LifecycleDeps = {}): Promise<TickSummary> {
  const env = deps.env ?? process.env;
  const summary: TickSummary = { enabled: false, candidates: 0, sent: 0, skipped: 0, failed: 0, byKind: {} };
  if (!lifecycleEmailEnabled(env)) return summary;
  summary.enabled = true;

  const prisma = deps.prisma ?? productionPrisma;
  const send = deps.sendEmail ?? productionSendEmail;
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const billingEnforced = readBillingConfig(env).enforced;

  const t = now.getTime();
  const signupFloor = new Date(t - (SIGNUP_OFFSETS_H.day5 + SIGNUP_WINDOW_H) * HOUR);
  const candidates = (await prisma.user.findMany({
    where: {
      accountStatus: "active",
      lifecycleEmailOptOutAt: null,
      OR: [
        { createdAt: { gte: signupFloor } },
        ...(billingEnforced
          ? [
              {
                subscription: {
                  status: "trialing" as const,
                  source: null,
                  trialEndsAt: {
                    gte: new Date(t - ENDED_WINDOW_H * HOUR),
                    lte: new Date(t + ENDING_LEAD_H * HOUR),
                  },
                },
              },
            ]
          : []),
      ],
    },
    select: USER_SELECT,
    orderBy: { createdAt: "asc" },
  })) as CandidateUser[];
  summary.candidates = candidates.length;

  let attempted = 0;
  for (const u of candidates) {
    if (attempted >= MAX_SENDS_PER_TICK) break;
    const facts = factsFor(u, billingEnforced);
    const kind = await nextDue(u, facts, now, prisma);
    if (!kind) continue;

    if (attempted > 0) await sleep(SEND_SPACING_MS);
    attempted++;
    const out = await sendOne(u, facts, kind, prisma, send, env);
    if (out.sent) {
      summary.sent++;
      summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
      continue;
    }
    if (out.reason === "no_api_key" || out.reason === "missing_config") {
      summary.failed++;
      summary.stoppedFor = out.reason;
      break;
    }
    if (out.reason === "send_failed") summary.failed++;
    else summary.skipped++;
  }

  logger.info({ event: "lifecycle_tick", ...summary }, "Lifecycle email tick complete");
  return summary;
}

/**
 * Fire-and-forget from the signup doors: `void sendWelcomeEmail(userId)`.
 * Resolves in every case, including every failure; never throws.
 */
export async function sendWelcomeEmail(userId: string, deps: LifecycleDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (!lifecycleEmailEnabled(env)) return;
  try {
    const prisma = deps.prisma ?? productionPrisma;
    const send = deps.sendEmail ?? productionSendEmail;
    const now = (deps.now ?? (() => new Date()))();
    const u = (await prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    })) as CandidateUser | null;
    if (!u) throw new Error("user not found after commit");
    const facts = factsFor(u, readBillingConfig(env).enforced);
    if (!dueKinds(facts, now).includes("welcome")) return;
    await sendOne(u, facts, "welcome", prisma, send, env);
  } catch (err) {
    logger.warn(
      {
        event: "lifecycle_welcome_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Welcome email was not sent — the signup itself is unaffected; the hourly tick retries",
    );
  }
}

/**
 * The boot line, beside the other config lines in app.ts: on/off, and an
 * error when sending is ON with the footer's postal address still the
 * placeholder (CAN-SPAM) or with no JWT_SECRET (no unsubscribe link).
 */
export function logLifecycleEmailConfig(env: NodeJS.ProcessEnv = process.env): void {
  const on = lifecycleEmailEnabled(env);
  logger.info({ event: "lifecycle_email_config", enabled: on }, `lifecycle email: ${on ? "on" : "off"}`);
  if (!on) return;
  if (FOOTER.mailingAddress.startsWith("[")) {
    logger.error(
      { event: "lifecycle_email_placeholder_address" },
      "LIFECYCLE_EMAIL_ENABLED is on but copy.ts FOOTER.mailingAddress is still the placeholder",
    );
  }
  if (!(env["JWT_SECRET"] ?? "").trim()) {
    logger.error(
      { event: "lifecycle_email_no_unsubscribe_key" },
      "LIFECYCLE_EMAIL_ENABLED is on but JWT_SECRET is unset — every email except the welcome will be refused",
    );
  }
}
