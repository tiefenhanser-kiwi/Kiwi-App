// Row 9 (1.1) · OAuth Block 2 Part E — "a 503 hides that provider's button
// for the session and says so once" (§2.6).
//
// FOR THE SESSION, so this is module state and not React state: the sign-up
// and sign-in screens are separate components, and a person who hits the 503
// on one and then taps through to the other must not be shown the same dead
// button a second time. Module state is what "the session" means on a client
// where a relaunch is the only reset — which is the right reset, because a
// 503 means the server deploy has no keys for that provider and only a
// redeploy changes that.
//
// A tiny subscribe/notify rather than a plain Set: the screens need to
// re-render when the set changes, and `useSyncExternalStore` wants exactly
// this shape. `snapshot()` returns a STABLE array — a fresh `[...set]` on
// every read would make useSyncExternalStore loop forever.

import type { OAuthProvider } from "./providers";

const hidden = new Set<OAuthProvider>();
const listeners = new Set<() => void>();

const EMPTY: ReadonlyArray<OAuthProvider> = Object.freeze([]);
let snapshotCache: ReadonlyArray<OAuthProvider> = EMPTY;

export function hideProviderForSession(provider: OAuthProvider): void {
  if (hidden.has(provider)) return;
  hidden.add(provider);
  snapshotCache = Object.freeze([...hidden]);
  for (const l of listeners) l();
}

export function hiddenProviders(): ReadonlyArray<OAuthProvider> {
  return snapshotCache;
}

export function subscribeHiddenProviders(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. Nothing in the app calls this — a session does not un-hide. */
export function resetHiddenProviders(): void {
  hidden.clear();
  snapshotCache = EMPTY;
  for (const l of listeners) l();
}
