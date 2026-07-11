// Block 5 regression — the preferences edit-buffer seed must not carry any
// server-only (read-only) column into the form. If it does, handleSave PATCHes
// it back and the server's `.strict()` allow-list rejects the whole request
// with a silent 400 (the weeklyPacingDefault save-failure bug).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SERVER_ONLY_PREFERENCE_KEYS,
  toFormState,
} from "../preferencesForm";
import type { UserPreferences } from "../api/me";

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
