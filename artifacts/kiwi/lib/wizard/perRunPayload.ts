// WS9 BUG-201 — the per-run generate payloads for the two plan-building
// screens, extracted from app/wizard.tsx and app/tellkiwi.tsx.
//
// WHY THIS FILE EXISTS. `artifacts/kiwi/app/**` sits outside the test glob
// (D-WS9-164), and the rule these builders encode is the one thing on those
// screens that MUST be pinned: whether a field is on the wire at all. A screen
// that has not loaded the user's stored preferences must not describe them.
// Same reasoning as lib/preferencesForm.ts (the seed) and lib/cooking/
// prepWeekModel.ts (the view-model) — the decision moves to a pure function so
// it can be asserted; the screens keep the state and the chrome.
//
// ── THE CONTRACT (Hans, verbatim) ──────────────────────────────────────────
//
//   Field OMITTED         -> the screen never loaded preferences
//                         -> the server resolves from stored.
//   Field PRESENT,
//   including empty       -> the user's actual choice
//                         -> the server honours it exactly.
//
// 🔴 THE DISCRIMINATOR IS WHETHER THE SCREEN LOADED, NOT WHETHER THE VALUE IS
// EMPTY. `[]` is a legitimate answer — "I have no allergies" — and it must stay
// sendable. What must never be sent is the `[]` that INITIAL_FORM seeds before
// (or instead of) hydration, because that one is a fact about the network, not
// about the user.
//
// ⚠️ THE FAILURE PATH IS DOCUMENTED IN THE SCREENS THEMSELVES: "On a prefs
// error we fall through — hydration is an assist, not a blocker." So a prefs
// read that 500s produces a form whose allergy list is `[]`, and before this
// change that `[]` went out as though the user had chosen it.
//
// ⛔ SEQUENCING — THE TWO FIELDS ARE AT DIFFERENT STAGES ON THE SERVER, AND
// THAT IS DELIBERATE ON THEIR SIDE, NOT AN OVERSIGHT ON THIS ONE.
//
//   allergiesAndAvoidances — LIVE. The parallel lane (D-WS9-214) has already
//     moved WizardInputSchema, DirectedInputSchema and
//     WizardExpandCandidateContextSchema to `z.array(z.string()).optional()`,
//     with a resolveAllergenPreference() resolver behind them. Omitting is
//     honoured end to end today.
//
//   eatingStyles — NOT YET. All three still read
//     `z.array(z.string()).default([])`, so zod REWRITES an absent field to
//     `[]` during validation, before any resolver can see the difference.
//     Omitting it is therefore currently INERT: the same `[]` arrives, by a
//     different route. It is not harmful and not a regression — it is simply
//     not yet load-bearing, and becomes so the moment that default is dropped.
//
// Omitting cannot 400 in either case: none of these objects is `.strict()` on
// these keys. ⚠️ Do NOT "fix" the eatingStyles gap from this side — the schemas
// belong to the server lane.

import type { TellKiwiInput, WizardPreferencesInput } from "@/lib/types";

type WeeklyPacing = NonNullable<TellKiwiInput["weeklyPacing"]>;
type SaucePreference = NonNullable<TellKiwiInput["saucePreference"]>;
type CookTimeCoverage = NonNullable<TellKiwiInput["maxCookTimeCoverage"]>;
type Difficulty = WizardPreferencesInput["difficulty"];

/** The slice of wizard.tsx's form state the payload is built from. */
export interface WizardPayloadForm {
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  eatingStyles: string[];
  /** wizard.tsx names this `allergies`; the wire name is allergiesAndAvoidances. */
  allergies: string[];
  dietaryNotes: string;
  difficulty: Difficulty;
  weeklyPacing: WeeklyPacing;
  additionalNotes: string;
  discoveryMealsPerWeek: number;
  saucePreference: SaucePreference;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: CookTimeCoverage;
}

/** The slice of tellkiwi.tsx's form state the payload is built from. */
export interface TellKiwiPayloadForm {
  description: string;
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  weeklyPacing: WeeklyPacing;
  eatingStyles: string[];
  allergies: string[];
  dietaryNotes: string;
  discoveryMealsPerWeek: number;
  saucePreference: SaucePreference;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: CookTimeCoverage;
}

/**
 * The hydration-gated slice, shared by both screens.
 *
 * Four of these six are the Cookbook Phase B per-run overrides (D-WS7-035),
 * gated since Block 4 for the same reason: sending a pre-hydration default
 * clobbers the user's stored value through the server's override-else-stored
 * resolver. BUG-201 adds the two dietary arrays, which were sent
 * unconditionally and carry the higher cost when wrong — an allergy list is a
 * hard constraint on what may be put on a plate, not a styling preference.
 */
function hydratedSlice(
  form: WizardPayloadForm | TellKiwiPayloadForm,
  hydrated: boolean,
) {
  if (!hydrated) return {};
  return {
    allergiesAndAvoidances: form.allergies,
    eatingStyles: form.eatingStyles,
    discoveryMealsPerWeek: form.discoveryMealsPerWeek,
    saucePreference: form.saucePreference,
    maxCookTimeMinutes: form.maxCookTimeMinutes,
    maxCookTimeCoverage: form.maxCookTimeCoverage,
  };
}

/** POST /api/wizard/build-plans body — app/wizard.tsx handleSubmit. */
export function buildWizardPayload(
  form: WizardPayloadForm,
  hydrated: boolean,
): WizardPreferencesInput {
  return {
    planDurationDays: form.planDurationDays,
    householdSize: form.householdSize,
    cuisines: form.cuisines,
    difficulty: form.difficulty,
    weeklyPacing: form.weeklyPacing,
    // "" -> undefined is correct HERE (unlike preferences.tsx, BUG-203): this
    // payload persists nothing, so an absent note means "no per-run note",
    // never "clear the stored one".
    dietaryNotes: form.dietaryNotes.trim() || undefined,
    additionalNotes: form.additionalNotes.trim() || undefined,
    ...hydratedSlice(form, hydrated),
  };
}

/** POST /api/wizard/build-from-text body — app/tellkiwi.tsx buildPayload. */
export function buildTellKiwiPayload(
  form: TellKiwiPayloadForm,
  hydrated: boolean,
): TellKiwiInput {
  return {
    description: form.description.trim(),
    planDurationDays: form.planDurationDays,
    householdSize: form.householdSize,
    cuisines: form.cuisines,
    weeklyPacing: form.weeklyPacing,
    dietaryNotes: form.dietaryNotes.trim() || undefined,
    ...hydratedSlice(form, hydrated),
  };
}
