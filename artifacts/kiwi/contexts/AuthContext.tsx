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
import type { User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (
    email: string,
    password: string,
    firstName: string,
    lastName: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  setUiState: (updates: {
    lastPlanDiscoveryFilters?: PlanDiscoveryFilter[];
    lastPlansFilters?: PlanDiscoveryFilter[];
    lastMealsFilters?: MealsFilter[];
  }) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

const ME_KEY = ["auth", "me"] as const;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = React.useState<string | null>(null);
  // `storageRead` distinguishes "still reading SecureStore" (which is async
  // on every cold start) from "no token present". useAuthMe's `enabled`
  // flag covers the second half — the meQuery's `isLoading` is only true
  // while an active fetch is in flight.
  const [storageRead, setStorageRead] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const uiStateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const meQuery = useAuthMe(token);
  const user = meQuery.data ?? null;
  const isBootstrapping = !storageRead || (!!token && meQuery.isLoading);

  // One-time SecureStore read on mount. When a stored token is present,
  // place it in React state so useAuthMe's `enabled` flips and the
  // /auth/me query fires.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await readToken();
      if (cancelled) return;
      if (stored) setToken(stored);
      setStorageRead(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    async (
      email: string,
      password: string,
      firstName: string,
      lastName: string,
    ) => {
      setError(null);
      try {
        // Auto-detect timezone from device.
        let timezone: string | undefined;
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          // If Intl fails (shouldn't on modern RN), let server default apply.
        }
        const res = await signupRequest({
          email,
          password,
          firstName,
          lastName,
          timezone,
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
    if (token) {
      await logoutRequest();
    }
    await clearToken();
    queryClient.removeQueries({ queryKey: ["auth"] });
    setToken(null);
    setError(null);
  }, [token, queryClient]);

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
    error,
    login,
    signup,
    logout,
    clearError,
    setUiState,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
