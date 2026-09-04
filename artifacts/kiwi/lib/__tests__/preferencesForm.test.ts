// Block 5 regression — the preferences edit-buffer seed must not carry any
// server-only (read-only) column into the form. If it does, handleSave PATCHes
// it back and the server's `.strict()` allow-list rejects the whole request
// with a silent 400 (the weeklyPacingDefault save-failure bug).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NULLABLE_PREFERENCE_KEYS,
  SERVER_ONLY_PREFERENCE_KEYS,
  toFormState,
  toPatchBody,
} from "../preferencesForm";
import type { UserPreferences } from "../api/me";
import type { UserPreferencesData } from "../types";

// Mirror of the PATCH /me/preferences `.strict()` allow-list in
// api-server/src/routes/me.ts:165-192. The edit buffer's key set must be a
// SUBSET of this — any key outside it is a strict-schema rejection.
const PATCH_ALLOW_LIST = new Set([
  "householdSize",
  "wantsLeftovers",
  "cuisines",
  "eatingStyles",
  "allergiesAndAvoidances",
  "cookingSkill",
  "stovetopType",
  "kidsCount",
  "pickyEaterCount",
  "pickyAvoidances",
  "spiceTolerance",
  "healthGoals",
  "budgetLevel",
  "cookingEquipment",
  "recurringGroceryItems",
  "planLengthDefault",
  "defaultRetailer",
  "dietaryNotes",
  // WS9 D-WS9-206 — present in the real allow-list (routes/me.ts). This mirror
  // had drifted and omitted it, which made the subset check below pass only
  // because SERVER_ROW happened to omit it too. Both are corrected here.
  "otherAllergies",
  "discoveryMealsPerWeek",
  "saucePreference",
  "maxCookTimeMinutes",
  "maxCookTimeCoverage",
]);

