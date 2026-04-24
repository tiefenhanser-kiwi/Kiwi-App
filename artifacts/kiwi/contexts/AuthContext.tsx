import React from "react";

import {
  clearToken,
  fetchMe,
  loginRequest,
  logoutRequest,
  readToken,
  signupRequest,
  storeToken,
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
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // On app boot: read stored token, hit /auth/me to validate + populate user.
  React.useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const stored = await readToken();
        if (!stored) {
          if (!cancelled) setIsLoading(false);
          return;
        }
        const me = await fetchMe(stored);
        if (cancelled) return;
        if (me) {
          setToken(stored);
          setUser(me);
        } else {
          // Token invalid — clear it silently.
          await clearToken();
        }
      } catch {
        // Network error during boot — treat as unauthenticated but don't
        // clear token (might be a transient offline state).
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = React.useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const res = await loginRequest({ email, password });
      await storeToken(res.authToken);
      setToken(res.authToken);
      setUser(res.user);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      throw err;
    }
  }, []);

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
        setToken(res.authToken);
        setUser(res.user);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Signup failed";
        setError(message);
        throw err;
      }
    },
    [],
  );

  const logout = React.useCallback(async () => {
    if (token) {
      await logoutRequest(token);
    }
    await clearToken();
    setToken(null);
    setUser(null);
    setError(null);
  }, [token]);

  const clearError = React.useCallback(() => {
    setError(null);
  }, []);

  const value: AuthContextValue = {
    user,
    token,
    isAuthenticated: !!token && !!user,
    isLoading,
    error,
    login,
    signup,
    logout,
    clearError,
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
