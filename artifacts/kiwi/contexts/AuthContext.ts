import { useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Platform } from "react-native";

import { resetCascade, subscribeSessionEvents } from "@/lib/api/auth-bridge";
import { useAuthMe } from "@/lib/api/auth";
import {
  clearToken,
  loginRequest,
  logoutRequest,
  patchUiState,
  readToken,
  signupRequest,
  storeToken,
  type MealsFilter,
  type PlanDiscoveryFilter,
} from "@/lib/auth";
import {
  deriveBootstrapStatus,
  type BootstrapStatus,
} from "@/lib/sessionBootstrap";
import { authErrorPresentation } from "@/lib/authErrorCopy";
import { completeAuth, type AuthCompletionDeps } from "@/lib/authCompletion";
import { appleOAuthRequest, googleOAuthRequest, type OAuthAuthResponse } from "@/lib/oauth/api";
import { isProviderUnavailable } from "@/lib/oauth/errors";
import {
  appleRequestBody,
  googleRequestBody,
  type AppleCredential,
  type OAuthConsentFields,
  type OAuthContext,
  type OAuthMode,
} from "@/lib/oauth/request";
import type { OAuthProvider } from "@/lib/oauth/providers";
import { hideProviderForSession } from "@/lib/oauth/unavailable";
import { todayLocalDate } from "@/lib/dates";
import { clearGuestSession, readGuestSessionId } from "@/lib/guest/guestToken";
import type { AuthResponse } from "@/lib/auth";
import type { User } from "@/lib/types";

export interface SignupOptions {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  /** Empty / whitespace-only is sent as undefined (no phone). */
  phone?: string;
  marketingConsentEmail?: boolean;
  marketingConsentSms?: boolean;
}

/**
 * Row 9 (1.1) · OAuth Block 2 — what a screen hands over after a provider
 * sheet closes successfully.
 *
 * `mode` is the SCREEN, not the outcome: whether this was a first sign-in is
 * the server’s answer (`isNewUser`), and it arrives after the body has already
 * been built. All the mode decides is whether the consent checkboxes
 * contribute — see lib/oauth/request.ts (§2.4).
 */
