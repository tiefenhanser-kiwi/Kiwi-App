// Preferences edit-buffer seed mapping, extracted from app/preferences.tsx so
// it is unit-testable without mounting the RN screen.
//
// GET /me/preferences returns some columns that are READ-ONLY — surfaced on the
// wire but NOT in the PATCH /me/preferences `.strict()` allow-list. The edit
// buffer (`form`) must never carry those, or handleSave would PATCH them back
// and the server rejects the whole request with a 400 (Block 5 regression:
// weeklyPacingDefault leaked exactly this way and produced a silent save
// failure). Peeling them at the seed keeps `form` a true UserPreferencesData.

import type { UserPreferences } from "./api/me";
import type { UserPreferencesData } from "./types";

// Keys the GET response carries that the PATCH allow-list (me.ts) does NOT
// accept. Kept as an exported constant so the regression test can assert the
// seed output never includes any of them.
export const SERVER_ONLY_PREFERENCE_KEYS = [
  "weeklyPacingDefault",
] as const satisfies ReadonlyArray<keyof UserPreferences>;

/**
 * Map a server preferences row into the screen's edit buffer.
 * - normalizes the four optional String? columns from `null` → `undefined`
 * - strips server-only, read-only columns so they can't leak back into PATCH
 */
export function toFormState(p: UserPreferences): UserPreferencesData {
  const { weeklyPacingDefault: _serverOnlyPacing, ...editable } = p;
  return {
    ...editable,
    cookingSkill: p.cookingSkill ?? undefined,
    stovetopType: p.stovetopType ?? undefined,
    defaultRetailer: p.defaultRetailer ?? undefined,
    dietaryNotes: p.dietaryNotes ?? undefined,
  };
}

// The nullable String? columns on UserPreferences. `toFormState` above maps
// each of them `null` -> `undefined` on the way IN; `toPatchBody` below maps
// them back `undefined` -> `null` on the way OUT. Exported so the regression
// test names the same set the code does.
export const NULLABLE_PREFERENCE_KEYS = [
  "cookingSkill",
  "stovetopType",
  "defaultRetailer",
  "dietaryNotes",
] as const satisfies ReadonlyArray<keyof UserPreferencesData>;

/** The PATCH /me/preferences body for an edit buffer. Never carries `undefined`. */
export type PreferencesPatchBody = Omit<
  UserPreferencesData,
  "wantsLeftovers" | (typeof NULLABLE_PREFERENCE_KEYS)[number]
> & {
  cookingSkill: UserPreferencesData["cookingSkill"] | null;
  stovetopType: UserPreferencesData["stovetopType"] | null;
  defaultRetailer: string | null;
  dietaryNotes: string | null;
};

/**
 * Map the screen's edit buffer into the PATCH /me/preferences body.
 *
 * WS9 BUG-203 — CLEARING A FIELD MUST SEND THE EMPTY VALUE, NOT DROP THE KEY.
 *
 * Hans, on the device: "I cleared out a note from before 'no cilantro, light
 * dairy' and it didn't take. it toasted on the preferences, but maybe there's
 * an issue with saving it to null from something."
 *
 * The mechanism, end to end:
 *   preferences.tsx mapped an emptied "Anything else?" field to `undefined`
 *   -> apiClient JSON.stringify()s the body
 *   -> JSON.stringify DROPS keys whose value is `undefined`
 *   -> the server never receives `dietaryNotes`, so its `.optional()` validator
 *      treats it as "not supplied" and the stored value survives untouched
 *   -> the PATCH still 200s, so the screen toasts "Preferences saved."
 *
 * ⚠️ A PRIOR AUDIT RECORDED THAT THE FOUR SCREENS' THREE BLANK-VALUE
 * CONVENTIONS "converge to the same stored state." THE DEVICE FALSIFIED THAT.
 * Clearing is the single case where "omit if empty" and "save empty" diverge,
 * and it is precisely the case a convergence claim cannot cover.
 *
 * ⚠️ THE TOAST WAS PART OF THE BUG, and this is where it is fixed. A silent
 * no-op that announces success is worse than a visible failure. The success
 * signal is not made conditional — it is made TRUE, by ensuring the request
 * actually carries the user's change. The server accepts `null` on every one of
 * these columns (routes/me.ts: `.nullable().optional()`), so an explicit null is
 * "the user supplied nothing on purpose" and reaches storage as such.
 *
 * ⚠️ THE INVARIANT, NOT JUST THE FIX: the returned body contains NO `undefined`
 * VALUES AT ALL. That is what stops the next field from failing the same way —
 * a key that cannot go `undefined` cannot be silently dropped by the
 * serializer. The regression test asserts the invariant, not just dietaryNotes.
 *
 * `undefined` is unambiguous here: `form` is null until the GET resolves and is
 * then seeded from the FULL server row, so every key is present and an
 * `undefined` on one of these four always means "empty", never "not loaded".
 * (That distinction is real elsewhere — it is exactly BUG-201 on the wizard
 * screens — but it cannot arise on this screen.)
 */
export function toPatchBody(form: UserPreferencesData): PreferencesPatchBody {
  // wantsLeftovers is no longer user-set (D-WS7-190) — omit it rather than echo
  // the stored value back. Same peel toFormState does for read-only columns.
  const { wantsLeftovers: _omitLeftovers, ...rest } = form;
  // ⚠️ EMPTY FREE TEXT COLLAPSES TO `null`, NOT `""`. Sending `""` would carry
  // the user's clear correctly but trip a DIFFERENT bug: the server stamps
  // UserPreferences.dietaryUpdatedAt on a dietary VALUE CHANGE (BUG-055), and
  // it compares `dietaryNotes: string | null`. A stored `null` answered with a
  // `""` is a change — so every unrelated edit (spice tolerance, household
  // size) made by a user who has never written a note would re-stamp the
  // dietary anchor and mark all their plans dietarily stale. One empty, one
  // representation. Whitespace-only counts as cleared; a non-empty value is
  // NOT trimmed, because that would edit the user's own words.
  const notes = form.dietaryNotes ?? "";
  return {
    ...rest,
    cookingSkill: form.cookingSkill ?? null,
    stovetopType: form.stovetopType ?? null,
    defaultRetailer: form.defaultRetailer ?? null,
    dietaryNotes: notes.trim().length > 0 ? notes : null,
  };
}
