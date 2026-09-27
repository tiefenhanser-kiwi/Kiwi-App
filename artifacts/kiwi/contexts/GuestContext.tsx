// Row 13 "Test Kitchen" · Block 2 — the guest session, as React state.
//
// Thin by design: every DECISION is a pure function in lib/guest/ (tested), and
// this holds the credentials, the one create/resume call and the teardown. It
// sits BESIDE AuthContext, never inside it — a guest is not a degenerate user,
// and AuthContext's `user`/`token` must stay exactly as false for a guest as for
// any other signed-out visitor (see lib/guest/guestToken.ts's header).
//
// Mounted between AuthProvider and AppProvider in app/_layout.tsx so both
// SessionGate (which must not evict a guest) and the Test Kitchen screens can
// read it.

import React from "react";

import { createGuestSession } from "@/lib/api/guest";
import {
  clearGuestSession,
  readGuestSession,
  storeGuestSession,
  type GuestSessionCredentials,
} from "@/lib/guest/guestToken";
import { deriveGuestEntryAction, type GuestEntryAction } from "@/lib/guest/guestSession";

export type GuestStatus = "idle" | "starting" | "live" | "failed";

interface GuestContextValue {
  /** Non-null exactly when a guest session is live in this tab. */
  session: GuestSessionCredentials | null;
  /** What SessionGate and the guest screens ask. */
  isGuest: boolean;
  status: GuestStatus;
  /** The failure the entry screen renders. */
  error: Error | null;
  /**
   * R2 — resume an unexpired stored session, or create one. Idempotent while a
   * create is in flight (the promise is shared), so a re-render or a second
   * mount cannot mint two sessions and burn the visitor's one generation.
   *
   * Resolves with the action taken so the entry can decide where to land.
   */
  startOrResume: (opts?: { turnstileToken?: string }) => Promise<GuestEntryAction>;
  /** The claim succeeded, or the session is spent. Clears storage and state. */
  endGuestSession: () => void;
}

const GuestCtx = React.createContext<GuestContextValue | null>(null);

export function GuestProvider({ children }: { children: React.ReactNode }) {
  // Seeded synchronously from sessionStorage: a reload inside the Test Kitchen
  // must not flash a "no session" frame before the resume resolves, and the read
  // is a synchronous property get on web (there is no native guest path).
  const [session, setSession] = React.useState<GuestSessionCredentials | null>(
    () => readGuestSession(),
  );
  const [status, setStatus] = React.useState<GuestStatus>(() =>
    readGuestSession() ? "live" : "idle",
  );
  const [error, setError] = React.useState<Error | null>(null);
  // The shared in-flight create. A ref, not state: two callers in the same tick
  // must see the same promise, and a state update would not have landed yet.
  const inFlight = React.useRef<Promise<GuestEntryAction> | null>(null);

  const startOrResume = React.useCallback(
    (opts: { turnstileToken?: string } = {}): Promise<GuestEntryAction> => {
      const stored = readGuestSession();
      if (deriveGuestEntryAction(stored, Date.now()) === "resume") {
        // `stored` is non-null whenever the action is "resume".
        setSession(stored);
        setStatus("live");
        setError(null);
        return Promise.resolve<GuestEntryAction>("resume");
      }
      if (inFlight.current) return inFlight.current;
      setStatus("starting");
      setError(null);
      const promise = createGuestSession(opts)
        .then((res): GuestEntryAction => {
          const creds: GuestSessionCredentials = {
            guestSessionId: res.guestSessionId,
            token: res.token,
            expiresAt: res.expiresAt,
          };
          storeGuestSession(creds);
          setSession(creds);
          setStatus("live");
          return "create";
        })
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error("Could not start a session.");
          setError(e);
          setStatus("failed");
          throw e;
        })
        .finally(() => {
          inFlight.current = null;
        });
      inFlight.current = promise;
      return promise;
    },
    [],
  );

  const endGuestSession = React.useCallback(() => {
    clearGuestSession();
    setSession(null);
    setStatus("idle");
    setError(null);
  }, []);

  const value = React.useMemo<GuestContextValue>(
    () => ({
      session,
      isGuest: session !== null,
      status,
      error,
      startOrResume,
      endGuestSession,
    }),
    [session, status, error, startOrResume, endGuestSession],
  );

  return <GuestCtx.Provider value={value}>{children}</GuestCtx.Provider>;
}

export function useGuest(): GuestContextValue {
  const ctx = React.useContext(GuestCtx);
  if (!ctx) throw new Error("useGuest must be used inside GuestProvider");
  return ctx;
}

/**
 * SessionGate's read. Returns false rather than throwing when the provider is
 * absent, so a tree that has not adopted GuestProvider still renders — the gate
 * runs above almost everything and must never be the thing that crashes.
 */
export function useIsGuestSafe(): boolean {
  return React.useContext(GuestCtx)?.isGuest ?? false;
}