export interface OAuthSignInInput {
  provider: OAuthProvider;
  mode: OAuthMode;
  /** Apple: identityToken + the RAW nonce (+ authorizationCode). Google: idToken. */
  credential: AppleCredential | { idToken: string };
  /** Apple hands these over on the FIRST authorisation only. Forward them. */
  firstName?: string | null;
  lastName?: string | null;
  /** Sign-up screen only; ignored when `mode === "signin"`. */
  consents?: OAuthConsentFields;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /** `bootstrapStatus === "pending"`. Kept for the route gates that read it. */
  isLoading: boolean;
  /** D-WS9-241 B (BUG-258) — the cold-start outcome. `failed` means /auth/me
   *  timed out / errored / 5xx'd with a token in hand: the token is KEPT, the
   *  root layout renders the failure screen, and SessionGate does not evict.
   *  A 401 is NOT a failure — it clears the token through the cascade and
   *  reads as `ok` with no user, exactly as before. */
  bootstrapStatus: BootstrapStatus;
  /** Re-runs /auth/me under the deadline. Resolves when it settles either
   *  way; read `bootstrapStatus` for the outcome. */
  retryBootstrap: () => Promise<void>;
  /** The failure screen's "Sign out": local teardown with NO server call
   *  (the server is unreachable by definition here), no message → Welcome. */
  abandonBootstrap: () => Promise<void>;
  error: string | null;
  /** Row 13 Block 2 Part E — resolves with the claim fields (R7) so the screen
   *  can decide where to land and what to say. */
  login: (email: string, password: string) => Promise<AuthResponse>;
  /** D-WS9-241 A (BUG-261) — an options object (was 4 positionals): phone
   *  and both consents ride the same create as the account. Timezone is
   *  auto-detected here, not passed; Row 13 Block 2 Part E adds `platform`
   *  (R9, every sign-up) and the guest claim, both read here rather than
   *  passed. Resolves with the claim fields so the screen can decide where to
   *  land and what to say. */
  signup: (input: SignupOptions) => Promise<AuthResponse>;
  /** Row 9 (1.1) · OAuth Block 2 — completeAuth’s third and fourth callers
   *  (§2.5). Resolves with the signup/login shape plus `isNewUser`. On a
   *  dismissed sheet it REJECTS without setting `error` — §2.6: a cancel is
   *  not a failure, so the caller simply stops its spinner. */
  oauthSignIn: (input: OAuthSignInInput) => Promise<OAuthAuthResponse>;
  logout: () => Promise<void>;
  /** WS9 BUG-239 §1c — end THIS client's session because we already know the
   *  token is dead, rather than waiting for the next request to discover it.
   *  Used after a successful password change: BUG-234 bumps the server-side
   *  revocation epoch, so the bearer token in hand is void the instant the
   *  200 comes back. Same local teardown as logout() but with NO server call
   *  (there is nothing to revoke, and POSTing with the dead token would 401
   *  and cascade a misleading "your session expired"). `message` surfaces on
   *  the sign-in screen. */
  endSession: (message: string) => Promise<void>;
  clearError: () => void;
  setUiState: (updates: {
    lastPlanDiscoveryFilters?: PlanDiscoveryFilter[];
    lastPlansFilters?: PlanDiscoveryFilter[];
    lastMealsFilters?: MealsFilter[];
  }) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

// Platform.OS is "web" | "ios" | "android" on every build this app produces;
// the cast is only because RN’s type also admits "windows" and "macos",
// which Expo does not target here. R9 / D-WS9-264 — sent on every account
// creation, password or social, and recorded server-side as signupSource.
function devicePlatform(): "web" | "ios" | "android" {
  return Platform.OS as "web" | "ios" | "android";
}

/** Auto-detected, never passed in. If Intl fails the server default applies. */
function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

const ME_KEY = ["auth", "me"] as const;

export function AuthProvider({
  children,
  bootstrapDeadlineMs,
}: {
  children: React.ReactNode;
  /** Test seam only — production leaves it unset (BOOTSTRAP_DEADLINE_MS). */
  bootstrapDeadlineMs?: number;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = React.useState<string | null>(null);
  // `storageRead` distinguishes "still reading SecureStore" (which is async
  // on every cold start) from "no token present". useAuthMe's `enabled`
  // flag covers the second half.
  const [storageRead, setStorageRead] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const uiStateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const meQuery = useAuthMe(token, { deadlineMs: bootstrapDeadlineMs });
  const user = meQuery.data ?? null;
  // D-WS9-241 B — see lib/sessionBootstrap.ts for the derivation and why a
  // react-query error with a token still in hand is "failed", not "signed
  // out". `data !== undefined` (rather than `user !== null`) is deliberate:
  // the 401 → null mapping in fetchMe is a *resolution*, and the cascade is
  // already clearing the token on that path.
  const bootstrapStatus = deriveBootstrapStatus({
    storageRead,
    token,
    hasMeData: meQuery.data !== undefined,
    meIsError: meQuery.isError,
  });
  const isBootstrapping = bootstrapStatus === "pending";

  // One-time SecureStore read on mount. When a stored token is present,
  // place it in React state so useAuthMe's `enabled` flips and the
  // /auth/me query fires.
  //
  // D-WS9-241 B — readToken() rejecting is caught and treated as "no token".
  // Before this, a rejection here meant setStorageRead(true) never ran and
  // the app sat on a blank screen forever (the third bootstrap failure path;
  // exactly what expo-secure-store's throwing web stub produced before E).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: string | null = null;
      try {
        stored = await readToken();
      } catch (err) {
        console.warn("readToken failed at bootstrap; treating as signed out:", err);
      }
      if (cancelled) return;
      if (stored) setToken(stored);
      setStorageRead(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // D-WS9-241 B — the failure screen's two actions.
  const refetchMe = meQuery.refetch;
  const retryBootstrap = React.useCallback(async () => {
    // refetch() resolves when the attempt settles; it never throws (the
    // outcome lands on meQuery.isError / .data, which drive bootstrapStatus).
    await refetchMe();
  }, [refetchMe]);

  const abandonBootstrap = React.useCallback(async () => {
    await queryClient.cancelQueries();
    await clearToken();
    queryClient.removeQueries({ queryKey: ["auth"] });
    setToken(null);
    setError(null);
  }, [queryClient]);

  // Subscribe to the apiClient 401 cascade. Any 401 (or missing-token call
  // with auth required) anywhere in the app fires `emitSessionExpired()`;
  // this handler clears local session state and resets the cascade flag so
  // a subsequent expiry can fire again. Idempotent against already-cleared
  // state — bootstrap-time 401s use this same path.
  React.useEffect(() => {
    return subscribeSessionEvents(async (event) => {
      if (event !== "expired") return;
      try {
        await clearToken();
        queryClient.removeQueries({ queryKey: ["auth"] });
        setToken(null);
        setError("Your session expired. Please sign in again.");
      } finally {
        resetCascade();
      }
    });
  }, [queryClient]);

  // WS7-2-E Bug 7: clear any pending setUiState debounce when the provider
  // unmounts, so the timer can't fire patchUiState after teardown (same
  // class of leak logout() guards against — a timer outliving its session).
  React.useEffect(() => {
    return () => {
      if (uiStateTimerRef.current) {
        clearTimeout(uiStateTimerRef.current);
        uiStateTimerRef.current = null;
      }
    };
  }, []);

  // ── Row 9 (1.1) · OAuth Block 2 Part B — the shared completion (§2.5) ───
  //
  // The eight steps that used to be written out inside login() and signup()
  // now live in lib/authCompletion.ts, and these are the two things only the
  // provider can do: put the token in React state, and seed the /auth/me
  // cache so the very next render has a user without a round trip.
  const adoptSession = React.useCallback(
    (res: AuthResponse) => {
      queryClient.setQueryData<User | null>(ME_KEY, res.user);
      setToken(res.authToken);
    },
    [queryClient],
  );

  const completionDeps = React.useMemo<AuthCompletionDeps>(
    () => ({
      // Read from the guest store rather than passed in by a screen: the
      // sign-up screen is reachable from the door sheet, from Welcome and from
      // a URL, and the live guest session is the same fact in all three.
      readGuestSessionId: () => readGuestSessionId(),
      clearGuestSession,
      todayLocalDate,
      storeToken,
      adoptSession,
    }),
    [adoptSession],
  );

  const login = React.useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        // Row 13 Block 2 Part E (R7) — a returning visitor claims too: they
        // walked the Test Kitchen, liked the plan, and turn out to already
        // have an account. The server does the same claim minus the
        // preferences copy, so their stored preferences are never overwritten
        // by a guest form. Also the RETRY path: a sign-up whose stage 2 failed
        // kept the guestSessionId (claimRetryable), and this is the next
        // sign-in that finishes it.
        //
        // `resendWithoutClaimOn409: false` — see lib/authCompletion.ts. Login
        // cannot 409 today; if it ever does it means something this code has
        // not been told about, and retrying it without the claim would turn an
        // unknown refusal into a second sign-in.
        return await completeAuth(
          (claim) => loginRequest({ email, password, ...claim }),
          completionDeps,
          { resendWithoutClaimOn409: false },
        );
      } catch (err) {
        // BUG-296 — the screen renders `error`; the 429 / 400 copy is decided
        // in one place (lib/authErrorCopy.ts), not off the server's string.
        setError(authErrorPresentation(err, "Login failed").message);
        throw err;
      }
    },
    [completionDeps],
  );

