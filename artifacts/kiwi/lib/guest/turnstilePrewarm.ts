// Resub C3 (BUG-361) — Turnstile, pre-warmed while Welcome is showing.
//
// Hans, October 6: Turnstile stays MANAGED, and the check starts while the
// welcome screen is up, so a token is usually ready before the Explore tap.
// When Cloudflare asks for interaction (the checkbox), it is shown AT THE TAP —
// by the visible gate in app/test-kitchen/index.tsx, exactly as before. The
// hidden widget is never asked to solve anything a person has to see.
// Non-interactive mode was declined: it fails instead of asking, and could
// strand a reviewer.
//
// The server rule on POST /guest/session does not move. This file only changes
// WHEN the client obtains the token it already sends.
//
// Every decision here is pure; contexts/GuestContext.tsx holds the store and
// components/TurnstilePrewarm.tsx feeds it.

/**
 * How long a pre-warmed token counts as usable. Cloudflare: "Tokens expire
 * after 300 seconds (5 minutes). Each token can only be validated once." 240 s
 * leaves a minute for the tap, the request and the server's siteverify call.
 */
export const TURNSTILE_TOKEN_FRESH_MS = 240_000;

/**
 * idle — nothing held, nothing running.
 * warming — the hidden widget is solving.
 * ready — a token is held (fresh or not: see isFreshTurnstileToken).
 * interactive — Cloudflare wants a person; the tap shows the visible gate.
 * failed — the widget errored or produced nothing in time.
 */
export type TurnstileWarmStatus = "idle" | "warming" | "ready" | "interactive" | "failed";

export interface TurnstileWarmStore {
  status: TurnstileWarmStatus;
  token: string | null;
  /** Date.now() when the token arrived. */
  issuedAt: number | null;
}

export const TURNSTILE_WARM_IDLE: TurnstileWarmStore = {
  status: "idle",
  token: null,
  issuedAt: null,
};

export type TurnstileWarmEvent =
  /** The prewarm started a widget. */
  | { type: "warm" }
  /** The widget produced a token at `at` (ms). */
  | { type: "token"; token: string; at: number }
  /** Turnstile's before-interactive-callback: it is about to show a checkbox. */
  | { type: "interactive" }
  /** The widget's own expired-callback: it re-solves by itself. */
  | { type: "expired" }
  /** The widget errored, or no token arrived in time. */
  | { type: "failed" }
  /** The Test Kitchen sent the token. Single use — it is gone either way. */
  | { type: "consume" }
  /** The token outlived TURNSTILE_TOKEN_FRESH_MS; drop it so the warm restarts. */
  | { type: "discard" };

export function turnstileWarmReducer(
  store: TurnstileWarmStore,
  event: TurnstileWarmEvent,
): TurnstileWarmStore {
  switch (event.type) {
    case "warm":
      return { status: "warming", token: null, issuedAt: null };
    case "token":
      return { status: "ready", token: event.token, issuedAt: event.at };
    case "interactive":
      // A held token is not undone by a later challenge in the same widget.
      return store.status === "ready" ? store : { status: "interactive", token: null, issuedAt: null };
    case "expired":
      return { status: "warming", token: null, issuedAt: null };
    case "failed":
      // As the visible gate's reducer: an error after a token does not undo it,
      // and an "interactive" verdict is kept — it is the more useful of the two.
      return store.status === "ready" || store.status === "interactive"
        ? store
        : { status: "failed", token: null, issuedAt: null };
    case "consume":
    case "discard":
      return TURNSTILE_WARM_IDLE;
  }
}

/** A held token, younger than TURNSTILE_TOKEN_FRESH_MS at `now`. */
export function isFreshTurnstileToken(store: TurnstileWarmStore, now: number): boolean {
  if (store.token === null || store.issuedAt === null) return false;
  return now - store.issuedAt < TURNSTILE_TOKEN_FRESH_MS;
}

/**
 * At the Explore tap (the Test Kitchen entry's first render): send the held
 * token at once, or show the visible gate as before. Only a FRESH `ready` token
 * is used; warming, interactive, failed, idle and stale all show the gate.
 */
export function decideTurnstileEntry(
  store: TurnstileWarmStore,
  now: number,
): "use_token" | "show_gate" {
  return store.status === "ready" && isFreshTurnstileToken(store, now) ? "use_token" : "show_gate";
}
