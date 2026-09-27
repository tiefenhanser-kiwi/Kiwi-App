// Row 13 "Test Kitchen" · Block 2 (D-WS9-259) — the GUEST token store.
//
// 🔴 A SEPARATE STORE, NOT A SECOND VALUE IN lib/auth.ts, AND THE SEPARATION IS
// THE WHOLE POINT. `readToken()` is what lib/api/client.ts attaches as the
// Bearer on every authenticated call and what AuthContext bootstraps from. If a
// guest token could come back from it, every one of those ~70 call sites would
// send a guest token to a `requireAuth` route, and the measured answer there is
// 401 (see below) — which fires emitSessionExpired() and evicts a visitor who
// was never signed in to begin with. So the guest token lives here, in its own
// keys, and `readToken()` can never return it.
//
// ── MEASURED, September 27 (scripts/_scratch/measure-guest-on-member.mjs) ────
// A guest token on a requireAuth route is **401, never 403**:
// middleware/auth.ts calls verifyToken(token, "session"), the guest token's
// purpose claim is "guest", the purpose check returns null, and the handler
// answers `401 { error: "invalid or expired token" }` BEFORE any database read.
// There is no 403 branch anywhere in middleware/auth.ts or guestAuth.ts.
// Consequence for this client: a guest must never *reach* a member route. The
// allowlist in lib/guest/guestRoutes.ts is that guarantee, and
// `principal: "guest"` in apiClient suppresses the cascade as a second belt.
//
// ── STORAGE: sessionStorage, the same choice lib/auth.ts made and for the same
// reasons (D-WS9-241 E). The Test Kitchen is web-only (R1), so there is no
// native branch to write; expo-secure-store is not imported here at all. A
// per-tab store survives a reload (which is what a resume needs) and dies with
// the browser session, well inside the server's 24 h GuestSession TTL.
//
// Every access — including the `sessionStorage` PROPERTY READ — is wrapped:
// private-mode Safari and blocked site data throw on ACCESS, not just on write.
// A throw anywhere reads as "no guest session", and a module-level memory
// fallback keeps the flow working for that tab (and keeps the unit tests, which
// run in node with no DOM, honest).

/** Distinct from lib/auth.ts's `kiwi_authToken`. Never read by readToken(). */
const GUEST_TOKEN_KEY = "kiwi_guestToken";
const GUEST_SESSION_KEY = "kiwi_guestSessionId";
const GUEST_EXPIRES_KEY = "kiwi_guestExpiresAt";

export interface GuestSessionCredentials {
  guestSessionId: string;
  token: string;
  /** ISO-8601, straight from POST/GET /guest/session. */
  expiresAt: string;
}

// The fallback when sessionStorage is unreachable. Not a cache in front of it:
// reads prefer storage and fall back here, so the two can never disagree about
// a value storage actually holds.
let memory: GuestSessionCredentials | null = null;

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function storeGuestSession(creds: GuestSessionCredentials): void {
  memory = creds;
  try {
    const s = storage();
    if (!s) return;
    s.setItem(GUEST_TOKEN_KEY, creds.token);
    s.setItem(GUEST_SESSION_KEY, creds.guestSessionId);
    s.setItem(GUEST_EXPIRES_KEY, creds.expiresAt);
  } catch {
    // Storage full / blocked — this tab runs on `memory` alone.
  }
}

export function readGuestSession(): GuestSessionCredentials | null {
  try {
    const s = storage();
    if (s) {
      const token = s.getItem(GUEST_TOKEN_KEY);
      const guestSessionId = s.getItem(GUEST_SESSION_KEY);
      const expiresAt = s.getItem(GUEST_EXPIRES_KEY);
      if (token && guestSessionId && expiresAt) {
        return { token, guestSessionId, expiresAt };
      }
    }
  } catch {
    // fall through to memory
  }
  return memory;
}

/**
 * The Bearer for a `principal: "guest"` call. Synchronous on purpose: the
 * user-token read is async because native SecureStore is, and there is no
 * native guest path.
 */
export function readGuestToken(): string | null {
  return readGuestSession()?.token ?? null;
}

export function readGuestSessionId(): string | null {
  return readGuestSession()?.guestSessionId ?? null;
}

/**
 * Called on a successful claim (R7) and whenever the server says the session is
 * spent (401 on a guest route, 409 guest_session_invalid at sign-up). `memory`
 * is cleared FIRST so a storage throw cannot leave a live token behind.
 */
export function clearGuestSession(): void {
  memory = null;
  try {
    const s = storage();
    if (!s) return;
    s.removeItem(GUEST_TOKEN_KEY);
    s.removeItem(GUEST_SESSION_KEY);
    s.removeItem(GUEST_EXPIRES_KEY);
  } catch {
    // Nothing to clear if storage is unreachable; `memory` already is.
  }
}
