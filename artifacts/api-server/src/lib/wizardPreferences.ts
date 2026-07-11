// Cookbook Phase B Block 4 (D-WS7-035) — single server-side resolution of the
// generation-shaping preferences. Semantics (Hans's ruling): the wizard
// hydrates its controls from stored UserPreferences, the user may edit them
// for THIS generation only, and those edits NEVER write back. So every
// generate/expand call has two candidate sources per field — a per-run client
// override and the stored default — and the effective value is:
//
//     client override (when the client sent one)  ELSE  stored default.
//
// This resolver is the ONE place that rule lives, used at BOTH stages:
//   - generate  (wizard.ts build-plans + build-from-text) — folds the override
//     into the `preferencesContext` bag the prompt already reads.
//   - expand    (wizardExpansion.ts) — AMENDS D-WS7-197. Block 2 blindly
//     overwrote these three fields from stored prefs at expand; that silently
//     reverted a legitimate per-run cook-time/sauce override. The server is
//     STILL authoritative — it resolves and authors the value here — it just
//     now accounts for a real override the user set, rather than pretending one
//     can't exist. The override reaches expand by being re-sent on
//     candidateContext (the user's own per-run input, resolved again server-
//     side), not by trusting a client echo of a server-derived value.
//
// Presence semantics matter: an OMITTED override (`undefined`) falls back to
// stored, but an EXPLICIT `null` on maxCookTimeMinutes is a real value ("No
// limit for this plan") and must win over a stored cap. So this uses a
// presence check (`!== undefined`), NOT `??` — `null ?? stored` would wrongly
// discard an explicit no-limit override.

import type { PrismaClient } from "@prisma/client";

/** The four generation-shaping prefs, fully resolved (no undefined). */
export interface ResolvedPreferences {
  discoveryMealsPerWeek: number;
  saucePreference: string;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: string;
}

/** Stored defaults for a user with no override on a given field. */
export type StoredPreferences = ResolvedPreferences;

/**
 * Per-run client overrides. Every field optional: `undefined` = the client
 * did not set a per-run value (fall back to stored). `maxCookTimeMinutes:
 * null` is a real override meaning "no cap this plan".
 */
export interface PreferencesOverrides {
  discoveryMealsPerWeek?: number;
  saucePreference?: string;
  maxCookTimeMinutes?: number | null;
  maxCookTimeCoverage?: string;
}

// Mirror the schema.prisma column defaults so a user with no UserPreferences
// row still resolves to concrete values.
const PREFERENCE_DEFAULTS: StoredPreferences = {
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

/**
 * Pure precedence: per-run override wins when present, else the stored value.
 * Uses presence (`!== undefined`), not nullish, so an explicit null cap wins.
 */
export function resolvePreferences(
  stored: StoredPreferences,
  overrides: PreferencesOverrides,
): ResolvedPreferences {
  return {
    discoveryMealsPerWeek:
      overrides.discoveryMealsPerWeek !== undefined
        ? overrides.discoveryMealsPerWeek
        : stored.discoveryMealsPerWeek,
    saucePreference:
      overrides.saucePreference !== undefined
        ? overrides.saucePreference
        : stored.saucePreference,
    maxCookTimeMinutes:
      overrides.maxCookTimeMinutes !== undefined
        ? overrides.maxCookTimeMinutes
        : stored.maxCookTimeMinutes,
    maxCookTimeCoverage:
      overrides.maxCookTimeCoverage !== undefined
        ? overrides.maxCookTimeCoverage
        : stored.maxCookTimeCoverage,
  };
}

/**
 * Read the user's stored generation prefs (falling back to column defaults
 * when no row exists) and fold in the per-run overrides. This is the bag the
 * generate/expand prompts consume as `preferencesContext` / the re-authored
 * candidateContext fields.
 */
export async function resolveEffectivePreferences(
  prisma: Pick<PrismaClient, "userPreferences">,
  userId: string,
  overrides: PreferencesOverrides = {},
): Promise<ResolvedPreferences> {
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: {
      discoveryMealsPerWeek: true,
      saucePreference: true,
      maxCookTimeMinutes: true,
      maxCookTimeCoverage: true,
    },
  });
  const stored: StoredPreferences = {
    discoveryMealsPerWeek:
      prefs?.discoveryMealsPerWeek ?? PREFERENCE_DEFAULTS.discoveryMealsPerWeek,
    saucePreference:
      prefs?.saucePreference ?? PREFERENCE_DEFAULTS.saucePreference,
    maxCookTimeMinutes:
      prefs?.maxCookTimeMinutes ?? PREFERENCE_DEFAULTS.maxCookTimeMinutes,
    maxCookTimeCoverage:
      prefs?.maxCookTimeCoverage ?? PREFERENCE_DEFAULTS.maxCookTimeCoverage,
  };
  return resolvePreferences(stored, overrides);
}
