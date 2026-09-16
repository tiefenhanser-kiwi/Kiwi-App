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

// ── WS9 Redesign Arc Block 1 (D-WS9-245) — the two dials ─────────────────────
//
// Discovery and Playlist are each None · Some · Mostly · All. Discovery is
// STORED (UserPreferences.discoveryLevel) and per-run overridable under
// D-WS7-035's rule below; Playlist is PER-RUN ONLY (no column; omitted = none).
// A level becomes a COUNT here, on the server, from the plan length — no prompt
// ever sees the level, only the integer it resolves to. First setting, tune
// with data: none = 0 · some = ceil(days × 0.3) · mostly = ceil(days × 0.7) ·
// all = days. "All" on one dial forces "none" on the other (a plan that is all
// playlist meals has no room for a new-to-you one, and vice versa).

export const DIAL_LEVELS = ["none", "some", "mostly", "all"] as const;
export type DiscoveryLevel = (typeof DIAL_LEVELS)[number];
export type PlaylistLevel = DiscoveryLevel;

const LEVEL_FRACTION: Record<DiscoveryLevel, number> = {
  none: 0,
  some: 0.3,
  mostly: 0.7,
  all: 1,
};

/** A dial level → the number of slots it claims out of `size`. */
export function levelToCount(level: DiscoveryLevel, size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(size * LEVEL_FRACTION[level]);
}

/**
 * Legacy shim (TEMPORARY — remove in Redesign Arc Block 2 once the mobile
 * dials send the enum): the pre-arc `discoveryMealsPerWeek` integer 0..2 maps
 * onto the level exactly as the D-WS9-245 migration mapped the stored column
 * (0→none, 1→some, 2→mostly; anything else → none).
 */
export function legacyDiscoveryIntToLevel(n: number): DiscoveryLevel {
  if (n === 1) return "some";
  if (n === 2) return "mostly";
  return "none";
}

/**
 * TEMPORARY — Block 2 removes. The inverse of the shim above, for the wire:
 * the current mobile build's preferences Zod REQUIRES an integer
 * `discoveryMealsPerWeek` on GET /me/preferences, so the level is echoed as
 * one (none 0 · some 1 · mostly 2 · all 2 — the mobile schema allows no more).
 */
export function discoveryLevelToLegacyInt(level: DiscoveryLevel): number {
  if (level === "some") return 1;
  if (level === "mostly" || level === "all") return 2;
  return 0;
}

/**
 * Fold a parsed per-run body's discovery fields into ONE optional level: the
 * enum field wins when sent; else the legacy integer (shimmed); else undefined
 * (= no per-run override, use stored). Presence semantics preserved.
 */
export function discoveryLevelFromInput(input: {
  discoveryLevel?: DiscoveryLevel;
  discoveryMealsPerWeek?: number;
}): DiscoveryLevel | undefined {
  if (input.discoveryLevel !== undefined) return input.discoveryLevel;
  if (input.discoveryMealsPerWeek !== undefined) {
    return legacyDiscoveryIntToLevel(input.discoveryMealsPerWeek);
  }
  return undefined;
}

/**
 * "All on one dial forces None on the other." When BOTH are `all` the playlist
 * wins: the user's declared list is the more specific instruction, and a
 * playlist meal can never be new-to-you, so discovery has nothing to claim.
 */
export function applyAllForcesNone(
  discoveryLevel: DiscoveryLevel,
  playlistLevel: PlaylistLevel,
): { discoveryLevel: DiscoveryLevel; playlistLevel: PlaylistLevel } {
  if (playlistLevel === "all") {
    return { discoveryLevel: "none", playlistLevel: "all" };
  }
  if (discoveryLevel === "all") {
    return { discoveryLevel: "all", playlistLevel: "none" };
  }
  return { discoveryLevel, playlistLevel };
}

/** The generation-shaping prefs, fully resolved (no undefined). */
export interface ResolvedPreferences {
  /** The resolved dial (override ?? stored), after All-forces-None. */
  discoveryLevel: DiscoveryLevel;
  /** The resolved dial (override ?? none), after All-forces-None. */
  playlistLevel: PlaylistLevel;
  /**
   * The COUNT the prompts consume — kept under its historical name so
   * `preferencesContext.discoveryMealsPerWeek` stays an integer for the two
   * generate bodies. 0 when the caller supplied no plan length.
   */
  discoveryMealsPerWeek: number;
  /** The playlist count, same derivation. Not read by any prompt yet. */
  playlistMealsPerWeek: number;
  saucePreference: string;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: string;
}

/** Stored defaults for a user with no override on a given field. */
export interface StoredPreferences {
  discoveryLevel: DiscoveryLevel;
  saucePreference: string;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: string;
}

/**
 * Per-run client overrides. Every field optional: `undefined` = the client
 * did not set a per-run value (fall back to stored). `maxCookTimeMinutes:
 * null` is a real override meaning "no cap this plan". `playlistLevel` has
 * no stored counterpart: omitted = none.
 */
export interface PreferencesOverrides {
  discoveryLevel?: DiscoveryLevel;
  playlistLevel?: PlaylistLevel;
  saucePreference?: string;
  maxCookTimeMinutes?: number | null;
  maxCookTimeCoverage?: string;
}

/** What the counts are derived against. Absent → both counts resolve to 0. */
export interface PreferencesResolutionContext {
  planDurationDays?: number;
}

// Mirror the schema.prisma column defaults so a user with no UserPreferences
// row still resolves to concrete values.
const PREFERENCE_DEFAULTS: StoredPreferences = {
  discoveryLevel: "none",
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

/**
 * Pure precedence: per-run override wins when present, else the stored value.
 * Uses presence (`!== undefined`), not nullish, so an explicit null cap wins.
 * The dials are then reconciled (All-forces-None) and turned into counts.
 */
export function resolvePreferences(
  stored: StoredPreferences,
  overrides: PreferencesOverrides,
  context: PreferencesResolutionContext = {},
): ResolvedPreferences {
  const dials = applyAllForcesNone(
    overrides.discoveryLevel !== undefined
      ? overrides.discoveryLevel
      : stored.discoveryLevel,
    overrides.playlistLevel !== undefined ? overrides.playlistLevel : "none",
  );
  const days = context.planDurationDays ?? 0;
  return {
    discoveryLevel: dials.discoveryLevel,
    playlistLevel: dials.playlistLevel,
    discoveryMealsPerWeek: levelToCount(dials.discoveryLevel, days),
    playlistMealsPerWeek: levelToCount(dials.playlistLevel, days),
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
  context: PreferencesResolutionContext = {},
): Promise<ResolvedPreferences> {
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: {
      discoveryLevel: true,
      saucePreference: true,
      maxCookTimeMinutes: true,
      maxCookTimeCoverage: true,
    },
  });
  const stored: StoredPreferences = {
    discoveryLevel: prefs?.discoveryLevel ?? PREFERENCE_DEFAULTS.discoveryLevel,
    saucePreference:
      prefs?.saucePreference ?? PREFERENCE_DEFAULTS.saucePreference,
    maxCookTimeMinutes:
      prefs?.maxCookTimeMinutes ?? PREFERENCE_DEFAULTS.maxCookTimeMinutes,
    maxCookTimeCoverage:
      prefs?.maxCookTimeCoverage ?? PREFERENCE_DEFAULTS.maxCookTimeCoverage,
  };
  return resolvePreferences(stored, overrides, context);
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
