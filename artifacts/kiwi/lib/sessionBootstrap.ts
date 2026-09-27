// D-WS9-241 B (BUG-258) — the cold-start bootstrap's outcome, as data.
//
// Before this, the bootstrap had exactly two observable states (loading /
// not loading) and three ways to get stuck: /auth/me hanging → blank forever;
// /auth/me throwing → user null with isLoading false, which every route read
// as "signed out" and bounced; readToken() rejecting → the storage-read
// effect never completed → blank forever. Each is a *different* failure with
// the same symptom, and none of them was a 401.
//
// The pure derivations live here, outside app/** (which the test glob
// excludes, D-WS9-164), so the three branches and the SessionGate's
// non-eviction are unit-tested at this seam. AuthContext computes
// `bootstrapStatus` with deriveBootstrapStatus(); app/_layout.tsx's
// SessionGate asks sessionGateShouldEvict() before it touches the router.

/** /auth/me at bootstrap runs under this AbortController deadline. Ruled 10s.
 *  It is end-to-end ONLY because useAuthMe pins `retry: false` — a default
 *  react-query retry policy (3× exponential) would turn this into 40s+. */
export const BOOTSTRAP_DEADLINE_MS = 10_000;

export type BootstrapStatus = "pending" | "ok" | "failed";

export interface BootstrapInputs {
  /** The one-time token read has completed (resolved OR rejected). */
  storageRead: boolean;
  /** Token currently in React state — null after a 401 cascade / logout. */
  token: string | null;
  /** useAuthMe has ever produced a value. `null` (the 401 → fetchMe mapping)
   *  counts: the cascade is already clearing the token on that path. */
  hasMeData: boolean;
  /** useAuthMe's last settled outcome was a throw (abort / network / 5xx /
   *  schema). react-query holds this until the next resolution, so a retry
   *  in flight still reads as failed — which keeps the failure screen mounted
   *  (with its own busy state) instead of dropping to a blank navigator. */
  meIsError: boolean;
}

export function deriveBootstrapStatus(i: BootstrapInputs): BootstrapStatus {
  if (!i.storageRead) return "pending";
  // No token → nothing to bootstrap: Welcome. This is also where a
  // readToken() rejection lands (AuthContext treats it as "no token").
  if (!i.token) return "ok";
  if (i.hasMeData) return "ok";
  if (i.meIsError) return "failed";
  return "pending";
}

export interface SessionGateInputs {
  bootstrapStatus: BootstrapStatus;
  hasUser: boolean;
  /** `useSegments()[0]` — undefined at "/", "(auth)" inside the auth group. */
  group: string | undefined;
  /**
   * Row 13 "Test Kitchen" · Block 2 — a guest session is live in this tab.
   *
   * 🔴 WITHOUT THIS THE TEST KITCHEN COULD NOT EXIST. `/test-kitchen` is a
   * top-level route, so `useSegments()[0]` is "test-kitchen" — not undefined and
   * not "(auth)". A visitor there has no token, so bootstrapStatus is "ok" and
   * hasUser is false: the exact shape this gate evicts. It would have replaced
   * the guest wizard with sign-in the moment the screen mounted.
   *
   * A guest is NEITHER evicted NOR signed in: `hasUser` stays false (index.tsx
   * still sends a tokenless visit to Welcome, every member route still guards),
   * and only the eviction is suppressed. Optional so every existing caller and
   * every existing test keeps its meaning.
   */
  isGuest?: boolean;
}

/**
 * WS9 BUG-239's route reaction to a dead session, minus the router call.
 * Returns true when SessionGate should `router.replace("/(auth)/sign-in")`.
 *
 * `failed` returns false: the token is KEPT on a bootstrap failure, so `user`
 * is null with the bootstrap no longer pending — exactly the shape a dead
 * session has. Without this branch a cold start on a deep link (or on
 * "(tabs)") during an outage would be evicted to sign-in instead of seeing
 * the failure screen.
 */
export function sessionGateShouldEvict(i: SessionGateInputs): boolean {
  // Bootstrap has not resolved yet — "no user" is not yet meaningful.
  if (i.bootstrapStatus === "pending") return false;
  // The failure screen owns this state; the router must not move.
  if (i.bootstrapStatus === "failed") return false;
  if (i.hasUser) return false;
  // Row 13 Block 2 — a live guest session owns its own routes. See isGuest.
  if (i.isGuest) return false;
  // undefined = "/" (index.tsx owns the cold-start decision itself, and
  // bouncing it here would race its Redirect). "(auth)" = already where a
  // signed-out user belongs; redirecting from there would also throw a user
  // off the sign-in screen the moment a wrong password 401s.
  if (i.group === undefined || i.group === "(auth)") return false;
  return true;
}