  const signup = React.useCallback(
    async (input: SignupOptions) => {
      setError(null);
      try {
        // D-WS9-241 A — phone + consents go on the same write. An empty phone
        // is "no phone" (undefined, not ""), and SMS consent is only ever
        // sent alongside a phone: the server refuses the pairing (400), the
        // form already clears it, and this is the wire-level guarantee.
        const phone = input.phone?.trim() || undefined;
        const base = {
          email: input.email,
          password: input.password,
          firstName: input.firstName,
          lastName: input.lastName,
          timezone: deviceTimezone(),
          phone,
          marketingConsentEmail: input.marketingConsentEmail,
          marketingConsentSms: phone ? input.marketingConsentSms : undefined,
          // R9 / D-WS9-264 — `platform` on EVERY sign-up, native included. The
          // server records it as signupSource, and a guestSessionId on the body
          // overrides it with "test_kitchen" because that is the more specific
          // fact.
          platform: devicePlatform(),
        };
        return await completeAuth(
          (claim) => signupRequest({ ...base, ...claim }),
          completionDeps,
          { resendWithoutClaimOn409: true },
        );
      } catch (err) {
        setError(authErrorPresentation(err, "Signup failed").message);
        throw err;
      }
    },
    [completionDeps],
  );

  // ── Row 9 (1.1) · OAuth Block 2 — the third and fourth callers (§2.5) ───
  //
  // One method for both providers, because past the credential there is no
  // difference: the same claim, the same token storage, the same routing.
  // The credential is the caller's — a native sheet, a web popup or a Google
  // Identity Services callback produced it, and none of those can live in a
  // context that also has to load under `node --test`.
  //
  // 🔴 A FIRST SIGN-IN IS A SIGN-UP, which is why `resendWithoutClaimOn409`
  // is true on BOTH modes. The server's 409 rolls the account creation back
  // exactly as the password sign-up's does, and it can land on a tap made
  // from the sign-IN screen.
  const oauthSignIn = React.useCallback(
    async (input: OAuthSignInInput) => {
      setError(null);
      const { provider, mode } = input;
      const ctx: OAuthContext = {
        mode,
        platform: devicePlatform(),
        timezone: deviceTimezone(),
        firstName: input.firstName,
        lastName: input.lastName,
        consents: input.consents,
      };
      try {
        return await completeAuth<OAuthAuthResponse>(
          (claim) =>
            provider === "apple"
              ? appleOAuthRequest(
                  appleRequestBody(input.credential as AppleCredential, { ...ctx, claim }),
                )
              : googleOAuthRequest(
                  googleRequestBody(input.credential as { idToken: string }, {
                    ...ctx,
                    claim,
                  }),
                ),
          completionDeps,
          { resendWithoutClaimOn409: true },
        );
      } catch (err) {
        // §2.6 — the 503 hide is SESSION state, so it has to land here
        // whoever ends up catching: a provider that answered oauth_unavailable
        // is gone for the rest of the session, on both screens.
        //
        // The MESSAGE deliberately does NOT land here. A provider sheet can
        // also fail BEFORE this function is reached (a dismissed Apple sheet
        // never produces a request at all), so the copy has exactly one owner
        // — components/oauth/SocialSignInBlock.tsx, which renders it under the
        // buttons that produced it — and a cancel sets nothing anywhere.
        if (isProviderUnavailable(err)) hideProviderForSession(provider);
        throw err;
      }
    },
    [completionDeps],
  );

