// LIFE-1 + LIFE-2 — WHEN EACH LIFECYCLE EMAIL IS DUE. Pure: facts and a clock in, kinds out.
//
// THE SCHEDULE ("Kiwi Lifecycle Emails", approved by Hans Oct 25):
//
//   kind             due at                                until (window end)          skipped when
//   welcome          signup                                signup + 24 h               —
//   day1             signup + 24 h                         signup + 48 h               the account has a plan
//   day3             signup + 72 h                         signup + 96 h               a grocery list exists (LIFE-2)
//   day5             signup + 120 h                        signup + 144 h              a prep session has started (LIFE-2)
//   trial_ending     free time end − 72 h                  free time end               paying; billing not enforced
//   trial_ended      free time end                         free time end + 48 h        paying; billing not enforced
//   list_nudge       first plan + 24 h                     + 24 h                      a grocery list exists
//   prep_nudge       first grocery list + 24 h             + 24 h                      a prep or cook session has started
//   first_cook       08:00 the morning after the first     + 24 h                      — (once)
//                    finished cook
//   next_week        the current plan's last day − 2 days  the end of its last day     a later plan exists
//                    (00:00 there), keyed PER PLAN
//   playlist_nudge   second plan created                   + 48 h                      a Playlist exists
//   instacart_nudge  second grocery list created           + 48 h                      ever sent a list to Instacart
//   still_here       last active + 7 days, during the      + 48 h                      any activity since (the anchor
//                    free time                                                         moves); not in the free time;
//                                                                                      billing not enforced (SERVER-9)
//   come_back        free time end + 10 days               + 7 days                    paying; billing not enforced
//
// Every kind also needs: not sent before (the send log — once per account per
// kind, once per account per PLAN for next_week), and no opt-out.
//
// WHY A WINDOW AND NOT JUST "DUE AT". The scheduler is hourly and every tick
// sees accounts that are weeks old. Without an upper bound every one of them
// would be "due" for everything at once. With it, an email that was not sent
// in its window is simply never sent: a missed Day 3 on Day 9 would be noise,
// not help. LIFE-2's kinds anchor on EVENTS (a first list, a second plan), so
// switching them on sends an old account nothing unless the event is recent.
//
// QUIET HOURS. Nothing but the welcome is sent between 21:00 and 08:00 in the
// account's own time zone (User.timezone, default America/New_York); an email
// that falls due then goes on the first tick after 08:00. Every window is at
// least 24 h and quiet hours are 11, so a deferred email still lands inside its
// window — next_week's included: its window opens at 00:00 two days before the
// plan's last day and so holds two full sending days.
//
// THE WEEKLY CAP. At most WEEKLY_CAP emails per account in any rolling 7 days,
// the welcome excepted (it answers the signup). A kind that would break the cap
// waits; its own window decides whether it still goes. Every claim in the send
// log counts, sent or still in flight.
//
// The free-time pair COUNTS toward the cap but is never HELD by it (LIFE-2
// deviation from "the welcome excepted", reported to Hans). Held, "has ended"
// is lost outright for anyone whose plan ran out that week: next_week (Thu Oct
// 29) + trial_ending (Sat Oct 31) fill the cap until Nov 5, and trial_ended's
// 48 h window (Nov 3–5) closes first — 10 of 27 accounts in the production-
// shaped projection. The doc promises the base both free-time emails, and they
// already lead the priority order. The cost is a third email that week.
//
// ONE EMAIL PER ACCOUNT PER TICK. `dueKinds` returns every due kind in PRIORITY
// order and the runner sends only the first; the rest wait an hour. Priority:
// the free-time pair first; then the welcome, the day emails and the event
// nudges, oldest anchor (window start) first; then still_here and come_back.

