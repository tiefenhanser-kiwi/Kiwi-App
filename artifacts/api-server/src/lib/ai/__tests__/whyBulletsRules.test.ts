// WS9 BUG-190 — the whyBullets claim rules, asserted against the REAL prompt
// bodies rather than a synthetic stand-in (same idiom as cleanupClaimRules).
//
// A live plan offered "asparagus in two meals" as a saving and "3 vegetables
// can be bought in one farmer's market trip" as an advantage. Hans: "the
// advantages it's saying aren't applicable or real."
//
// The cause is structural. whyBullets are authored at CANDIDATE time, where the
// input carries preferences plus a shelf of meal TITLES/macros/times and NO
// ingredient data — the meals do not exist yet. The old bodies nonetheless
// taught quantity-grounded examples ("One bunch of cilantro covers both the
// tacos and the curry"), which this stage cannot ground, so the model degraded
// them into co-occurrence claims. The examples are REPLACED, not softened.
//
// All three plan generators emit whyBullets, so all three carry the rules and
// this test covers all three. Every expected string below is a hand-written
// literal; nothing here reads WHY_BULLETS_RULES, so a change to the shared const
// cannot silently satisfy the assertions.

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

describe("BUG-190 — whyBullets claim rules reach every plan generator", () => {
  it("the taught quantity-grounded examples are gone from all three bodies", () => {
    // Each of these taught a sharing claim this stage cannot ground. Replaced,
    // not softened — §10: we do not layer a correction on the thing corrected.
    const taught = [
      "One bunch of cilantro covers both the tacos and the curry",
      "The half-can of chipotle from Monday's chili",
      "The cilantro from your tacos gets used up in the paired curry",
      "a crossover ingredient",
    ];
    for (const [key, body] of BODIES) {
      for (const example of taught) {
        assert.equal(
          body.includes(example),
          false,
          `${key} must not teach the ungroundable sharing claim: ${example}`,
        );
      }
    }
  });

  it("every body bans sharing claims and says why", () => {
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes(
          "You may not claim anything about ingredients being shared, used up, stretched, or bought once.",
        ),
        `${key} must ban the sharing claim outright`,
      );
      assert.ok(
        body.includes("never quantities and never pack sizes"),
        `${key} must state that no ingredient/pack data exists at this stage`,
      );
      assert.ok(
        body.includes("CO-OCCURRENCE"),
        `${key} must name co-occurrence as the thing that is not a saving`,
      );
    }
  });

  it("every body names the two live bullets Hans rejected", () => {
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes("Asparagus features in two meals"),
        `${key} must ban the co-occurrence bullet shape`,
      );
      assert.ok(
        body.includes(
          "Three vegetables you can grab in one farmer's market trip",
        ),
        `${key} must ban the one-trip non-advantage`,
      );
    }
  });

  it("every body leads with preference fit, free text first", () => {
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes("Lead with what the user told you, in their own words."),
        `${key} must put the user's own words first`,
      );
      assert.ok(
        body.includes("preferencesContext.maxCookTimeMinutes"),
        `${key} must offer the cook-time cap as claimable structured fit`,
      );
    }
  });

  it("every body permits fewer bullets rather than padded ones", () => {
    for (const [key, body] of BODIES) {
      assert.ok(
        body.includes("write ONE bullet and stop"),
        `${key} must allow a single honest bullet`,
      );
      assert.ok(
        body.includes("Never invent a second to reach a count."),
        `${key} must forbid padding to a count`,
      );
    }
  });

  it("no body still authorizes a sharing claim via the cleanup rules", () => {
    // CLEANUP_CLAIM_RULES listed "Ingredients shared across meals — buy once,
    // less waste" and "Prep genuinely done once and used across several nights"
    // as ALLOWED. Both authorize exactly what BUG-190 bans, and neither is
    // groundable here, so both allowances were removed. This only tightens the
    // BUG-179 guard — see cleanupClaimRules.test.ts for its prohibitions, which
    // are unchanged.
    for (const [key, body] of BODIES) {
      assert.equal(
        body.includes("Ingredients shared across meals"),
        false,
        `${key} must not list ingredient sharing as an allowed cleanup claim`,
      );
      assert.equal(
        body.includes("Prep genuinely done once"),
        false,
        `${key} must not list cross-night prep as an allowed cleanup claim`,
      );
    }
  });

  it("waste guidance survives as menu composition, sealed off from claims", () => {
    // The waste heuristic still shapes WHICH meals get picked — it is good
    // planning. What changed is that it is explicitly not sayable. Surprise-me
    // has no composition section, so this covers the two that do.
    for (const [key, body] of [BODIES[0], BODIES[1]] as const) {
      assert.ok(
        body.includes(
          "# Menu composition — waste (this shapes what you PICK, never what you SAY)",
        ),
        `${key} must keep the waste heuristic as composition guidance`,
      );
      assert.ok(
        body.includes("None of this belongs in"),
        `${key} must seal the composition guidance off from whyBullets`,
      );
    }
  });

  it("each body names the free-text fields its own path actually carries", () => {
    // The three paths carry different free text. additionalNotes exists ONLY on
    // the build-plans request body (no UserPreferences column, and no client
    // sends it to Tell Kiwi or Surprise-me), so the other two bodies must point
    // at what they really have instead of a field that will never arrive.
    assert.ok(
      WIZARD_SET_PREFERENCES_GENERATE_BODY.includes(
        "The words the user typed themselves are `additionalNotes`, `dietaryNotes`, and `hiddenContext.pickyAvoidances`",
      ),
    );
    assert.ok(
      WIZARD_DIRECTED_GENERATE_BODY.includes(
        "The words the user typed themselves are `userInput`, `dietaryNotes`, and `hiddenContext.pickyAvoidances`",
      ),
    );
    assert.equal(
      WIZARD_SURPRISE_GENERATE_BODY.includes("There is no user free-text."),
      false,
      "surprise must not claim the user wrote nothing — dietaryNotes and pickyAvoidances are their words",
    );
    assert.ok(
      WIZARD_SURPRISE_GENERATE_BODY.includes(
        "`dietaryNotes` and `hiddenContext.pickyAvoidances` are their own words",
      ),
    );
  });
});