  const logout = React.useCallback(async () => {
    // WS7-2-E Bug 7: tear down pending async work BEFORE clearing the token.
    // The setUiState debounce timer captures `token` in its closure; if it
    // fires after logout it PATCHes /me/ui-state with a now-cleared token,
    // the server 401s, the apiClient cascade fires emitSessionExpired(), and
    // the very next login surfaces a spurious "session expired". Clearing the
    // pending timer + cancelling in-flight queries here closes that race.
    // The timer-clear alone is sufficient, so the setUiState guard is left
    // reading its closure-captured token (no live-state rework needed).
    if (uiStateTimerRef.current) {
      clearTimeout(uiStateTimerRef.current);
      uiStateTimerRef.current = null;
    }
    await queryClient.cancelQueries();
    if (token) {
      await logoutRequest();
    }
    await clearToken();
    // D-WS9-257 — CLEAR EVERYTHING, not just ["auth"].
    //
    // removeQueries({ queryKey: ["auth"] }) dropped the session but left the
    // plans, meals, home and grocery caches sitting in memory. Sign out, hand
    // the phone over, sign in as someone else, and the previous account's rows
    // render from cache until each query refetches. That was a standing carried
    // item; deletion made it unacceptable rather than untidy — a deleted user's
    // rows must not survive anywhere, including in memory on the device they
    // were deleted from.
    //
    // clear() is what a fresh launch looks like. Nothing pre-auth reads a
    // cached query, so there is nothing to preserve.
    queryClient.clear();
    setToken(null);
    setError(null);
  }, [token, queryClient]);

