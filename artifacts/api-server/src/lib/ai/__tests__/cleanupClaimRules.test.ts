// WS9 BUG-179 — the cleanup/effort claim rules, asserted against the REAL
// prompt bodies rather than a synthetic stand-in.
//
// A live plan said "Meals 1 and 3 both use the sheet pan — same pan, similar
// oven temp, so cleanup is cut in half on those nights". That is false: two
// sheet-pan dinners on two nights are two preheats and two washes. It was not
// an accident of generation — the directed prompt taught it, carrying "Salmon
// Tuesday + roasted veggies Wednesday — same sheet pan, half the cleanup" as a
// STRONG example.
//
// All three plan generators emit whyBullets, so all three carry the rules and
// this test covers all three. Every expected string below is a hand-written
// literal; nothing here reads CLEANUP_CLAIM_RULES, so a change to the shared
// const cannot silently satisfy the assertions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WIZARD_SET_PREFERENCES_GENERATE_BODY,
  WIZARD_DIRECTED_GENERATE_BODY,
  WIZARD_SURPRISE_GENERATE_BODY,
} from "../../../../prisma/seeds/aiPrompts";

const BODIES: ReadonlyArray<readonly [string, string]> = [
  ["wizard.set_preferences.generate", WIZARD_SET_PREFERENCES_GENERATE_BODY],
  ["wizard.directed.generate", WIZARD_DIRECTED_GENERATE_BODY],
  ["wizard.surprise.generate", WIZARD_SURPRISE_GENERATE_BODY],
];

describe("BUG-179 — cleanup/effort claim rules reach every plan generator", () => {
  it("the taught false example is gone from all three bodies", () => {
    // The exact string that produced the live claim. REPLACED, not softened —
    // §10: we do not layer a correction on top of the thing being corrected.
    for (const [key, body] of BODIES) {
      assert.equal(
        body.includes("same sheet pan, half the cleanup"),
        false,
        `${key} must not teach the cross-night halved-cleanup claim`,
      );
      assert.equal(
        body.includes("Salmon Tuesday + roasted veggies Wednesday"),
        false,
        `${key} must not carry the two-nights-one-pan example`,
      );
    }
  });

  it("every body states the different-nights prohibition", () => {
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes("You wash it in between"),
        `${key} must say why shared equipment across nights saves nothing`,
      );
      assert.ok(
        body.includes("those are separate preheats") ||
          body.includes("Those are separate preheats"),
        `${key} must say why a shared oven temp across nights saves nothing`,
      );
    }
  });

  it("every body separates dish count from total effort", () => {
    // Hans's second rule: "a charcoal grill is more work than cleaning a plan."
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes("claim the dish count, not the total effort"),
        `${key} must forbid equating few dishes with an easy night`,
      );
    }
  });

  it("the claim is NOT banned — a low-dish method stays sayable", () => {
    // Hans: "I don't want to prevent it from saying 'grill every night this
    // week, keep the dishes to a minimum'." A per-night method property is real.
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes("grill every night this week and keep the dishes to a minimum"),
        `${key} must keep the low-dish method claim available`,
      );
      assert.ok(
        body.includes("SAME NIGHT"),
        `${key} must allow the genuinely-shared same-night case`,
      );
    }
  });

  it("set_preferences keeps its correct per-night method example", () => {
    // "Sheet-pan and one-pot meals minimize cleanup midweek" is a property of
    // the METHOD on each night, not a saving spread across nights. It was
    // already right and is deliberately left alone.
    assert.ok(
      WIZARD_SET_PREFERENCES_GENERATE_BODY.includes(
        "Sheet-pan and one-pot meals minimize cleanup midweek",
      ),
    );
  });
});
