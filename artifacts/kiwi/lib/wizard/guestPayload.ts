// Row 13 "Test Kitchen" · Block 2 Part C (R3) — the GUEST generate payload.
//
// A separate builder from lib/wizard/perRunPayload.ts, not a flag on it, because
// the two encode OPPOSITE contracts and merging them would make the member rule
// unreadable:
//
//   MEMBER (perRunPayload.ts hydratedSlice) — a field is sent only once the
//     screen has loaded STORED preferences. Omitted means "I never loaded them,
//     resolve from stored". The discriminator is the network, not the value.
//
//   GUEST (here) — there is nothing stored to resolve from. Every answer the
//     visitor gave is the only answer that exists, so the dietary fields are
//     ALWAYS on the wire, `[]` included ("I have no allergies" is an answer).
//
// 🔴 THE FAILURE THIS FILE EXISTS TO PREVENT. Run a guest through the member
// builder and `hydrated` is false — a guest has no stored preferences and
// GET /me/preferences is member-only — so hydratedSlice returns `{}` and the
// visitor's ALLERGIES ARE SILENTLY DROPPED. An allergy list is a hard constraint
// on what may be put on a plate; the member builder's own header says so. The
// guest form is also the ONLY place a guest is ever asked, which is why R3
// expands that disclosure by default.
//
// ── WHAT IS NEVER SENT, AND WHY IT IS ABSENCE AND NOT A VALUE (R3) ──────────
// Sauce and the two mix dials are HIDDEN from the guest form, so the visitor
// never answered them. Hans: "Never send a hidden default — the claim saves
// whatever the request carried." That is literal: POST /auth/signup copies the
// guest session's stored `preferences` blob onto the new account, and the blob IS
// this payload. A `saucePreference: "balanced"` sent here because it happened to
// be the form's initial state would become a preference the user never chose,
// written to their account by the act of signing up. Omitting leaves the server
// to run sauce as balanced and both dials off for THIS generation, and leaves the
// account's own defaults to be set later, by the user, in Preferences.
//
// `difficulty` is the one exception, and it is the pre-existing one: D-WS9-031
// made it a hidden "medium" required by the server schema on every path,
// member and guest alike. Omitting it is a 400, so it goes.

import type { WizardExpandCandidateContext } from "@/lib/api/wizard";
import type { WizardPreferencesInput } from "@/lib/types";

type WeeklyPacing = WizardPreferencesInput["weeklyPacing"];
type Difficulty = WizardPreferencesInput["difficulty"];
type CookTimeCoverage = NonNullable<WizardPreferencesInput["maxCookTimeCoverage"]>;

/** The slice of the guest wizard's form state the payload is built from. */
export interface GuestWizardForm {
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  eatingStyles: string[];
  /** The form names this `allergies`; the wire name is allergiesAndAvoidances. */
  allergies: string[];
  dietaryNotes: string;
  difficulty: Difficulty;
  weeklyPacing: WeeklyPacing;
  additionalNotes: string;
  /** null = the visitor chose no cap. A real answer, and sent as one. */
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: CookTimeCoverage;
}

/**
 * POST /wizard/build-plans, for a guest.
 *
 * ⚠️ `maxCookTimeCoverage` rides ONLY when a cap is set, and that is the same
 * rule as the sauce omission rather than an inconsistency: the coverage chips
 * render only after a cap is chosen (WizardScreen gates them on
 * `maxCookTimeMinutes !== null`), so with no cap the visitor never answered
 * "apply the cap to…" and "most" is a hidden default. The cap ITSELF is always
 * sent, null included, because those chips are always on screen.
 */
