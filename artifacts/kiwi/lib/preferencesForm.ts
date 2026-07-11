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
