/**
 * Pub/sub bridge between the `apiClient` wrapper and `AuthContext`.
 *
 * When the wrapper receives a 401 (or readToken returns null while auth
 * is required), it calls `emitSessionExpired()`. AuthContext subscribes
 * via `subscribeSessionEvents(handler)` and clears its session state.
 *
 * The cascade is de-duplicated by an in-flight flag — many concurrent
 * 401s only fire one cascade. The flag is reset by AuthContext's handler
 * calling `resetCascade()` after token + user state have been cleared
 * (NOT by a setTimeout — the handler's `finally` block owns the lifecycle).
 *
 * Dispatch uses queueMicrotask so the cascade lands in a fresh task,
 * keeping the in-flight call's stack unwound before AuthContext mutates.
 */

type SessionEvent = "expired";
type Handler = (event: SessionEvent) => void;

let handlers: Handler[] = [];
let cascadeInFlight = false;

export function subscribeSessionEvents(h: Handler): () => void {
  handlers.push(h);
  return () => {
    handlers = handlers.filter((x) => x !== h);
  };
}

export function emitSessionExpired(): void {
  if (cascadeInFlight) return;
  cascadeInFlight = true;
  queueMicrotask(() => {
    for (const h of handlers) h("expired");
  });
}

export function resetCascade(): void {
  cascadeInFlight = false;
}

/**
 * Test-only escape hatch — drains subscribers without firing cascade.
 * Production code should never call this.
 */
export function __resetForTests(): void {
  handlers = [];
  cascadeInFlight = false;
}
