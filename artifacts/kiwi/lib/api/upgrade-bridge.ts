// Row 9 (1.1) · Stripe S2 Part D — 402, HANDLED ONCE.
//
// The same shape as auth-bridge.ts, for the same reason: `apiClient` cannot
// import a React context, and every screen handling its own 402 is how twenty
// screens end up with twenty slightly different upgrade prompts. So the wrapper
// announces, and BillingProvider listens.
//
// 🔴 §2.7's RULE IS "ONCE", AND ONCE MEANS ONE PLACE, NOT ONE TIME. There is
// deliberately NO in-flight latch here, which is the one way this differs from
// the 401 cascade. That latch exists because the cascade TEARS DOWN a session —
// clearing a token twice is a race worth preventing. Opening a sheet is
// idempotent: the subscriber sets a state value, and setting it to the same
// value twice is nothing. A latch would instead need resetting by whoever closed
// the sheet, and a latch nobody reset is a paywall that never opens again.
//
// Dispatch goes through queueMicrotask so the sheet opens in a fresh task, with
// the failed call's stack already unwound — a subscriber that re-rendered the
// screen mid-throw would be re-entering React from inside a rejection.

/** What the wrapper saw. For the log line §2.7 asks for, not for the copy. */
export interface UpgradeRequiredEvent {
  /** The path that was refused, so an unexpected 402 can be traced. */
  path: string;
  /** The parsed error body, which carries the server's `code` and `reason`. */
  body: unknown;
}

type Handler = (event: UpgradeRequiredEvent) => void;

let handlers: Handler[] = [];

export function subscribeUpgradeEvents(h: Handler): () => void {
  handlers.push(h);
  return () => {
    handlers = handlers.filter((x) => x !== h);
  };
}

export function emitUpgradeRequired(event: UpgradeRequiredEvent): void {
  queueMicrotask(() => {
    for (const h of handlers) {
      // Each subscriber owns its own error policy; a rejection that escaped here
      // would surface as an unhandled rejection and, in strict mode, take the
      // process with it. Same guard as auth-bridge's.
      try {
        const result = h(event) as unknown;
        if (result && typeof (result as { then?: unknown }).then === "function") {
          (result as Promise<unknown>).catch(() => {});
        }
      } catch {
        // A throwing subscriber must not stop the others being told.
      }
    }
  });
}

/** Test-only: drains subscribers. Production code never calls this. */
export function __resetForTests(): void {
  handlers = [];
}