  // WS9 BUG-239 §1c — see the interface note. Deliberately mirrors logout()
  // minus logoutRequest(), including the uiState timer teardown: a pending
  // debounced PATCH firing after this would 401 on the dead token, fire the
  // cascade, and overwrite `message` with the generic expiry text.
  const endSession = React.useCallback(
    async (message: string) => {
      if (uiStateTimerRef.current) {
        clearTimeout(uiStateTimerRef.current);
        uiStateTimerRef.current = null;
      }
      await queryClient.cancelQueries();
      await clearToken();
      // D-WS9-257 — the same clear as logout() above, for the same reason.
      // This function's whole contract is "mirrors logout() minus
      // logoutRequest()", so leaving the narrow removeQueries here would break
      // that invariant AND leave the identical cross-account cache leak on the
      // expiry path, which is the one a user does not choose.
      queryClient.clear();
      setToken(null);
      setError(message);
    },
    [queryClient],
  );

  const clearError = React.useCallback(() => {
    setError(null);
  }, []);

  // Optimistic local update + debounced server sync. UI updates immediately
  // (snappy chip toggles); the PATCH lands ~400ms after the user stops
  // poking. Per D-WS3-007 we don't roll back on server failure — the user's
  // local state stays where they put it and a future retry layer (WS9+)
  // can reconcile.
  const setUiState = React.useCallback(
    (updates: {
      lastPlanDiscoveryFilters?: PlanDiscoveryFilter[];
      lastPlansFilters?: PlanDiscoveryFilter[];
      lastMealsFilters?: MealsFilter[];
    }) => {
      queryClient.setQueryData<User | null>(ME_KEY, (prev) =>
        prev ? { ...prev, ...updates } : prev,
      );

      if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
      uiStateTimerRef.current = setTimeout(() => {
        uiStateTimerRef.current = null;
        if (!token) return;
        patchUiState(updates).catch((err) => {
          console.warn("patchUiState sync failed:", err);
        });
      }, 400);
    },
    [token, queryClient],
  );

  const value: AuthContextValue = {
    user,
    token,
    isAuthenticated: !!token && !!user,
    isLoading: isBootstrapping,
    bootstrapStatus,
    retryBootstrap,
    abandonBootstrap,
    error,
    login,
    signup,
    oauthSignIn,
    logout,
    endSession,
    clearError,
    setUiState,
  };

  // No JSX in this file — the test runner (`node --experimental-strip-types`)
  // strips TS types but does not transform JSX. Using React.createElement
  // keeps AuthContext loadable from the node:test infra without adding a
  // JSX-aware transformer to the loader.
  return React.createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
