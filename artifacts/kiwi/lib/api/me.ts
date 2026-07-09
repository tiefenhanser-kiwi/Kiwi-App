// Mobile client for the WS7-2 Block A `/me/*` account routes.
//
// One typed wrapper per endpoint, each validating its response with Zod
// (universal-validation convention — see lib/api/client.ts header). Schemas
// and paths here are transcribed from the real server route file
// artifacts/api-server/src/routes/me.ts — NOT from the Block B prompt
// template, which predated that file. Divergences resolved in the Phase 2
// clarifier (items 1-8): no `weeklyPacing`, nullable fields use `.nullable()`,
// `{ preferences }` / `{ user }` response envelopes, `verify-change` path,
// `requestEmailChange` takes only `newEmail`, `deactivate` takes no body,
// `reactivate` is public + returns an authToken, and `patchProfile`'s
// response omits `subscription` (separate ProfileUserSchema).

import { z } from "zod";

import { MeUserSchema, storeToken } from "../auth";
import type { User } from "../types";
import { apiClient } from "./client";

// ── Preferences schema ─────────────────────────────────────────────────────
// Mirrors the full mobile UserPreferencesData contract (lib/types.ts) — every
// field the preferences + onboarding screens read or edit. Plain z.object()
// strips genuinely server-only columns that GET /me/preferences also returns:
// id, userId, difficultyDefault, weeklyPacingDefault, breakfastDefaults,
// lunchDefaults, macroPref, notificationsEnabled, lastUsedRetailerId,
// updatedAt. The four String? columns send explicit JSON null → `.nullable()`.
//
// WS7-2 Block C Commit 3: householdSize / wantsLeftovers / pickyAvoidances
// were mis-classified as server-only in Block B Commit 2 — they are mobile-
// editable (preferences.tsx Section 1 + PickyEatersPicker) and the server
// both returns and accepts them. Added here so getPreferences() yields a
// complete UserPreferencesData.

export const UserPreferencesSchema = z.object({
  // Single-select enums — server has defaults, always present.
  spiceTolerance: z.enum(["mild", "medium", "hot", "very_hot"]),
  budgetLevel: z.enum(["economy", "mid_range", "premium"]),
  // Nullable single-selects — Prisma String?, server sends explicit null.
  cookingSkill: z.enum(["beginner", "intermediate", "advanced"]).nullable(),
  stovetopType: z.enum(["gas", "induction", "electric"]).nullable(),
  defaultRetailer: z.string().nullable(),
  // Multi-select arrays.
  cuisines: z.array(z.string()),
  allergiesAndAvoidances: z.array(z.string()),
  cookingEquipment: z.array(z.string()),
  recurringGroceryItems: z.array(z.string()),
  eatingStyles: z.array(z.string()),
  healthGoals: z.array(z.string()),
  pickyAvoidances: z.array(z.string()),
  // Numeric.
  householdSize: z.number().int().positive(),
  kidsCount: z.number().int().nonnegative(),
  pickyEaterCount: z.number().int().nonnegative(),
  planLengthDefault: z.number().int().positive(),
  // Boolean.
  wantsLeftovers: z.boolean(),
  // Free-text notes — nullable.
  dietaryNotes: z.string().nullable(),
  // Cookbook Phase B Block 1 — new stored prefs. Enums have server defaults so
  // they are always present; maxCookTimeMinutes is Prisma Int? → explicit null.
  discoveryMealsPerWeek: z.number().int(),
  saucePreference: z.enum(["store_bought", "balanced", "homemade"]),
  maxCookTimeMinutes: z.number().int().nullable(),
  maxCookTimeCoverage: z.enum(["all", "most"]),
});

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

// PATCH /me/profile's `select` omits `subscription` (routes/me.ts) — so the
// full MeUserSchema can't validate that response. ProfileUserSchema is
// MeUserSchema minus `subscription`; the patched user is field-merged into
// the auth cache, so the cached `subscription` survives untouched.
const ProfileUserSchema = MeUserSchema.omit({ subscription: true });

/** User shape returned by PATCH /me/profile — same as `User` minus subscription. */
export type ProfileUser = Omit<User, "subscription">;

// ── Response envelopes ─────────────────────────────────────────────────────

const PreferencesEnvelopeSchema = z.object({
  preferences: UserPreferencesSchema,
});
const ProfileEnvelopeSchema = z.object({ user: ProfileUserSchema });
const SuccessSchema = z.object({ success: z.boolean() });
const VerifyEmailChangeSchema = z.object({
  success: z.boolean(),
  email: z.string(),
});
const ReactivateResponseSchema = z.object({
  user: MeUserSchema,
  authToken: z.string(),
});
const FavoritesSchema = z.object({ favorites: z.array(z.string()) });
const AddFavoriteSchema = z.object({
  favorite: z.object({
    id: z.string(),
    mealId: z.string(),
    createdAt: z.string(),
  }),
});

