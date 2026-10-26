// 1.2-NATIVE C — when Kiwi asks for a store review. Only after a success: the
// cook leaves Cook Mode on its last live step (the "finish"; single-meal Cook
// Mode has no Done button, CookSessionView's onLeaveAfterLastStep is the
// signal) for the 2nd time or later. At most once per 120 days, never in the
// first 3 days after signup, never on web, never for a guest. Profile's
// "Rate Kiwi" row is separate and unchanged.
//
// Pure, so it is tested here; the live half (storage, expo-store-review) is
// lib/storeReview.ts.

export const REVIEW_MIN_FINISHES = 2;
export const REVIEW_COOLDOWN_DAYS = 120;
export const REVIEW_NEW_ACCOUNT_DAYS = 3;
/** After the exit, so the sheet opens over the screen the cook landed on. */
export const REVIEW_DELAY_MS = 1_000;

const DAY_MS = 24 * 60 * 60_000;

/** What the device remembers (lib/storage.ts, key "storeReview"). */
export interface ReviewState {
  /** Cook Mode finishes on this device, ever. */
  finishes: number;
  /** When the review was last asked for (ms), or null for never. */
  lastAskedAt: number | null;
}

export const INITIAL_REVIEW_STATE: ReviewState = { finishes: 0, lastAskedAt: null };

/** A stored value of any shape, read back as a ReviewState. */
export function readReviewState(raw: unknown): ReviewState {
  const r = (raw ?? {}) as Partial<ReviewState>;
  const finishes = typeof r.finishes === "number" && Number.isFinite(r.finishes) && r.finishes > 0 ? Math.floor(r.finishes) : 0;
  const lastAskedAt = typeof r.lastAskedAt === "number" && Number.isFinite(r.lastAskedAt) ? r.lastAskedAt : null;
  return { finishes, lastAskedAt };
}

export function recordCookFinish(s: ReviewState): ReviewState {
  return { ...s, finishes: s.finishes + 1 };
}

export interface ReviewAskInput {
  platform: string;
  /** The state AFTER this finish was recorded. */
  state: ReviewState;
  /** The member's signup (User.createdAt), or null for a guest / no user. */
  signupAt: string | null | undefined;
  now: number;
}

export function shouldAskForReview(i: ReviewAskInput): boolean {
  if (i.platform === "web") return false;
  if (i.state.finishes < REVIEW_MIN_FINISHES) return false;
  if (i.state.lastAskedAt !== null && i.now - i.state.lastAskedAt < REVIEW_COOLDOWN_DAYS * DAY_MS) return false;
  if (!i.signupAt) return false;
  const signup = Date.parse(i.signupAt);
  // An unreadable date is not proof the account is old enough.
  if (!Number.isFinite(signup)) return false;
  return i.now - signup >= REVIEW_NEW_ACCOUNT_DAYS * DAY_MS;
}

export function markReviewAsked(s: ReviewState, now: number): ReviewState {
  return { ...s, lastAskedAt: now };
}