// A full GET /me/preferences row INCLUDING the read-only weeklyPacingDefault.
const SERVER_ROW: UserPreferences = {
  spiceTolerance: "mild",
  budgetLevel: "economy",
  cookingSkill: "intermediate",
  stovetopType: "gas",
  defaultRetailer: "Instacart",
  cuisines: ["Italian", "Mexican"],
  allergiesAndAvoidances: [],
  otherAllergies: [],
  cookingEquipment: ["Oven"],
  recurringGroceryItems: ["Milk"],
  eatingStyles: ["Healthy"],
  healthGoals: [],
  pickyAvoidances: ["Mushrooms"],
  householdSize: 3,
  kidsCount: 2,
  pickyEaterCount: 1,
  planLengthDefault: 7,
  wantsLeftovers: true,
  weeklyPacingDefault: "mixed",
  dietaryNotes: null,
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

test("toFormState strips weeklyPacingDefault (and all server-only keys)", () => {
  const form = toFormState(SERVER_ROW) as Record<string, unknown>;
  for (const key of SERVER_ONLY_PREFERENCE_KEYS) {
    assert.equal(
      key in form,
      false,
      `toFormState emitted server-only key '${key}' — it will leak into PATCH`,
    );
  }
});

test("toFormState emits only keys the PATCH allow-list accepts", () => {
  const form = toFormState(SERVER_ROW) as Record<string, unknown>;
  const leaked = Object.keys(form).filter((k) => !PATCH_ALLOW_LIST.has(k));
  assert.deepEqual(
    leaked,
    [],
    `edit buffer carries keys the server rejects: ${leaked.join(", ")}`,
  );
});

test("toFormState normalizes null String? columns to undefined", () => {
  const form = toFormState({
    ...SERVER_ROW,
    cookingSkill: null,
    stovetopType: null,
    defaultRetailer: null,
    dietaryNotes: null,
  });
  assert.equal(form.cookingSkill, undefined);
  assert.equal(form.stovetopType, undefined);
  assert.equal(form.defaultRetailer, undefined);
  assert.equal(form.dietaryNotes, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// WS9 BUG-203 — clearing a free-text preference must actually save.
//
// Hans, on the device: "I cleared out a note from before 'no cilantro, light
// dairy' and it didn't take. it toasted on the preferences, but maybe there's
// an issue with saving it to null from something."
//
// ⚠️ WHY THE EXISTING SUITE COULD NOT SEE THIS. Every assertion above is about
// the INBOUND seed, and the component tests assert `onChangeText` WIRING. The
// bug lives on the OUTBOUND edge and only in the CLEAR case: setting a note
// worked fine, emptying it silently did nothing. "Emptying" is a distinct case
// from "changing" and nothing tested it.
// ═══════════════════════════════════════════════════════════════════════════

/** The edit buffer as it exists after the screen seeds from SERVER_ROW. */
const FORM: UserPreferencesData = toFormState(SERVER_ROW);

/** What JSON.stringify actually puts on the wire — the real failure surface. */
function onTheWire(body: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

test("BUG-203: an emptied dietaryNotes SURVIVES serialization as an explicit null", () => {
  // The user had a note and cleared the field. `""` is what the TextInput emits.
  const cleared = toPatchBody({ ...FORM, dietaryNotes: "" });
  assert.equal(cleared.dietaryNotes, null);

  // 🔴 THE ACTUAL BUG. The old mapping produced `undefined` here, and
  // JSON.stringify DELETES keys whose value is undefined — so the server never
  // saw the field, kept the old note, and returned 200. Assert on the
  // POST-SERIALIZATION body, because that is the thing that was wrong.
  const wire = onTheWire(cleared);
  assert.ok(
    "dietaryNotes" in wire,
    "the cleared field was dropped from the request body entirely",
  );
  assert.equal(wire.dietaryNotes, null);
});

test("BUG-203: whitespace-only counts as cleared; a real note is sent untrimmed", () => {
  assert.equal(toPatchBody({ ...FORM, dietaryNotes: "   " }).dietaryNotes, null);
  // ⚠️ EMPTY COLLAPSES TO null, NOT "". The server stamps dietaryUpdatedAt on a
  // dietary VALUE CHANGE (BUG-055) comparing `string | null`; answering a
  // stored null with "" is a change, so every unrelated edit by a note-less
  // user would mark all their plans dietarily stale.
  assert.notEqual(toPatchBody({ ...FORM, dietaryNotes: "" }).dietaryNotes, "");

  // A real value is forwarded verbatim — not trimmed, they are the user's words.
  assert.equal(
    toPatchBody({ ...FORM, dietaryNotes: " no cilantro, light dairy " })
      .dietaryNotes,
    " no cilantro, light dairy ",
  );
});

test("BUG-203: stovetopType clears too — the SAME defect, a second field", () => {
  // ⚠️ NOT A HYPOTHETICAL. StovetopPicker is the one other control on this
  // screen with a real clear affordance: `onChange(value === t ? undefined : t)`
  // — tapping the selected chip deselects it. That `undefined` was dropped by
  // JSON.stringify exactly like the note, so a user could never un-set their
  // stovetop either. The screen never reported it because it, too, toasted.
  const wire = onTheWire(toPatchBody({ ...FORM, stovetopType: undefined }));
  assert.ok("stovetopType" in wire, "a deselected stovetop was dropped");
  assert.equal(wire.stovetopType, null);
});

test("BUG-203 (the invariant): the PATCH body carries NO undefined values at all", () => {
  // 🔴 THIS IS THE GUARD, NOT THE dietaryNotes ASSERTION ABOVE. A key that
  // cannot go `undefined` cannot be silently dropped by the serializer, so the
  // NEXT nullable field added here cannot fail the same way. Drive it with every
  // nullable column emptied at once.
  const emptied = toPatchBody({
    ...FORM,
    cookingSkill: undefined,
    stovetopType: undefined,
    defaultRetailer: undefined,
    dietaryNotes: "",
  });

  const undefinedKeys = Object.entries(emptied)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  assert.deepEqual(
    undefinedKeys,
    [],
    `these keys will be erased by JSON.stringify: ${undefinedKeys.join(", ")}`,
  );

  // Every key survives the round trip, and every nullable one arrives as null.
  const wire = onTheWire(emptied);
  assert.deepEqual(Object.keys(wire).sort(), Object.keys(emptied).sort());
  for (const key of NULLABLE_PREFERENCE_KEYS) {
    assert.equal(wire[key], null, `${key} did not clear to null`);
  }
});

test("BUG-203: toPatchBody peels wantsLeftovers and emits only allow-listed keys", () => {
  const body = toPatchBody(FORM) as Record<string, unknown>;
  // D-WS7-190 — no longer user-set, so it is not echoed back.
  assert.equal("wantsLeftovers" in body, false);
  const leaked = Object.keys(body).filter((k) => !PATCH_ALLOW_LIST.has(k));
  assert.deepEqual(leaked, [], `body carries rejected keys: ${leaked.join(", ")}`);
});

// ── §1's full-field sweep, as an executable record ─────────────────────────
// The prompt asked for EVERY free-text and array field on this PATCH to be
// checked, not just dietaryNotes. This is that check, run rather than asserted
// in prose: for each field, empty it the way its control does and require the
// emptied value to reach the wire.
test("BUG-203: every clearable field on the PATCH survives the clear", () => {
  // Array fields clear to `[]`, which JSON.stringify preserves — they were
  // never broken, and this pins that the fix did not break them.
  const ARRAY_FIELDS = [
    "cuisines",
    "eatingStyles",
    "allergiesAndAvoidances",
    "otherAllergies",
    "cookingEquipment",
    "recurringGroceryItems",
    "healthGoals",
    "pickyAvoidances",
  ] as const;
  for (const field of ARRAY_FIELDS) {
    const wire = onTheWire(toPatchBody({ ...FORM, [field]: [] }));
    assert.ok(field in wire, `${field} was dropped when cleared`);
    assert.deepEqual(wire[field], [], `${field} did not clear to []`);
  }

  // maxCookTimeMinutes already used an explicit null ("No limit") — the one
  // nullable field that was correct before this fix.
  const capped = onTheWire(toPatchBody({ ...FORM, maxCookTimeMinutes: null }));
  assert.ok("maxCookTimeMinutes" in capped);
  assert.equal(capped.maxCookTimeMinutes, null);
});