export function buildGuestWizardPayload(
  form: GuestWizardForm,
): WizardPreferencesInput {
  return {
    planDurationDays: form.planDurationDays,
    householdSize: form.householdSize,
    cuisines: form.cuisines,
    difficulty: form.difficulty,
    weeklyPacing: form.weeklyPacing,
    // ALWAYS present — see the header. `[]` is a legitimate answer.
    allergiesAndAvoidances: form.allergies,
    eatingStyles: form.eatingStyles,
    maxCookTimeMinutes: form.maxCookTimeMinutes,
    ...(form.maxCookTimeMinutes !== null
      ? { maxCookTimeCoverage: form.maxCookTimeCoverage }
      : {}),
    // "" -> undefined: this payload persists as the guest's answers, and an
    // empty note is "no note", never an empty note.
    dietaryNotes: form.dietaryNotes.trim() || undefined,
    additionalNotes: form.additionalNotes.trim() || undefined,
    // 🔴 saucePreference, discoveryLevel and playlistLevel are ABSENT. Not
    // undefined-valued — absent. Adding them here is the regression the
    // deliberate break in this block's tests exists to catch.
  };
}

/**
 * POST /wizard/expand's candidateContext, for a guest — built from the SAME
 * answers, under the same rule.
 *
 * `wantsLeftovers: false` is the member path's value too (buildCandidateContext
 * in lib/wizard/planOptions.ts); nothing on either form asks.
 *
 * The guest expand is catalog-only, so `saucePreference` / the cook-time
 * overrides would shape nothing the catalog can vary — and sending sauce here
 * would contradict the omission above. Only the dietary constraints and the
 * shape of the week go.
 */
export function buildGuestCandidateContext(
  form: GuestWizardForm,
): WizardExpandCandidateContext {
  return {
    planDurationDays: form.planDurationDays,
    householdSize: form.householdSize,
    wantsLeftovers: false,
    allergiesAndAvoidances: form.allergies,
    eatingStyles: form.eatingStyles,
    difficulty: form.difficulty,
  };
}

/**
 * The reverse trip: GET /guest/session's `preferences` blob back into a form
 * slice, so a visitor who reloads after generating can expand a candidate with
 * the answers that produced it. The blob is the payload above, verbatim, but it
 * arrives as `unknown` and is read defensively — a field that is not the shape
 * expected falls back rather than throwing, because the alternative is a
 * visitor stranded on a plan they can see and cannot open.
 */
export function guestFormFromStoredPreferences(
  blob: unknown,
  fallback: GuestWizardForm,
): GuestWizardForm {
  if (!blob || typeof blob !== "object") return fallback;
  const b = blob as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  const strs = (v: unknown, d: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : d;
  return {
    planDurationDays: num(b.planDurationDays, fallback.planDurationDays),
    householdSize: num(b.householdSize, fallback.householdSize),
    cuisines: strs(b.cuisines, fallback.cuisines),
    eatingStyles: strs(b.eatingStyles, fallback.eatingStyles),
    allergies: strs(b.allergiesAndAvoidances, fallback.allergies),
    dietaryNotes: typeof b.dietaryNotes === "string" ? b.dietaryNotes : fallback.dietaryNotes,
    difficulty:
      b.difficulty === "easy" || b.difficulty === "medium" || b.difficulty === "fancy"
        ? b.difficulty
        : fallback.difficulty,
    weeklyPacing:
      b.weeklyPacing === "mostly_easy" ||
      b.weeklyPacing === "mixed" ||
      b.weeklyPacing === "one_fancy_night" ||
      b.weeklyPacing === "minimal_effort"
        ? b.weeklyPacing
        : fallback.weeklyPacing,
    additionalNotes:
      typeof b.additionalNotes === "string" ? b.additionalNotes : fallback.additionalNotes,
    maxCookTimeMinutes:
      typeof b.maxCookTimeMinutes === "number" || b.maxCookTimeMinutes === null
        ? (b.maxCookTimeMinutes as number | null)
        : fallback.maxCookTimeMinutes,
    maxCookTimeCoverage:
      b.maxCookTimeCoverage === "all" || b.maxCookTimeCoverage === "most"
        ? b.maxCookTimeCoverage
        : fallback.maxCookTimeCoverage,
  };
}
