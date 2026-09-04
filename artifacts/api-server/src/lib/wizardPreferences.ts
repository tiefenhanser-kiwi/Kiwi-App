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

import { logger } from "./logger";

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

// ── BUG-201 / D-WS9-214 — the allergen field ─────────────────────────────────
//
// Same rule as the four fields above, on the one field where getting it wrong
// is a safety failure rather than a preference failure.
//
// Hans's contract, verbatim:
//   field OMITTED                  -> the screen never loaded preferences
//                                  -> resolve from stored
//   field PRESENT, INCLUDING EMPTY -> the user's actual choice on that screen
//                                  -> honour it exactly
//   "The discriminator is whether the screen LOADED, not whether it is empty."
//
// ⚠️ WHY LOADED-AND-EMPTY IS HONOURED, WHICH LOOKS WRONG AND IS NOT. Dropping a
// stored allergy on the user's say-so reads like the unsafe branch, and the
// safe-looking alternative — union the client list with the stored one — was
// considered and REJECTED. Union can never drop an allergy, but it also makes
// the per-run field inert: the wizard screen exists so the user can vary their
// constraints for THIS plan, and under a union an unticked chip stays ticked
// forever. Hans: "maybe a user has a mild gluten thing and they want to cook
// whatever tastes better for a party this weekend. that's ok." An empty list
// the user actually chose is a legitimate answer; an empty list nobody chose
// is not, and those are different states that `.default([])` used to collapse.
//
// ⚠️ THE SCHEMAS MUST USE `.optional()`, NOT `.default([])`. That is the whole
// fix. `.default([])` rewrites an absent field to `[]` inside Zod, before this
// function can ever see the difference — which is how BUG-201 shipped: a
// generate arriving with no allergen field produced no allergen tokens, so
// `allergenWhereConditions` returned NO conditions and the shelf query ran with
// the hard filter switched off entirely, while the prompt was simultaneously
// told the user had no allergies. Both halves of the safety story failed at
// once, silently, and the row that caused it looked like a formatting default.

export interface AllergenResolution {
  allergiesAndAvoidances: string[];
  /** Which branch of the contract produced the value. */
  source: "client" | "stored";
}

/**
 * Resolve the effective allergen list for one generation, and emit the
 * observability that makes the contract auditable.
 *
 * `clientValue` MUST be the raw parsed field: `undefined` when absent, the
 * array when present (including `[]`). Passing `?? []` at the call site
 * reintroduces the bug.
 */
export async function resolveAllergenPreference(
  prisma: Pick<PrismaClient, "userPreferences">,
  userId: string,
  clientValue: string[] | undefined,
  context: { route: string },
): Promise<AllergenResolution> {
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { allergiesAndAvoidances: true },
  });
  const stored = prefs?.allergiesAndAvoidances ?? [];

  if (clientValue === undefined) {
    // ⚠️ THIS BRANCH TRUSTS THE CLIENT ABOUT ITS OWN LOAD STATE, and the log is
    // what makes that trust auditable rather than assumed. Gated on the user
    // actually HAVING stored allergies: absent-and-none-stored is the ordinary
    // case for most of the userbase and would bury the signal. What is left is
    // exactly the population for whom the omission would have been dangerous.
    if (stored.length > 0) {
      logger.warn(
        {
          event: "allergen_field_omitted",
          userId,
          route: context.route,
          storedAllergenCount: stored.length,
        },
        "generate arrived with no allergen field for a user who has stored allergies — resolved from stored",
      );
    }
    return { allergiesAndAvoidances: stored, source: "stored" };
  }

  // ⚠️ THE INVERSE ALARM, AND IT IS THE MORE IMPORTANT OF THE TWO. A deliberate
  // per-run "no allergies this week" is legitimate and expected at a low rate.
  // IF THIS RATE IS HIGH, THE CLIENT IS LYING ABOUT HYDRATION — sending its
  // pre-hydration empty form state as though it were a user's choice — AND THE
  // WHOLE CONTRACT IS UNSOUND, because the server cannot tell that case from a
  // real override and will keep honouring it. `info`, not `warn`: any single
  // occurrence is fine and only the RATE carries the signal.
  if (clientValue.length === 0 && stored.length > 0) {
    logger.info(
      {
        event: "allergen_override_empty",
        userId,
        route: context.route,
        storedAllergenCount: stored.length,
      },
      "generate explicitly cleared allergies for this run — honoured; watch the RATE, not the event",
    );
  }
  return { allergiesAndAvoidances: clientValue, source: "client" };
}
