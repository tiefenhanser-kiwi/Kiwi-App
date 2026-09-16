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
  // WS9 D-WS9-206 — the new otherAllergies column. It is NOT nullable and has
  // a [] server default, so it is always on the wire; a fixture without it is
  // not a payload the server can produce.
  otherAllergies: [],
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
  // WS9 Redesign Arc Block 2a (D-WS9-245) — the dials are enum keys.
  discoveryLevel: "none",
  playlistLevel: "none",
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
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

// ── WS9 Redesign Arc Block 2a (D-WS9-245) — the two mix dials ──────────────

test("Block 2a: accepts the enum dials and drops the legacy integer echo", () => {
  // The server's TEMPORARY GET echo (D-WS9-245 shim) still rides the wire
  // until the server lane deletes it; a plain z.object() strips it.
  const parsed = UserPreferencesSchema.parse({
    ...VALID_PREFS,
    discoveryLevel: "mostly",
    playlistLevel: "some",
    discoveryMealsPerWeek: 2,
  });
  assert.equal(parsed.discoveryLevel, "mostly");
  assert.equal(parsed.playlistLevel, "some");
  assert.equal("discoveryMealsPerWeek" in parsed, false, "the legacy integer survived parsing");
});

test("Block 2a: REJECTS the old integer shape (no discoveryLevel)", () => {
  const { discoveryLevel: _gone, playlistLevel: _alsoGone, ...legacy } = VALID_PREFS;
  const result = UserPreferencesSchema.safeParse({
    ...legacy,
    discoveryMealsPerWeek: 1,
  });
  assert.equal(result.success, false, "an integer-only payload parsed as a dial");
});

test("Block 2a: rejects an integer where the enum key is expected", () => {
  const result = UserPreferencesSchema.safeParse({
    ...VALID_PREFS,
    discoveryLevel: 2,
  });
  assert.equal(result.success, false);
});

test("Block 2a: playlistLevel is optional on READ until the server lane ships it", () => {
  // A GET from today's server (no playlistLevel key) must still parse — the
  // preferences screen is unusable otherwise. A missing level is none; the
  // coalescing happens in lib/preferencesForm.ts toFormState.
  const { playlistLevel: _absent, ...withoutPlaylist } = VALID_PREFS;
  const parsed = UserPreferencesSchema.parse(withoutPlaylist);
  assert.equal(parsed.playlistLevel, undefined);
  assert.equal(parsed.discoveryLevel, "none");
});
