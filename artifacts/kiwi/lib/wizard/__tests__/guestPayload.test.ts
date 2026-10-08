// Row 13 "Test Kitchen" · Block 2 Part C (R3) — the guest payload's contract.
//
// Two of these are the block's deliberate breaks: send saucePreference, or drop
// allergies, and one of them goes red.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGuestCandidateContext,
  buildGuestShelfRequest,
  buildGuestWizardPayload,
  GUEST_FORM_DEFAULTS,
  guestFormFromStoredPreferences,
  parseGuestFormParam,
  type GuestWizardForm,
} from "../guestPayload";
import { buildShelfRequest, buildWizardPayload } from "../perRunPayload";

const FORM: GuestWizardForm = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: ["italian"],
  eatingStyles: ["vegetarian"],
  allergies: ["peanuts", "shellfish"],
  dietaryNotes: "  no cilantro  ",
  difficulty: "medium",
  weeklyPacing: "mostly_easy",
  additionalNotes: "   ",
  maxCookTimeMinutes: 45,
  maxCookTimeCoverage: "most",
};

// ── what MUST be on the wire ─────────────────────────────────────────────

test("🔴 allergies are ALWAYS sent — a guest has no stored prefs to fall back on", () => {
  const body = buildGuestWizardPayload(FORM);
  assert.deepEqual(body.allergiesAndAvoidances, ["peanuts", "shellfish"]);
});

test("🔴 an EMPTY allergy list is still sent — '[]' is the answer 'none'", () => {
  const body = buildGuestWizardPayload({ ...FORM, allergies: [] });
  assert.ok("allergiesAndAvoidances" in body, "the KEY must be present");
  assert.deepEqual(body.allergiesAndAvoidances, []);
});

test("eating styles are always sent, empty included", () => {
  assert.deepEqual(buildGuestWizardPayload(FORM).eatingStyles, ["vegetarian"]);
  const empty = buildGuestWizardPayload({ ...FORM, eatingStyles: [] });
  assert.ok("eatingStyles" in empty);
  assert.deepEqual(empty.eatingStyles, []);
});

test("the cook-time cap is always sent — null is the answer 'no cap'", () => {
  assert.equal(buildGuestWizardPayload(FORM).maxCookTimeMinutes, 45);
  const uncapped = buildGuestWizardPayload({ ...FORM, maxCookTimeMinutes: null });
  assert.ok("maxCookTimeMinutes" in uncapped);
  assert.equal(uncapped.maxCookTimeMinutes, null);
});

// ── the SAME contract, contrasted with the member builder ────────────────

test("🔴 the member builder DROPS a guest's allergies — this is why this file exists", () => {
  // `hydrated: false` is a guest's permanent state: GET /me/preferences is
  // member-only, so the wizard can never hydrate for them.
  const memberBody = buildWizardPayload(
    { ...FORM, discoveryLevel: "none", playlistLevel: "none", saucePreference: "balanced" },
    false,
  );
  assert.equal("allergiesAndAvoidances" in memberBody, false);
  // The guest builder, same form, same (absent) hydration:
  assert.deepEqual(
    buildGuestWizardPayload(FORM).allergiesAndAvoidances,
    ["peanuts", "shellfish"],
  );
});

test("the member builder is untouched — hydrated: true still sends all seven", () => {
  const body = buildWizardPayload(
    { ...FORM, discoveryLevel: "more", playlistLevel: "none", saucePreference: "homemade" },
    true,
  );
  assert.deepEqual(body.allergiesAndAvoidances, ["peanuts", "shellfish"]);
  assert.equal(body.saucePreference, "homemade");
  assert.equal(body.discoveryLevel, "more");
  assert.equal(body.playlistLevel, "none");
});

// ── what must NEVER be on the wire (R3) ──────────────────────────────────

test("🔴 saucePreference is ABSENT — the guest was never asked, and the claim saves what the request carried", () => {
  const body = buildGuestWizardPayload(FORM) as Record<string, unknown>;
  assert.equal("saucePreference" in body, false);
});

test("🔴 both mix dials are ABSENT", () => {
  const body = buildGuestWizardPayload(FORM) as Record<string, unknown>;
  assert.equal("discoveryLevel" in body, false);
  assert.equal("playlistLevel" in body, false);
});

test("the hidden keys stay absent across every form shape", () => {
  for (const variant of [
    FORM,
    { ...FORM, allergies: [], eatingStyles: [] },
    { ...FORM, maxCookTimeMinutes: null },
    { ...FORM, cuisines: [], dietaryNotes: "", additionalNotes: "" },
  ]) {
    const body = buildGuestWizardPayload(variant) as Record<string, unknown>;
    for (const key of ["saucePreference", "discoveryLevel", "playlistLevel"]) {
      assert.equal(key in body, false, `${key} leaked`);
    }
  }
});

test("maxCookTimeCoverage rides only WITH a cap — with none, 'most' is a hidden default", () => {
  const capped = buildGuestWizardPayload(FORM) as Record<string, unknown>;
  assert.equal(capped.maxCookTimeCoverage, "most");
  const uncapped = buildGuestWizardPayload({
    ...FORM,
    maxCookTimeMinutes: null,
  }) as Record<string, unknown>;
  assert.equal("maxCookTimeCoverage" in uncapped, false);
});

// ── the rest of the body ─────────────────────────────────────────────────

test("difficulty rides — the server schema requires it on every path (D-WS9-031)", () => {
  assert.equal(buildGuestWizardPayload(FORM).difficulty, "medium");
});

