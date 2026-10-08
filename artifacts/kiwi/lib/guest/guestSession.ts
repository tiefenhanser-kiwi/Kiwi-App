// Row 13 "Test Kitchen" · Block 2 — the guest entry's DECISIONS, as pure
// functions. `app/**` is outside the test glob (D-WS9-164), so everything the
// entry screen decides lives here and the screen keeps only the fetches and the
// chrome — the same split lib/sessionBootstrap.ts made for the cold start.

import type { GuestSessionCredentials } from "./guestToken";

/**
 * R2 — "resumes an unexpired stored guest session … or creates one".
 *
 * A token that expires in the next minute is treated as already gone: the guest
 * flow's next call is a generate or an expand, either of which outlives that
 * margin, and a 401 mid-generation costs the visitor the plan they were
 * watching Kiwi build. Cheaper to mint a fresh session at the door.
 */
export const GUEST_EXPIRY_MARGIN_MS = 60_000;

export type GuestEntryAction = "resume" | "create";

export function guestSessionUsable(
  stored: GuestSessionCredentials | null,
  nowMs: number,
): boolean {
  if (!stored) return false;
  const expiresMs = Date.parse(stored.expiresAt);
  // An unparseable stamp is not a reason to trust the token.
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs - GUEST_EXPIRY_MARGIN_MS > nowMs;
}

export function deriveGuestEntryAction(
  stored: GuestSessionCredentials | null,
  nowMs: number,
): GuestEntryAction {
  return guestSessionUsable(stored, nowMs) ? "resume" : "create";
}

// ── where a resumed visitor belongs ────────────────────────────────────────
//
// GET /guest/session answers three facts the entry needs: has this visitor
// spent their one generation (`generationCount`), what were they shown
// (`candidates`), and did they open one (`hasDraft`). The stage is the furthest
// point they reached, because going back to the wizard would strand them: the
// generation is spent and a second is a 409.

export type GuestStage = "wizard" | "options" | "plan";

export interface GuestSessionRead {
  generationCount: number;
  hasDraft: boolean;
  /** null before the first generation — NOT `[]` (the server is explicit). */
  candidates: unknown[] | null;
}

export function deriveGuestStage(read: GuestSessionRead): GuestStage {
  if (read.hasDraft) return "plan";
  if (read.candidates && read.candidates.length > 0) return "options";
  return "wizard";
}

/**
 * The one-generation rule, client-side (R4's "a second generation" door). The
 * server's 409 `guest_generation_used` is the authority; this is what lets the
 * wizard show a door INSTEAD of spending a call to be refused.
 *
 * Resub C5 — the server's own gate, word for word (routes/wizard.ts
 * plan-from-picks: `generationCount >= 1 || draft !== null`): one plan per
 * session, whichever path made it. Never the candidates array — a picks plan
 * writes no candidates.
 */
export function guestGenerationSpent(
  read: Pick<GuestSessionRead, "generationCount" | "hasDraft">,
): boolean {
  return read.generationCount >= 1 || read.hasDraft;
}

// ── when the wizard may open ───────────────────────────────────────────────
//
// Resub C5 — Hans's phone pass, October 7: a resumed session that had already
// made its plan (generationCount 1, a draft) reached "Build my week" and the
// server's 409 opened the sign-up sheet straight after the tap. The entry
// derived `spent` as `data ? … : false`, so until GET /guest/session answered —
// and for good if it failed — the form was a fresh visitor's form: no spent
// notice, both paths live. The rule now: the form opens only on a KNOWN read.
//
//   · "open"  — the read has data (a cached copy counts; a refetch keeps it);
//   · "retry" — the read failed for a reason other than the session being gone:
//               the client cannot know whether the plan is spent, so it says so
//               and offers the read again rather than guessing "fresh";
//   · "hold"  — in flight, or a 401 the entry is already turning into a fresh
//               session (the recovery effect), which must not flash an error.

export type GuestFormGate = "open" | "retry" | "hold";

export function guestFormGate(read: {
  hasData: boolean;
  isError: boolean;
  unauthenticated: boolean;
}): GuestFormGate {
  if (read.hasData) return "open";
  if (read.isError && !read.unauthenticated) return "retry";
  return "hold";
}
