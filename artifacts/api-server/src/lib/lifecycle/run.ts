// LIFE-1 + LIFE-2 — THE SENDER: one scheduler tick, and the welcome at signup.
//
//   runLifecycleTick  — POST /api/internal/lifecycle/emails (hourly, OIDC).
//                       Reads every account's facts in one batched read,
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
// ONE READ PER TICK (LIFE-2). Every active, opted-in account and its facts —
// plans, grocery lists, the three activity kinds the schedule reads, prep
// check-offs, the Playlist count, the send log — come from ONE findMany with
// nested selects (Prisma batches each relation as one IN query). There is no
// per-account query anywhere in the tick; LIFE-1's Day 1 plan check, which was
// one, is now read from the same rows. Every account is read, not a pre-filtered
// slice: LIFE-2's kinds anchor on events anywhere in an account's history, and a
// pre-filter that missed one would silently never send it.
//
// AT MOST ONCE. Each send CLAIMS its (user, kind, refId) row first — the unique
// key makes a second claim fail, so two overlapping ticks, or a tick racing the
// signup's welcome, cannot both send. refId is "" for every kind but next_week,
// whose refId is the plan's id (one per plan). Resend refusing the send deletes
// the claim (the next tick retries inside the window); the process dying
// between claim and send leaves the claim (never sent beats sent twice).
//
// NEVER LOGGED: an email address, a name, a body, a token. A send is
// `lifecycle_email_sent { userId, kind, refId? }`.

import type { PrismaClient, SubscriptionStatus, BillingSource, ActivityEventType } from "@prisma/client";

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
  currentPlan,
  dueKinds,
  formatEndDate,
  formatPlanEndDay,
  refIdFor,
  sendKey,
  type DatedPlan,
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

type PrismaLike = Pick<PrismaClient, "user" | "lifecycleEmailSend">;

export interface LifecycleDeps {
  prisma?: PrismaLike;
  sendEmail?: EmailSender;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** The activity kinds the schedule reads a FIRST time from. */
const FIRST_OF: ActivityEventType[] = ["cook_finished", "plan_prep_started"];

export const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  timezone: true,
  createdAt: true,
  firstPlanCreatedAt: true,
  lastActiveAt: true,
  lifecycleEmailOptOutAt: true,
  subscription: { select: { status: true, source: true, trialEndsAt: true } },
  lifecycleEmailSends: { select: { kind: true, refId: true, claimedAt: true } },
  // Committed plans only — the same filter LIFE-1's Day 1 check counted with.
  planInstances: {
    where: { isWizardDraft: false, status: { not: "draft" as const } },
    select: {
      id: true,
      createdAt: true,
      committedAt: true,
      startDate: true,
      endDate: true,
      compostedAt: true,
      isArchived: true,
      prepStepCompletions: { select: { checkedAt: true }, orderBy: { checkedAt: "asc" as const }, take: 1 },
    },
  },
  groceryLists: { select: { createdAt: true }, orderBy: { createdAt: "asc" as const }, take: 2 },
  activities: {
    where: { eventType: { in: FIRST_OF } },
    select: { eventType: true, createdAt: true },
    orderBy: { createdAt: "asc" as const },
  },
  _count: {
    select: {
      playlistMeals: true,
      groceryLists: { where: { instacartLinkedAt: { not: null } } },
      activities: { where: { eventType: "order_groceries" as const } },
    },
  },
} as const;

export interface CandidatePlan {
  id: string;
  createdAt: Date;
  committedAt: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  compostedAt: Date | null;
  isArchived: boolean;
  prepStepCompletions: { checkedAt: Date }[];
}

