import { useQueryClient } from "@tanstack/react-query";
import React from "react";

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
  login: (email: string, password: string) => Promise<void>;
  /** D-WS9-241 A (BUG-261) — an options object (was 4 positionals): phone
   *  and both consents ride the same create as the account. Timezone is
   *  auto-detected here, not passed. */
  signup: (input: SignupOptions) => Promise<void>;
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

  const login = React.useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const res = await loginRequest({ email, password });
        await storeToken(res.authToken);
        queryClient.setQueryData<User | null>(ME_KEY, res.user);
        setToken(res.authToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Login failed";
        setError(message);
        throw err;
      }
    },
    [queryClient],
  );

  const signup = React.useCallback(
    async (input: SignupOptions) => {
      setError(null);
      try {
        // Auto-detect timezone from device.
        let timezone: string | undefined;
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          // If Intl fails (shouldn't on modern RN), let server default apply.
        }
        // D-WS9-241 A — phone + consents go on the same write. An empty phone
        // is "no phone" (undefined, not ""), and SMS consent is only ever
        // sent alongside a phone: the server refuses the pairing (400), the
        // form already clears it, and this is the wire-level guarantee.
        const phone = input.phone?.trim() || undefined;
        const res = await signupRequest({
          email: input.email,
          password: input.password,
          firstName: input.firstName,
          lastName: input.lastName,
          timezone,
          phone,
          marketingConsentEmail: input.marketingConsentEmail,
          marketingConsentSms: phone ? input.marketingConsentSms : undefined,
        });
        await storeToken(res.authToken);
        queryClient.setQueryData<User | null>(ME_KEY, res.user);
        setToken(res.authToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Signup failed";
        setError(message);
        throw err;
      }
    },
    [queryClient],
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
    queryClient.removeQueries({ queryKey: ["auth"] });
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
      queryClient.removeQueries({ queryKey: ["auth"] });
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
