// LIFE-1 — WHEN EACH LIFECYCLE EMAIL IS DUE. Pure: facts and a clock in, kinds out.
//
// THE SCHEDULE (the prompt's table, plus the windows that make it safe):
//
//   kind           due at                     until (window end)        skipped when
//   welcome        signup                     signup + 24 h             —
//   day1           signup + 24 h              signup + 48 h             the account has a plan
//   day3           signup + 72 h              signup + 96 h             —
//   day5           signup + 120 h             signup + 144 h            —
//   trial_ending   free time end − 72 h       free time end             paying; billing not enforced
//   trial_ended    free time end              free time end + 48 h      paying; billing not enforced
//
// Every kind also needs: not sent before (the send log), and no opt-out.
//
// WHY A WINDOW AND NOT JUST "DUE AT". The scheduler is hourly and the first
// production tick will find accounts that are weeks old. Without an upper
// bound every one of them would be "due" for Day 1, 3 and 5 at once. With it,
// an email that was not sent in its window is simply never sent: a missed
// Day 3 on Day 9 would be noise, not help.
//
// QUIET HOURS. Nothing but the welcome is sent between 21:00 and 08:00 in the
// account's own time zone (User.timezone, default America/New_York); an email
// that falls due then goes on the first tick after 08:00. Hourly ticks would
// otherwise send the November 2 cohort's emails in the middle of the night:
// their free time ends 23:59:59 ET, so "ended" is due at midnight and
// "ending" (end − 72 h, across the November 1 DST change) just before 1 a.m.
// Every window is at least 24 h and quiet hours are 11, so a deferred email
// always still lands inside its window.
//
// ONE EMAIL PER ACCOUNT PER TICK. `dueKinds` returns every due kind in PRIORITY
// order and the runner sends only the first; the rest wait an hour (their
// windows are a day long). In practice two never overlap: the day emails end
// at 144 h and a 14-day trial's "ending" starts at 264 h.

export const LIFECYCLE_KINDS = [
  "welcome",
  "day1",
  "day3",
  "day5",
  "trial_ending",
  "trial_ended",
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export function isLifecycleKind(v: string): v is LifecycleKind {
  return (LIFECYCLE_KINDS as readonly string[]).includes(v);
}

const HOUR = 60 * 60 * 1000;

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

/** Sent first when several are due at once: the time-bound ones lead. */
const PRIORITY: readonly LifecycleKind[] = [
  "trial_ended",
  "trial_ending",
  "welcome",
  "day1",
  "day3",
  "day5",
];

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
  /** BILLING_ENFORCED. Off → nobody's free time actually ends, so neither free-time email is true. */
  billingEnforced: boolean;
  sent: ReadonlySet<string>;
}

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Wall-clock hour (0–23) of `d` in `tz`. */
function localHour(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}

/** 21:00–07:59 on the account's own clock. */
export function isQuietHour(d: Date, tz: string): boolean {
  const hour = localHour(d, tz);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** [from, until) for a kind, or null when the kind cannot apply to these facts. */
export function windowFor(
  kind: LifecycleKind,
  f: LifecycleFacts,
): { from: Date; until: Date } | null {
  if (kind === "trial_ending" || kind === "trial_ended") {
    if (!f.freeTimeEndsAt) return null;
    const end = f.freeTimeEndsAt.getTime();
    return kind === "trial_ending"
      ? { from: new Date(end - ENDING_LEAD_H * HOUR), until: new Date(end) }
      : { from: new Date(end), until: new Date(end + ENDED_WINDOW_H * HOUR) };
  }
  const start = f.createdAt.getTime() + SIGNUP_OFFSETS_H[kind] * HOUR;
  return { from: new Date(start), until: new Date(start + SIGNUP_WINDOW_H * HOUR) };
}

function skipped(kind: LifecycleKind, f: LifecycleFacts): boolean {
  if (kind === "day1") return f.hasPlan;
  if (kind === "trial_ending" || kind === "trial_ended") {
    return f.paying || !f.billingEnforced;
  }
  return false;
}

/** Every kind due at `now`, highest priority first. The runner sends only [0]. */
export function dueKinds(f: LifecycleFacts, now: Date): LifecycleKind[] {
  if (f.optedOut) return [];
  // The welcome is a reply to the signup itself, so it ignores quiet hours.
  const quiet = isQuietHour(now, safeTimezone(f.timezone));
  const due: LifecycleKind[] = [];
  for (const kind of PRIORITY) {
    if (f.sent.has(kind)) continue;
    if (quiet && kind !== "welcome") continue;
    const w = windowFor(kind, f);
    if (!w) continue;
    if (now.getTime() < w.from.getTime() || now.getTime() >= w.until.getTime()) continue;
    if (skipped(kind, f)) continue;
    due.push(kind);
  }
  return due;
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