export interface CandidateUser {
  id: string;
  email: string;
  firstName: string | null;
  timezone: string | null;
  createdAt: Date;
  firstPlanCreatedAt: Date | null;
  lastActiveAt: Date | null;
  lifecycleEmailOptOutAt: Date | null;
  subscription: {
    status: SubscriptionStatus;
    source: BillingSource | null;
    trialEndsAt: Date | null;
  } | null;
  lifecycleEmailSends: { kind: string; refId: string; claimedAt: Date }[];
  planInstances: CandidatePlan[];
  groceryLists: { createdAt: Date }[];
  activities: { eventType: ActivityEventType; createdAt: Date }[];
  _count: { playlistMeals: number; groceryLists: number; activities: number };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const earliest = (ds: (Date | null | undefined)[]): Date | null =>
  ds.reduce<Date | null>((min, d) => (d && (!min || d.getTime() < min.getTime()) ? d : min), null);

/** The schedule's facts from one account row. Pure. */
export function factsFor(u: CandidateUser, billingEnforced: boolean): LifecycleFacts {
  const sub = u.subscription;
  const paying =
    sub !== null && (sub.status === "active" || sub.status === "past_due" || sub.source !== null);
  const freeTimeEndsAt =
    sub !== null && sub.status === "trialing" && sub.source === null ? sub.trialEndsAt : null;

  // A plan's commit time is committedAt; rows from before that column use createdAt.
  const commits = u.planInstances
    .map((p) => p.committedAt ?? p.createdAt)
    .sort((a, b) => a.getTime() - b.getTime());
  const datedPlans: DatedPlan[] = u.planInstances
    .filter((p) => p.startDate && p.endDate && !p.compostedAt && !p.isArchived)
    .map((p) => ({ id: p.id, firstDay: ymd(p.startDate!), lastDay: ymd(p.endDate!) }));
  const firstOf = (t: ActivityEventType) => u.activities.find((a) => a.eventType === t)?.createdAt ?? null;

  return {
    createdAt: u.createdAt,
    timezone: u.timezone,
    optedOut: u.lifecycleEmailOptOutAt !== null,
    // LIFE-1's Day 1 rule, robust to an account older than the stamp: any committed plan counts.
    hasPlan: u.firstPlanCreatedAt !== null || u.planInstances.length > 0,
    freeTimeEndsAt,
    paying,
    billingEnforced,
    sent: new Set(u.lifecycleEmailSends.map((s) => sendKey(s.kind, s.refId))),
    capClaims: u.lifecycleEmailSends.filter((s) => s.kind !== "welcome").map((s) => s.claimedAt),
    firstPlanAt: earliest([u.firstPlanCreatedAt, commits[0]]),
    secondPlanAt: commits[1] ?? null,
    datedPlans,
    firstListAt: u.groceryLists[0]?.createdAt ?? null,
    secondListAt: u.groceryLists[1]?.createdAt ?? null,
    sentToInstacart: u._count.groceryLists > 0 || u._count.activities > 0,
    firstPrepAt: earliest([
      firstOf("plan_prep_started"),
      ...u.planInstances.map((p) => p.prepStepCompletions[0]?.checkedAt),
    ]),
    firstCookFinishedAt: firstOf("cook_finished"),
    hasPlaylist: u._count.playlistMeals > 0,
    lastActiveAt: u.lastActiveAt,
  };
}

/**
 * The tick's one read: every account that may be emailed, with its facts.
 * Read-only — the LIFE-2 dry-run projection calls it against dev.
 */
export async function loadCandidates(prisma: PrismaLike): Promise<CandidateUser[]> {
  return (await prisma.user.findMany({
    where: { accountStatus: "active", lifecycleEmailOptOutAt: null },
    select: USER_SELECT,
    orderBy: { createdAt: "asc" },
  })) as unknown as CandidateUser[];
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
        | "no_plan"
        | Exclude<SendResult, { sent: true }>["reason"];
    };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

async function sendOne(
  u: CandidateUser,
  facts: LifecycleFacts,
  kind: LifecycleKind,
  now: Date,
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
  let planEndDay: string | null = null;
  const refId = refIdFor(kind, facts, now);
  if (kind === "next_week") {
    const plan = currentPlan(facts, now);
    if (!plan) return { sent: false, kind, reason: "no_plan" };
    planEndDay = formatPlanEndDay(plan.lastDay);
  }

  const rendered = renderLifecycleEmail({
    kind,
    firstName: u.firstName,
    endDate,
    planEndDay,
    unsubscribeUrl: unsub?.page ?? null,
  });

  let claimId: string;
  try {
    const claim = await prisma.lifecycleEmailSend.create({
      data: { userId: u.id, kind, refId },
      select: { id: true },
    });
    claimId = claim.id;
  } catch (err) {
    if (isUniqueViolation(err)) return { sent: false, kind, reason: "already_claimed" };
    throw err;
  }
  const logRef = refId ? { refId } : {};

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
        ...logRef,
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
  logger.info({ event: "lifecycle_email_sent", userId: u.id, kind, ...logRef }, "Lifecycle email sent");
  return { sent: true, kind };
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

  const candidates = await loadCandidates(prisma);
  summary.candidates = candidates.length;

  let attempted = 0;
  for (const u of candidates) {
    if (attempted >= MAX_SENDS_PER_TICK) break;
    const facts = factsFor(u, billingEnforced);
    const kind = dueKinds(facts, now)[0];
    if (!kind) continue;

    if (attempted > 0) await sleep(SEND_SPACING_MS);
    attempted++;
    const out = await sendOne(u, facts, kind, now, prisma, send, env);
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
    })) as unknown as CandidateUser | null;
    if (!u) throw new Error("user not found after commit");
    const facts = factsFor(u, readBillingConfig(env).enforced);
    if (!dueKinds(facts, now).includes("welcome")) return;
    await sendOne(u, facts, "welcome", now, prisma, send, env);
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
