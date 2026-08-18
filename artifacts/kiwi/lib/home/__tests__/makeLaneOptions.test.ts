// WS9-2 2e Part 2 Phase 4 (§4.5) — the "Add my own meals" predicate.
//
// app/(tabs)/index.tsx is outside the test glob, so this decision was
// unguarded while it sat inline. It is the subtlest thing in the 2e Home work:
// three separate ways to get it wrong, each of which looks like a tidy-up.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADD_OWN_MEALS_TOAST,
  shouldOfferAddOwnMeals,
} from "../makeLaneOptions";

test("no saved plans → the option is offered", () => {
  assert.equal(shouldOfferAddOwnMeals(0), true);
});

test("any saved plan → the option is absent", () => {
  assert.equal(shouldOfferAddOwnMeals(1), false);
  assert.equal(shouldOfferAddOwnMeals(7), false);
});

test("⚠️ UNKNOWN IS NOT ZERO — an unresolved count suppresses the option", () => {
  // While the plans query is in flight the count is undefined, meaning "we have
  // not looked yet". Coercing that to 0 (`count ?? 0`, or a truthiness check on
  // the data object) renders the option and then RETRACTS it a beat later,
  // which is worse than showing it late — and it is the exact mistake the
  // isFirstRun gate already documents avoiding.
  assert.equal(shouldOfferAddOwnMeals(undefined), false);
});

test("the three cases are exhaustive and distinct", () => {
  // undefined and 0 must NOT collapse to the same answer — that collapse is the
  // whole bug this predicate exists to prevent.
  assert.notEqual(
    shouldOfferAddOwnMeals(undefined),
    shouldOfferAddOwnMeals(0),
    "unknown and zero must produce different answers",
  );
  assert.equal(shouldOfferAddOwnMeals(undefined), shouldOfferAddOwnMeals(1));
});

test("the predicate is COUNT-based, not first-run-based", () => {
  // ⚠️ The tempting simplification is `isFirstRun`, which is right there in the
  // same component. It is wrong: firstPlanCreatedAt is a permanent stamp, so a
  // user who creates a plan and composts it is NOT first-run but HAS zero saved
  // plans — and is exactly who this option is for. A count of 0 must offer the
  // option regardless of how long the account has existed.
  //
  // Expressed as a contract: the function takes a COUNT and nothing else. It
  // has no access to a first-run flag and cannot be made to depend on one
  // without changing its signature, which is the point.
  assert.equal(shouldOfferAddOwnMeals.length, 1, "one input: the count");
  assert.equal(
    shouldOfferAddOwnMeals(0),
    true,
    "zero saved plans offers the option even for a long-lived account",
  );
});

test("the arrival toast copy is verbatim", () => {
  assert.equal(ADD_OWN_MEALS_TOAST, "Anytime: Recipes → Meals → Add Meal.");
});