export const LIFECYCLE_KINDS = [
  "welcome",
  "day1",
  "day3",
  "day5",
  "trial_ending",
  "trial_ended",
  "list_nudge",
  "prep_nudge",
  "first_cook",
  "next_week",
  "playlist_nudge",
  "instacart_nudge",
  "still_here",
  "come_back",
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export function isLifecycleKind(v: string): v is LifecycleKind {
  return (LIFECYCLE_KINDS as readonly string[]).includes(v);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Hours after signup each day email is due, and how long it stays sendable. */
export const SIGNUP_OFFSETS_H: Record<"welcome" | "day1" | "day3" | "day5", number> = {
  welcome: 0,
  day1: 24,
  day3: 72,
  day5: 120,
};
export const SIGNUP_WINDOW_H = 24;
export const ENDING_LEAD_H = 72;
export const ENDED_WINDOW_H = 48;
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;
export const DEFAULT_TIMEZONE = "America/New_York";

/** LIFE-2 — the event nudges' offsets and windows, in hours. */
export const LIST_NUDGE_OFFSET_H = 24;
export const PREP_NUDGE_OFFSET_H = 24;
export const NUDGE_WINDOW_H = 24;
export const SECOND_EVENT_WINDOW_H = 48;
/** first_cook goes at the first 08:00 at least this long after the cook finished. */
export const FIRST_COOK_MIN_GAP_H = 6;
export const FIRST_COOK_HOUR = 8;
export const NEXT_WEEK_LEAD_DAYS = 2;
export const STILL_HERE_IDLE_DAYS = 7;
export const STILL_HERE_WINDOW_H = 48;
export const COME_BACK_DAYS = 10;
export const COME_BACK_WINDOW_DAYS = 7;

/** At most this many emails per account per rolling CAP_WINDOW_H, the welcome excepted. */
export const WEEKLY_CAP = 2;
export const CAP_WINDOW_H = 7 * 24;
/** Kinds the cap never holds back. The welcome is also not counted; the free-time pair is. */
export const CAP_NEVER_HOLDS: readonly LifecycleKind[] = ["welcome", "trial_ending", "trial_ended"];

/**
 * SERVER-9 A (D-WS9-356) — the kinds about free time ending: an end date, a
 * price, subscribing, or (still_here) "during the free time". While
 * BILLING_ENFORCED is off Kiwi is free during launch and nobody's free time
 * ends, so none of them is ever due (skipped, below). The other ten kinds' copy
 * names no trial, price or end date (copy.ts; serverNine.test.ts greps it).
 */
export const FREE_TIME_KINDS: readonly LifecycleKind[] = ["trial_ending", "trial_ended", "still_here", "come_back"];

/** The free-time pair leads; still_here and come_back trail; everything else is ordered by anchor. */
const FIRST: readonly LifecycleKind[] = ["trial_ended", "trial_ending"];
const LAST: readonly LifecycleKind[] = ["still_here", "come_back"];

/** A committed plan with both dates, as calendar days (YYYY-MM-DD, the stored UTC-midnight basis). */
export interface DatedPlan {
  id: string;
  firstDay: string;
  lastDay: string;
}

export interface LifecycleFacts {
  createdAt: Date;
  /** User.timezone; null or invalid → America/New_York. */
  timezone: string | null;
  optedOut: boolean;
  /** Only read for day1. */
  hasPlan: boolean;
  /**
   * The free time's end — Subscription.trialEndsAt — when the stored status is
   * `trialing` with no paid source. Null otherwise (no row, a paid rail, a
   * cancelled or active subscription, or a trialing row with no end date).
   */
  freeTimeEndsAt: Date | null;
  /** Stored status active/past_due, or any paid source. Never sent the free-time emails. */
  paying: boolean;
  /** BILLING_ENFORCED. Off → nobody's free time actually ends, so no free-time email is true. */
  billingEnforced: boolean;
  /** The send log, as sendKey(kind, refId) strings. */
  sent: ReadonlySet<string>;
  /** When each non-welcome claim in the send log was made — the weekly cap counts them. */
  capClaims: readonly Date[];

  // ── LIFE-2 ──
  /** The first committed plan (User.firstPlanCreatedAt, or the earliest commit when the stamp is missing). */
  firstPlanAt: Date | null;
  /** The second committed plan's commit time. */
  secondPlanAt: Date | null;
  /** Committed, live (not composted, not archived) plans with both dates. */
  datedPlans: readonly DatedPlan[];
  firstListAt: Date | null;
  secondListAt: Date | null;
  /** Any list ever linked to Instacart (GroceryList.instacartLinkedAt, or an order_groceries activity). */
  sentToInstacart: boolean;
  /** The first prep step checked off, or a plan_prep_started activity, whichever came first. */
  firstPrepAt: Date | null;
  /** The first cook_finished activity. */
  firstCookFinishedAt: Date | null;
  hasPlaylist: boolean;
  /** User.lastActiveAt (written by requireAuth, at most hourly). Null → never known, never "idle". */
  lastActiveAt: Date | null;
}

/** The send log's key: next_week is keyed per plan, every other kind once per account. */
export function sendKey(kind: string, refId: string = ""): string {
  return refId ? `${kind}:${refId}` : kind;
}

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    formatterFor(tz);
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * One formatter per time zone. Building an Intl.DateTimeFormat costs far more
 * than using one, and a tick asks each account's clock a dozen times.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

function zonedParts(d: Date, tz: string) {
  const parts = formatterFor(tz).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Wall-clock hour (0–23) of `d` in `tz`. */
function localHour(d: Date, tz: string): number {
  return zonedParts(d, tz).hour;
}

/** 21:00–07:59 on the account's own clock. */
export function isQuietHour(d: Date, tz: string): boolean {
  const hour = localHour(d, tz);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** The calendar day of `d` on the account's clock, YYYY-MM-DD. */
export function localDay(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** YYYY-MM-DD plus `n` days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** The instant that is `hour`:00 on calendar `day` in `tz` (DST-safe). */
export function zonedTime(day: string, hour: number, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour);
  const offsetAt = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

/** first_cook's moment: the first 08:00 on the account's clock at least FIRST_COOK_MIN_GAP_H after the cook. */
export function morningAfter(cookAt: Date, tz: string): Date {
  const earliest = new Date(cookAt.getTime() + FIRST_COOK_MIN_GAP_H * HOUR);
  const day = localDay(earliest, tz);
  const same = zonedTime(day, FIRST_COOK_HOUR, tz);
  return same.getTime() >= earliest.getTime() ? same : zonedTime(addDays(day, 1), FIRST_COOK_HOUR, tz);
}

/**
 * The plan next_week is about: of the dated plans covering today on the
 * account's clock, the one that runs out last. Null when none covers today.
 */
export function currentPlan(f: LifecycleFacts, now: Date): DatedPlan | null {
  const today = localDay(now, safeTimezone(f.timezone));
  let best: DatedPlan | null = null;
  for (const p of f.datedPlans) {
    if (p.firstDay > today || p.lastDay < today) continue;
    if (!best || p.lastDay > best.lastDay || (p.lastDay === best.lastDay && p.id < best.id)) best = p;
  }
  return best;
}

/** The send log's refId for a kind at `now`: the current plan's id for next_week, "" otherwise. */
export function refIdFor(kind: LifecycleKind, f: LifecycleFacts, now: Date): string {
  if (kind !== "next_week") return "";
  return currentPlan(f, now)?.id ?? "";
}

const span = (from: number, hours: number) => ({ from: new Date(from), until: new Date(from + hours * HOUR) });

/** [from, until) for a kind, or null when the kind cannot apply to these facts. */
export function windowFor(
  kind: LifecycleKind,
  f: LifecycleFacts,
  now: Date,
): { from: Date; until: Date } | null {
  const tz = safeTimezone(f.timezone);
  switch (kind) {
    case "welcome":
    case "day1":
    case "day3":
    case "day5":
      return span(f.createdAt.getTime() + SIGNUP_OFFSETS_H[kind] * HOUR, SIGNUP_WINDOW_H);
    case "trial_ending":
      if (!f.freeTimeEndsAt) return null;
      return span(f.freeTimeEndsAt.getTime() - ENDING_LEAD_H * HOUR, ENDING_LEAD_H);
    case "trial_ended":
      if (!f.freeTimeEndsAt) return null;
      return span(f.freeTimeEndsAt.getTime(), ENDED_WINDOW_H);
    case "list_nudge":
      if (!f.firstPlanAt) return null;
      return span(f.firstPlanAt.getTime() + LIST_NUDGE_OFFSET_H * HOUR, NUDGE_WINDOW_H);
    case "prep_nudge":
      if (!f.firstListAt) return null;
      return span(f.firstListAt.getTime() + PREP_NUDGE_OFFSET_H * HOUR, NUDGE_WINDOW_H);
    case "first_cook":
      if (!f.firstCookFinishedAt) return null;
      return span(morningAfter(f.firstCookFinishedAt, tz).getTime(), NUDGE_WINDOW_H);
    case "next_week": {
      const plan = currentPlan(f, now);
      if (!plan) return null;
      return {
        from: zonedTime(addDays(plan.lastDay, -NEXT_WEEK_LEAD_DAYS), 0, tz),
        until: zonedTime(addDays(plan.lastDay, 1), 0, tz),
      };
    }
    case "playlist_nudge":
      if (!f.secondPlanAt) return null;
      return span(f.secondPlanAt.getTime(), SECOND_EVENT_WINDOW_H);
    case "instacart_nudge":
      if (!f.secondListAt) return null;
      return span(f.secondListAt.getTime(), SECOND_EVENT_WINDOW_H);
    case "still_here":
      if (!f.lastActiveAt) return null;
      return span(f.lastActiveAt.getTime() + STILL_HERE_IDLE_DAYS * DAY, STILL_HERE_WINDOW_H);
    case "come_back":
      if (!f.freeTimeEndsAt) return null;
      return span(f.freeTimeEndsAt.getTime() + COME_BACK_DAYS * DAY, COME_BACK_WINDOW_DAYS * 24);
  }
}

function skipped(kind: LifecycleKind, f: LifecycleFacts, now: Date): boolean {
  if (FREE_TIME_KINDS.includes(kind) && !f.billingEnforced) return true;
  switch (kind) {
    case "day1":
      return f.hasPlan;
    case "day3":
    case "list_nudge":
      return f.firstListAt !== null;
    case "day5":
      return f.firstPrepAt !== null;
    case "prep_nudge":
      return f.firstPrepAt !== null || f.firstCookFinishedAt !== null;
    case "trial_ending":
    case "trial_ended":
    case "come_back":
      return f.paying;
    case "next_week": {
      const plan = currentPlan(f, now);
      return !plan || f.datedPlans.some((p) => p.lastDay > plan.lastDay);
    }
    case "playlist_nudge":
      return f.hasPlaylist;
    case "instacart_nudge":
      return f.sentToInstacart;
    case "still_here":
      // "During the free time": a trialing account whose free time has not ended.
      return f.paying || !f.freeTimeEndsAt || now.getTime() >= f.freeTimeEndsAt.getTime();
    default:
      return false;
  }
}

/** True when the account has had WEEKLY_CAP non-welcome emails in the last CAP_WINDOW_H. */
export function isCapped(f: LifecycleFacts, now: Date): boolean {
  const since = now.getTime() - CAP_WINDOW_H * HOUR;
  return f.capClaims.filter((d) => d.getTime() > since).length >= WEEKLY_CAP;
}

/** Every kind due at `now`, highest priority first. The runner sends only [0]. */
export function dueKinds(f: LifecycleFacts, now: Date): LifecycleKind[] {
  if (f.optedOut) return [];
  // The welcome is a reply to the signup itself, so it ignores quiet hours and the cap.
  const quiet = isQuietHour(now, safeTimezone(f.timezone));
  const capped = isCapped(f, now);
  const t = now.getTime();
  const due: { kind: LifecycleKind; from: number; order: number }[] = [];
  LIFECYCLE_KINDS.forEach((kind, order) => {
    if (f.sent.has(sendKey(kind, refIdFor(kind, f, now)))) return;
    if (kind !== "welcome" && quiet) return;
    if (capped && !CAP_NEVER_HOLDS.includes(kind)) return;
    const w = windowFor(kind, f, now);
    if (!w) return;
    if (t < w.from.getTime() || t >= w.until.getTime()) return;
    if (skipped(kind, f, now)) return;
    due.push({ kind, from: w.from.getTime(), order });
  });
  const tier = (k: LifecycleKind) => (FIRST.includes(k) ? 0 : LAST.includes(k) ? 2 : 1);
  due.sort((a, b) => {
    const ta = tier(a.kind);
    const tb = tier(b.kind);
    if (ta !== tb) return ta - tb;
    if (ta === 0) return FIRST.indexOf(a.kind) - FIRST.indexOf(b.kind);
    if (ta === 2) return LAST.indexOf(a.kind) - LAST.indexOf(b.kind);
    return a.from - b.from || a.order - b.order;
  });
  return due.map((d) => d.kind);
}

/** "Monday, November 2" in the account's time zone. */
export function formatEndDate(d: Date, timezone: string | null): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone(timezone),
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
}

/** next_week's {planEndDay}: the weekday of a plan's last calendar day ("Friday"). */
export function formatPlanEndDay(lastDay: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${lastDay}T12:00:00Z`),
  );
}