test("blank notes are omitted, not sent empty", () => {
  const body = buildGuestWizardPayload(FORM);
  assert.equal(body.dietaryNotes, "no cilantro");
  assert.equal(body.additionalNotes, undefined);
});

// ── the expand context ───────────────────────────────────────────────────

test("the candidate context carries the dietary constraints and not the sauce", () => {
  const ctx = buildGuestCandidateContext(FORM) as Record<string, unknown>;
  assert.deepEqual(ctx.allergiesAndAvoidances, ["peanuts", "shellfish"]);
  assert.deepEqual(ctx.eatingStyles, ["vegetarian"]);
  assert.equal(ctx.planDurationDays, 5);
  assert.equal(ctx.householdSize, 4);
  assert.equal(ctx.wantsLeftovers, false);
  assert.equal(ctx.difficulty, "medium");
  assert.equal("saucePreference" in ctx, false);
});

test("an empty allergy list survives into the expand context too", () => {
  const ctx = buildGuestCandidateContext({ ...FORM, allergies: [] });
  assert.ok("allergiesAndAvoidances" in ctx);
  assert.deepEqual(ctx.allergiesAndAvoidances, []);
});

// ── the round trip through GET /guest/session ────────────────────────────

test("the stored preferences blob rebuilds the form that produced it", () => {
  const blob = buildGuestWizardPayload(FORM);
  const back = guestFormFromStoredPreferences(blob, {
    ...FORM,
    allergies: [],
    eatingStyles: [],
  });
  assert.deepEqual(back.allergies, ["peanuts", "shellfish"]);
  assert.deepEqual(back.eatingStyles, ["vegetarian"]);
  assert.equal(back.maxCookTimeMinutes, 45);
  assert.equal(back.planDurationDays, 5);
});

test("a junk / null blob falls back rather than throwing — a stranded visitor is worse", () => {
  assert.deepEqual(guestFormFromStoredPreferences(null, FORM), FORM);
  assert.deepEqual(guestFormFromStoredPreferences("nope", FORM), FORM);
  assert.deepEqual(guestFormFromStoredPreferences({ allergies: 7 }, FORM), FORM);
});

test("a partial blob keeps the fields it has and falls back on the rest", () => {
  const back = guestFormFromStoredPreferences(
    { planDurationDays: 3, allergiesAndAvoidances: ["eggs"] },
    FORM,
  );
  assert.equal(back.planDurationDays, 3);
  assert.deepEqual(back.allergies, ["eggs"]);
  assert.equal(back.householdSize, FORM.householdSize);
});

test("an uncapped stored blob round-trips as uncapped", () => {
  const blob = buildGuestWizardPayload({ ...FORM, maxCookTimeMinutes: null });
  const back = guestFormFromStoredPreferences(blob, FORM);
  assert.equal(back.maxCookTimeMinutes, null);
  // No coverage was stored, so the fallback's value stands — and the next
  // payload built from it omits coverage again, because the cap is still null.
  const rebuilt = buildGuestWizardPayload(back) as Record<string, unknown>;
  assert.equal("maxCookTimeCoverage" in rebuilt, false);
});

// ── Resub C4 — the guest shelf request and the form's route hop ─────────────

test("C4 🔴 the guest SHELF request carries the allergies — the member shelf builder would drop them", () => {
  const body = buildGuestShelfRequest(FORM);
  assert.deepEqual(body.allergiesAndAvoidances, ["peanuts", "shellfish"]);
  assert.deepEqual(body.eatingStyles, ["vegetarian"]);
  // The guest shelf body IS the build-plans body (plus paging only).
  assert.deepEqual(body, buildGuestWizardPayload(FORM));
  // The member builder, unhydrated (a guest is never hydrated), drops them.
  assert.equal("allergiesAndAvoidances" in buildShelfRequest({ ...FORM, discoveryLevel: "none", playlistLevel: "none", saucePreference: "balanced" }, false), false);
});

test("C4 the guest shelf request never carries text, source, sauce or the dials", () => {
  const body = buildGuestShelfRequest(FORM, { excludeMealIds: ["a", "b"], size: 5 }) as Record<string, unknown>;
  for (const k of ["text", "source", "saucePreference", "discoveryLevel", "playlistLevel"]) {
    assert.equal(k in body, false, k);
  }
  assert.deepEqual(body.excludeMealIds, ["a", "b"]);
  assert.equal(body.size, 5);
  // An empty exclusion list is omitted, as the member builder omits it.
  assert.equal("excludeMealIds" in buildGuestShelfRequest(FORM, { excludeMealIds: [] }), false);
});

test("C4 the form survives the wizard → /test-kitchen/pick hop", () => {
  assert.deepEqual(parseGuestFormParam(JSON.stringify(FORM), GUEST_FORM_DEFAULTS), FORM);
  const uncapped = { ...FORM, maxCookTimeMinutes: null, allergies: [] };
  assert.deepEqual(parseGuestFormParam(JSON.stringify(uncapped), GUEST_FORM_DEFAULTS), uncapped);
});

test("C4 🔴 a form whose allergies are missing or junk is REFUSED, never defaulted to []", () => {
  const { allergies: _a, ...noAllergies } = FORM;
  assert.equal(parseGuestFormParam(JSON.stringify(noAllergies), GUEST_FORM_DEFAULTS), null);
  assert.equal(parseGuestFormParam(JSON.stringify({ ...FORM, allergies: "peanuts" }), GUEST_FORM_DEFAULTS), null);
  assert.equal(parseGuestFormParam("{not json", GUEST_FORM_DEFAULTS), null);
  assert.equal(parseGuestFormParam(undefined, GUEST_FORM_DEFAULTS), null);
});
