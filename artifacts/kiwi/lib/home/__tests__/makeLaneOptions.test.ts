// WS9-2 2e Part 2 Phase 4 (§4.5) → Row 5 Block 4 (D-WS9-247 amendment) — the
// "Set up my Playlist" predicate.
//
// app/(tabs)/index.tsx is outside the test glob, so this decision was
// unguarded while it sat inline. Hans's rule, September 18: "it displays until
// a user has a meal or they click the button" — offered ⇔ NO meals AND NOT
// tapped. Both halves come from GET /home (per-user, never per-device).

import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldOfferAddOwnMeals } from "../makeLaneOptions";

const FRESH = { hasMeals: false, playlistCtaTappedAt: null };

test("no meals AND never tapped → the option is offered", () => {
  assert.equal(shouldOfferAddOwnMeals(FRESH), true);
});

test("has a meal → absent, even if never tapped (the half Hans named first)", () => {
  assert.equal(shouldOfferAddOwnMeals({ hasMeals: true, playlistCtaTappedAt: null }), false);
});

test("tapped → absent, even with no meals (the half that hides it on every device)", () => {
  assert.equal(
    shouldOfferAddOwnMeals({ hasMeals: false, playlistCtaTappedAt: "2026-09-18T20:00:00.000Z" }),
    false,
  );
});

test("both → absent", () => {
  assert.equal(
    shouldOfferAddOwnMeals({ hasMeals: true, playlistCtaTappedAt: "2026-09-18T20:00:00.000Z" }),
    false,
  );
});

test("⚠️ UNKNOWN IS NOT 'NO' — an unloaded payload suppresses the option", () => {
  // While GET /home is in flight the payload is undefined, meaning "we have
  // not looked yet". Treating that as fresh renders the option and then
  // RETRACTS it a beat later, which is worse than showing it late — the exact
  // mistake the isFirstRun gate already documents avoiding.
  assert.equal(shouldOfferAddOwnMeals(undefined), false);
  assert.notEqual(
    shouldOfferAddOwnMeals(undefined),
    shouldOfferAddOwnMeals(FRESH),
    "unknown and fresh must produce different answers",
  );
});

test("the tapped half is a null-check on the stamp, not a truthiness check on a string", () => {
  // An empty string is not a valid ISO stamp and the server never sends one,
  // but if it did, it is NOT null — the card must stay hidden. Guards against
  // `!playlistCtaTappedAt`.
  assert.equal(shouldOfferAddOwnMeals({ hasMeals: false, playlistCtaTappedAt: "" }), false);
});

test("the predicate takes the payload's gate fields and nothing else", () => {
  // Expressed as a contract: one input, the GET /home gate shape. It has no
  // access to a saved-plan count or a first-run flag and cannot be made to
  // depend on either without changing its signature, which is the point.
  assert.equal(shouldOfferAddOwnMeals.length, 1, "one input: the home gate fields");
});
