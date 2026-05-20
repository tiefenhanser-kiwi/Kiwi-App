// WS7-2 Block B Commit 2 — schema round-trip tests for lib/api/me.ts.
//
// UserPreferencesSchema is the validation boundary for GET/PATCH
// /me/preferences. These tests confirm it accepts the real server shape
// (including explicit JSON null for the four nullable String? columns) and
// rejects malformed payloads — a bad enum value or a missing required field.

import assert from "node:assert/strict";
import { test } from "node:test";

import { UserPreferencesSchema } from "../me";

const VALID_PREFS = {
  spiceTolerance: "mild",
  budgetLevel: "economy",
  cookingSkill: "intermediate",
  stovetopType: "gas",
  defaultRetailer: "Instacart",
  cuisines: ["Italian", "Mexican"],
  allergiesAndAvoidances: [],
  cookingEquipment: ["Oven", "Stove"],
  recurringGroceryItems: ["Milk"],
  eatingStyles: ["Healthy"],
  healthGoals: [],
  pickyAvoidances: ["Mushrooms"],
  householdSize: 3,
  kidsCount: 2,
  pickyEaterCount: 1,
  planLengthDefault: 7,
  wantsLeftovers: true,
  dietaryNotes: null,
};

test("UserPreferencesSchema accepts a valid full payload", () => {
  const parsed = UserPreferencesSchema.parse(VALID_PREFS);
  assert.equal(parsed.spiceTolerance, "mild");
  assert.equal(parsed.cookingSkill, "intermediate");
  assert.deepEqual(parsed.cuisines, ["Italian", "Mexican"]);
});

test("UserPreferencesSchema accepts null for every nullable field", () => {
  const parsed = UserPreferencesSchema.parse({
    ...VALID_PREFS,
    cookingSkill: null,
    stovetopType: null,
    defaultRetailer: null,
    dietaryNotes: null,
  });
  assert.equal(parsed.cookingSkill, null);
  assert.equal(parsed.stovetopType, null);
  assert.equal(parsed.defaultRetailer, null);
  assert.equal(parsed.dietaryNotes, null);
});

test("UserPreferencesSchema rejects an invalid spiceTolerance value", () => {
  const result = UserPreferencesSchema.safeParse({
    ...VALID_PREFS,
    spiceTolerance: "extra_hot",
  });
  assert.equal(result.success, false);
});

test("UserPreferencesSchema rejects a payload missing a required field", () => {
  const { budgetLevel: _omitted, ...withoutBudget } = VALID_PREFS;
  const result = UserPreferencesSchema.safeParse(withoutBudget);
  assert.equal(result.success, false);
});
