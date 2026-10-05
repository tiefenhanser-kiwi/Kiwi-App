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
// ── STORAGE, WEB: sessionStorage, the same choice lib/auth.ts made and for the
// same reasons (D-WS9-241 E). A per-tab store survives a reload (which is what a
// resume needs) and dies with the browser session, well inside the server's
// 24 h GuestSession TTL.
//
// Every web access — including the `sessionStorage` PROPERTY READ — is wrapped:
// private-mode Safari and blocked site data throw on ACCESS, not just on write.
// A throw anywhere reads as "no guest session", and a module-level memory
// fallback keeps the flow working for that tab (and keeps the unit tests, which
// run in node with no DOM, honest).
//
// ── STORAGE, NATIVE (Resub C1): expo-secure-store, the same Keychain /
// Keystore lib/auth.ts keeps the member token in — under the guest's OWN three
// keys, so the separation above holds on a phone too. SecureStore is async and
// every read of this store is SYNCHRONOUS (lib/api/client.ts's Bearer,
// GuestContext's first render), so on native `memory` is the read path and
// SecureStore is its durable copy:
//   · hydrateGuestSession() fills `memory` from SecureStore ONCE, at boot —
//     app/_layout.tsx holds the splash until it settles, so the first guest
//     read (and therefore the first guest request) always sees it;
//   · every write and clear goes to both, memory FIRST, then SecureStore
//     through one ordered queue so a store-then-clear can never land
//     clear-then-store;
//   · a session past its expiry (lib/guest/guestSession.ts's own rule, margin
//     included) is dropped at hydration and its keys deleted — a restart the
//     next day does not resurrect a token the server has finished with.

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { guestSessionUsable } from "./guestSession";

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

// WEB: the fallback when sessionStorage is unreachable. Not a cache in front of
// it: reads prefer storage and fall back here, so the two can never disagree
// about a value storage actually holds.
// NATIVE: the read path itself, hydrated from SecureStore at boot.
let memory: GuestSessionCredentials | null = null;

function isNative(): boolean {
  return Platform.OS !== "web";
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

// ── native: the SecureStore copy ─────────────────────────────────────────

// One queue for every SecureStore write, so they land in the order they were
// made. A failed write is swallowed here: `memory` already holds the truth for
// this run, and the worst case is a session that does not survive a restart.
let nativeQueue: Promise<void> = Promise.resolve();

function enqueueNative(op: () => Promise<void>): Promise<void> {
  nativeQueue = nativeQueue.then(op).catch(() => {});
  return nativeQueue;
}

async function writeNative(creds: GuestSessionCredentials): Promise<void> {
  await SecureStore.setItemAsync(GUEST_TOKEN_KEY, creds.token);
  await SecureStore.setItemAsync(GUEST_SESSION_KEY, creds.guestSessionId);
  await SecureStore.setItemAsync(GUEST_EXPIRES_KEY, creds.expiresAt);
}

async function deleteNative(): Promise<void> {
  // allSettled, not all: one key that will not delete must not keep the other
  // two alive.
  await Promise.allSettled([
    SecureStore.deleteItemAsync(GUEST_TOKEN_KEY),
    SecureStore.deleteItemAsync(GUEST_SESSION_KEY),
    SecureStore.deleteItemAsync(GUEST_EXPIRES_KEY),
  ]);
}

/** Resolves once every SecureStore write made so far has landed. Tests await it. */
export function guestStoreSettled(): Promise<void> {
  return nativeQueue;
}

/**
 * The longest the boot waits on the Keychain. A read that has not answered by
 * then is treated as "no stored session" — a guest who loses a resume is a
 * much smaller failure than an app that never leaves its splash screen.
 */
export const GUEST_HYDRATE_DEADLINE_MS = 3_000;

let hydration: Promise<GuestSessionCredentials | null> | null = null;
let hydrated = false;

/** True once the native store has been read (always true on web). */
export function guestStoreHydrated(): boolean {
  return !isNative() || hydrated;
}

/**
 * NATIVE: read the three keys into `memory`, once. Idempotent — every caller
 * shares the first call's promise. WEB: a no-op that answers what is stored.
 *
 * A write made while the read is in flight wins over what the read returns:
 * it is newer by definition.
 */
export function hydrateGuestSession(
  nowMs: number = Date.now(),
): Promise<GuestSessionCredentials | null> {
  if (!isNative()) return Promise.resolve(readGuestSession());
  if (hydration) return hydration;
  let settled = false;
  const read = (async (): Promise<GuestSessionCredentials | null> => {
    const [token, guestSessionId, expiresAt] = await Promise.all([
      SecureStore.getItemAsync(GUEST_TOKEN_KEY),
      SecureStore.getItemAsync(GUEST_SESSION_KEY),
      SecureStore.getItemAsync(GUEST_EXPIRES_KEY),
    ]);
    if (settled) return memory;
    if (memory) return memory;
    const stored = token && guestSessionId && expiresAt ? { token, guestSessionId, expiresAt } : null;
    if (stored && guestSessionUsable(stored, nowMs)) {
      memory = stored;
    } else if (token || guestSessionId || expiresAt) {
      // Expired, half-written, or unparseable — gone either way.
      void enqueueNative(deleteNative);
    }
    return memory;
  })().catch(() => memory);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<GuestSessionCredentials | null>((resolve) => {
    timer = setTimeout(() => resolve(memory), GUEST_HYDRATE_DEADLINE_MS);
  });
  hydration = Promise.race([read, deadline]).then((result) => {
    clearTimeout(timer);
    settled = true;
    hydrated = true;
    return result;
  });
  return hydration;
}

// ── the store ────────────────────────────────────────────────────────────

export function storeGuestSession(creds: GuestSessionCredentials): void {
  memory = creds;
  if (isNative()) {
    void enqueueNative(() => writeNative(creds));
    return;
  }
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
  // Native reads the hydrated copy; see the header.
  if (isNative()) return memory;
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
 * The Bearer for a `principal: "guest"` call. Synchronous on purpose: on web it
 * is a sessionStorage property get, and on native it is the copy hydrated at
 * boot — so apiClient never awaits the Keychain on a guest call.
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
  if (isNative()) {
    void enqueueNative(deleteNative);
    return;
  }
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