// ── Preferences ────────────────────────────────────────────────────────────

/** GET /me/preferences — the server auto-creates a default row on first read. */
export async function getPreferences(): Promise<UserPreferences> {
  const body = await apiClient("/me/preferences", {
    schema: PreferencesEnvelopeSchema,
  });
  return body.preferences;
}

/** PATCH /me/preferences — partial update, returns the full updated row. */
export async function patchPreferences(
  input: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const body = await apiClient("/me/preferences", {
    method: "PATCH",
    body: input,
    schema: PreferencesEnvelopeSchema,
  });
  return body.preferences;
}

// ── Profile + password ─────────────────────────────────────────────────────

/**
 * PATCH /me/profile — at least one field. Beyond identity (firstName /
 * lastName / phone) the server also accepts marketing-consent flags and the
 * onboarding / first-run routing flags (WS7-2 Block C — all User columns).
 */
export async function patchProfile(input: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  marketingConsentEmail?: boolean;
  marketingConsentSms?: boolean;
  onboardingComplete?: boolean;
  firstRunChoiceMade?: boolean;
}): Promise<{ user: ProfileUser }> {
  const body = await apiClient("/me/profile", {
    method: "PATCH",
    body: input,
    schema: ProfileEnvelopeSchema,
  });
  return { user: body.user as ProfileUser };
}

/** PATCH /me/password — bcrypt-compares currentPassword server-side. */
export async function patchPassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await apiClient("/me/password", {
    method: "PATCH",
    body: input,
    schema: SuccessSchema,
  });
}

// ── Email change (two-step) ────────────────────────────────────────────────

/**
 * POST /me/email/request-change — mints a verification token server-side.
 * Server takes only `newEmail`; the request is auth-gated, the verify step
 * is JWT-gated. Always 200 (after body validation) to deter enumeration.
 */
export async function requestEmailChange(input: {
  newEmail: string;
}): Promise<void> {
  await apiClient("/me/email/request-change", {
    method: "POST",
    body: input,
    schema: SuccessSchema,
  });
}

/**
 * POST /me/email/verify-change — the JWT in `token` IS the auth, so no
 * bearer is sent. Callers should invalidate ['auth','me'] on success to
 * refresh the cached User email.
 */
export async function verifyEmailChange(
  token: string,
): Promise<{ success: boolean; email: string }> {
  return apiClient("/me/email/verify-change", {
    method: "POST",
    body: { token },
    auth: false,
    schema: VerifyEmailChangeSchema,
  });
}

// ── Deactivate / reactivate ────────────────────────────────────────────────

/** POST /me/deactivate — auth-only, no body. Idempotent server-side. */
export async function deactivateAccount(): Promise<void> {
  await apiClient("/me/deactivate", {
    method: "POST",
    schema: SuccessSchema,
  });
}

/**
 * POST /me/reactivate — public endpoint; takes credentials, returns a fresh
 * authToken. Persists the token via expo-secure-store (same path as login)
 * so callers don't have to handle token storage themselves.
 */
export async function reactivateAccount(input: {
  email: string;
  password: string;
}): Promise<{ user: User; authToken: string }> {
  const body = await apiClient("/me/reactivate", {
    method: "POST",
    body: input,
    auth: false,
    schema: ReactivateResponseSchema,
  });
  await storeToken(body.authToken);
  return { user: body.user as User, authToken: body.authToken };
}

// ── Favorites ──────────────────────────────────────────────────────────────

/** GET /me/favorites — array of mealIds, newest first. */
export async function getFavorites(): Promise<string[]> {
  const body = await apiClient("/me/favorites", { schema: FavoritesSchema });
  return body.favorites;
}

/** POST /me/favorites — idempotent server-side (unique userId+mealId). */
export async function addFavorite(mealId: string): Promise<void> {
  await apiClient("/me/favorites", {
    method: "POST",
    body: { mealId },
    schema: AddFavoriteSchema,
  });
}

/** DELETE /me/favorites/:mealId — idempotent (no 404 when absent). */
export async function removeFavorite(mealId: string): Promise<void> {
  await apiClient(`/me/favorites/${encodeURIComponent(mealId)}`, {
    method: "DELETE",
    schema: SuccessSchema,
  });
}
