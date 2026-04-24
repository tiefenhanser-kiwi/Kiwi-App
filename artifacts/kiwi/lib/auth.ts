import * as SecureStore from "expo-secure-store";

import type { User } from "./types";

const TOKEN_KEY = "kiwi:authToken";

// ── Token storage ─────────────────────────────────────────────────────────

export async function storeToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function readToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ── API base URL (duplicated from lib/api.ts for now; consolidate in WS7) ─

const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api";

// ── Auth API calls ────────────────────────────────────────────────────────

export interface AuthResponse {
  user: User;
  authToken: string;
}

export interface SignupInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  zipCode?: string;
  timezone?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

async function parseAuthError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export async function signupRequest(input: SignupInput): Promise<AuthResponse> {
  const res = await fetch(`${apiBase}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await parseAuthError(res));
  }
  return (await res.json()) as AuthResponse;
}

export async function loginRequest(input: LoginInput): Promise<AuthResponse> {
  const res = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await parseAuthError(res));
  }
  return (await res.json()) as AuthResponse;
}

export async function logoutRequest(token: string): Promise<void> {
  // Server-side logout is a no-op in WS2 (returns 200). We still call it
  // so future server-side revocation work has this wire already connected.
  await fetch(`${apiBase}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {
    // Network error on logout — proceed anyway. Client always wins on logout.
  });
}

export async function fetchMe(token: string): Promise<User | null> {
  const res = await fetch(`${apiBase}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    return null; // Token invalid/expired — caller should clear it.
  }
  if (!res.ok) {
    throw new Error(await parseAuthError(res));
  }
  const body = (await res.json()) as { user: User };
  return body.user;
}
