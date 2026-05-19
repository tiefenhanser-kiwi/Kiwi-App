import * as SecureStore from "expo-secure-store";
import { z } from "zod";

import { apiClient } from "@/lib/api/client";
import { UnauthenticatedError } from "@/lib/api/errors";

import type { User } from "./types";

const TOKEN_KEY = "kiwi_authToken";

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

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from the server response shapes in artifacts/api-server/src/
// routes/auth.ts (toUserShape + toSubscriptionShape). `.passthrough()` keeps
// the schema forward-compatible — extra server fields won't fail validation.

const SubscriptionSchema = z
  .object({
    status: z.string(),
    planCode: z.string(),
    trialEndsAt: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
  })
  .passthrough();

export const MeUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string().nullable(),
    zipCode: z.string().nullable(),
    timezone: z.string(),
    accountStatus: z.string(),
    subscriptionStatus: z.string(),
    defaultHouseholdSize: z.number(),
    lastPlanDiscoveryFilters: z.array(z.string()),
    lastPlansFilters: z.array(z.string()),
    lastMealsFilters: z.array(z.string()),
    subscription: SubscriptionSchema.nullable(),
    createdAt: z.string(),
  })
  .passthrough();

const MeResponseSchema = z.object({ user: MeUserSchema });

export const LoginResponseSchema = z.object({
  user: MeUserSchema,
  authToken: z.string(),
});

export const SignupResponseSchema = z.object({
  user: MeUserSchema,
  authToken: z.string(),
  onboardingRequired: z.boolean().optional(),
});

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

export async function signupRequest(input: SignupInput): Promise<AuthResponse> {
  const body = await apiClient("/auth/signup", {
    method: "POST",
    body: input,
    auth: false,
    schema: SignupResponseSchema,
  });
  return { user: body.user as User, authToken: body.authToken };
}

export async function loginRequest(input: LoginInput): Promise<AuthResponse> {
  const body = await apiClient("/auth/login", {
    method: "POST",
    body: input,
    auth: false,
    schema: LoginResponseSchema,
  });
  return { user: body.user as User, authToken: body.authToken };
}

export async function logoutRequest(): Promise<void> {
  // Server-side logout is a no-op in WS2 (returns 200). We still call it
  // so future server-side revocation work has this wire already connected.
  // "Client always wins on logout" — swallow any error (network, 401, etc.).
  try {
    await apiClient("/auth/logout", { method: "POST", parseAs: "none" });
  } catch {
    // ignore — local clearToken still happens in AuthContext.logout
  }
}

/**
 * Returns the authenticated user, or null if the stored token is invalid /
 * expired. On 401 the apiClient wrapper fires the session-expired cascade
 * (which clears local state through AuthContext); we map to null so the
 * bootstrap path stays clean.
 */
export async function fetchMe(): Promise<User | null> {
  try {
    const body = await apiClient("/auth/me", { schema: MeResponseSchema });
    return body.user as User;
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return null;
    }
    throw err;
  }
}

// ── UI state (PRD §4.2.5) ─────────────────────────────────────────────────
// PlanDiscoveryFilter is duplicated from lib/stubs.ts intentionally:
// stubs.ts is deletable when WS7 lands, and depending on it from this
// always-shipped file would be the wrong direction. WS7 consolidates.

const FILTER_KEYS = ["my_plans", "featured", "top_rated", "hosting_events"] as const;
const MEALS_FILTER_KEYS = ["my_meals", "all_meals"] as const;
export type PlanDiscoveryFilter = (typeof FILTER_KEYS)[number];
export type MealsFilter = (typeof MEALS_FILTER_KEYS)[number];

export async function patchUiState(body: {
  lastPlanDiscoveryFilters?: PlanDiscoveryFilter[];
  lastPlansFilters?: PlanDiscoveryFilter[];
  lastMealsFilters?: MealsFilter[];
}): Promise<void> {
  await apiClient("/me/ui-state", {
    method: "PATCH",
    body,
    parseAs: "none",
  });
}
