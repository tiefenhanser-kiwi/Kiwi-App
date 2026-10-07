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
  guestStoreHydrated,
  hydrateGuestSession,
  readGuestSession,
  storeGuestSession,
  type GuestSessionCredentials,
} from "@/lib/guest/guestToken";
import { deriveGuestEntryAction, type GuestEntryAction } from "@/lib/guest/guestSession";
import {
  TURNSTILE_WARM_IDLE,
  turnstileWarmReducer,
  type TurnstileWarmEvent,
  type TurnstileWarmStore,
} from "@/lib/guest/turnstilePrewarm";
import type { GuestWizardForm } from "@/lib/wizard/guestPayload";
import type { WizardPlanCandidate } from "@/lib/types";

export type GuestStatus = "idle" | "starting" | "live" | "failed";

/**
 * Row 13 Block 2 Part C — the one generation, held in memory for this tab.
 *
 * NOT the source of truth: the server persists both halves onto the
 * GuestSession row (`candidates` and `preferences`) and GET /guest/session reads
 * them back, which is what makes a reload work. This exists because that write
 * is BEST-EFFORT by design (routes/wizard.ts persistGuestGeneration — "the
 * candidates are already on the wire by the time this runs, so a failure here
 * must not sink the response"). A visitor whose persist failed would otherwise
 * watch Kiwi build three plans and then be told there were none.
 */
export interface GuestGeneration {
  candidates: WizardPlanCandidate[];
  /** The answers that produced them — the expand's candidateContext is built
   *  from these, so they must travel with the cards. */
  form: GuestWizardForm;
}

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
  /** The generation just made in this tab — see GuestGeneration. */
  generation: GuestGeneration | null;
  setGeneration: (g: GuestGeneration | null) => void;
  /**
   * Resub C3 (BUG-361) — the Turnstile token Welcome pre-warmed (native only;
   * idle forever on web and without a site key). In memory, never stored: a
   * token is single-use and dead in 300 s, so there is nothing to restore.
   * Lives HERE rather than in Welcome so it outlives Welcome's screen.
   */
  turnstile: TurnstileWarmStore;
  dispatchTurnstile: (event: TurnstileWarmEvent) => void;
}

const GuestCtx = React.createContext<GuestContextValue | null>(null);

export function GuestProvider({ children }: { children: React.ReactNode }) {
  // Seeded synchronously: a reload inside the Test Kitchen must not flash a "no
  // session" frame before the resume resolves. On web the read is a
  // sessionStorage property get; on native (Resub C1) it is the copy
  // hydrateGuestSession() loaded from SecureStore — app/_layout.tsx does not
  // mount this provider until useGuestStoreReady() says that load is done.
  const [session, setSession] = React.useState<GuestSessionCredentials | null>(
    () => readGuestSession(),
  );
  const [status, setStatus] = React.useState<GuestStatus>(() =>
    readGuestSession() ? "live" : "idle",
  );
  const [error, setError] = React.useState<Error | null>(null);
  const [generation, setGeneration] = React.useState<GuestGeneration | null>(null);
  const [turnstile, dispatchTurnstile] = React.useReducer(
    turnstileWarmReducer,
    TURNSTILE_WARM_IDLE,
  );
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
    // The plan now belongs to an account (or the session is spent). Holding the
    // cards would let a claimed visitor keep browsing the guest copy.
    setGeneration(null);
  }, []);

  const value = React.useMemo<GuestContextValue>(
    () => ({
      session,
      isGuest: session !== null,
      status,
      error,
      startOrResume,
      endGuestSession,
      generation,
      setGeneration,
      turnstile,
      dispatchTurnstile,
    }),
    [session, status, error, startOrResume, endGuestSession, generation, turnstile],
  );

  return <GuestCtx.Provider value={value}>{children}</GuestCtx.Provider>;
}

export function useGuest(): GuestContextValue {
  const ctx = React.useContext(GuestCtx);
  if (!ctx) throw new Error("useGuest must be used inside GuestProvider");
  return ctx;
}

/**
 * The non-throwing read, for code that is SHARED between the guest flow and the
 * member app and so may render in a tree without this provider.
 *
 * Two real callers, and both matter:
 *   · SessionGate, which runs above almost everything and must never be the
 *     thing that crashes a cold start;
 *   · components/WizardScreen, whose component tests render it bare (with
 *     react-test-renderer, no providers) — the strict useGuest() threw there and
 *     took 11 pre-existing tests down with it.
 *
 * Absent provider reads as "not a guest", which is the correct answer for every
 * tree that has not mounted one.
 */
export function useGuestOptional(): GuestContextValue | null {
  return React.useContext(GuestCtx);
}

export function useIsGuestSafe(): boolean {
  return React.useContext(GuestCtx)?.isGuest ?? false;
}

/**
 * Resub C1 — true once the guest store can be read synchronously: at once on
 * web, and on native after hydrateGuestSession() has read SecureStore into
 * memory (or given up at its deadline). app/_layout.tsx holds the splash screen
 * on this, beside the fonts, so GuestProvider's first render — and with it the
 * first guest request — always sees a restored session.
 */
export function useGuestStoreReady(): boolean {
  const [ready, setReady] = React.useState(guestStoreHydrated);
  React.useEffect(() => {
    if (ready) return;
    let live = true;
    void hydrateGuestSession().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}
