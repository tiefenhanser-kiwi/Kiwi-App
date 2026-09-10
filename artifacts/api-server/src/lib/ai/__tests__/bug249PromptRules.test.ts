// WS9 BUG-249 — the cross-candidate repeat rule, the corrected cook-time
// sentences, and the surprise body's stale three-candidate paragraph, asserted
// against the REAL seed source (prisma/seeds/aiPrompts.ts), never the DB.
//
// Hans: "When Kiwi generates plans, it shouldn't repeat the same meal across
// the plans it suggests." Measured before this: a cross-candidate repeat in 4 of
// 5 stored multi-candidate batches, every one a shelf meal. None of the variety
// text said a meal may not appear in two plans — it said the plans must not
// "feel alike".
//
// Every expected string here is a hand-written literal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WIZARD_SET_PREFERENCES_GENERATE_BODY,
  WIZARD_DIRECTED_GENERATE_BODY,
  WIZARD_SURPRISE_GENERATE_BODY,
} from "../../../../prisma/seeds/aiPrompts";

const MULTI_CANDIDATE: ReadonlyArray<readonly [string, string]> = [
  ["wizard.set_preferences.generate", WIZARD_SET_PREFERENCES_GENERATE_BODY],
  ["wizard.directed.generate", WIZARD_DIRECTED_GENERATE_BODY],
];
const ALL: ReadonlyArray<readonly [string, string]> = [
  ...MULTI_CANDIDATE,
  ["wizard.surprise.generate", WIZARD_SURPRISE_GENERATE_BODY],
];

describe("BUG-249 — no Kiwi-chosen meal in two suggested plans", () => {
  it("the cross-candidate rule is present in every multi-candidate body, scoped to THIS response", () => {
    for (const [key, body] of MULTI_CANDIDATE) {
      assert.ok(
        body.includes("may appear in more than one candidate of THIS response"),
        `${key} must carry the cross-candidate rule`,
      );
      // Scoped to the response — never general repeat-avoidance (D-WS9-039:
      // a loved meal may recur across weeks).
      assert.ok(
        body.includes("meals from the user's earlier plans are the rotation section's concern"),
        `${key} must point earlier-plan repeats at the rotation section, not this rule`,
      );
    }
  });

  it("directed keeps explicit meals LOCKED in every candidate, as the one exception", () => {
    assert.ok(
      WIZARD_DIRECTED_GENERATE_BODY.includes(
        "the explicit meals are LOCKED in every candidate — they are the one exception to the rule above",
      ),
    );
  });

  // D-WS9-073 — the fatigue nudge is a DIFFERENT rule and its guard phrase
  // differs by body. Byte-identity is checked by hash in the block report; this
  // pins the phrase each body owns so a rewrite of the distinctness text cannot
  // quietly eat it.
  it("each body's OWN shelf-guard phrase on the rotation section survives", () => {
    assert.ok(
      WIZARD_SET_PREFERENCES_GENERATE_BODY.includes("never abandoning the shelf"),
      "set_preferences: 'never abandoning the shelf'",
    );
    assert.ok(
      WIZARD_DIRECTED_GENERATE_BODY.includes("not abandoning the shelf"),
      "directed: 'not abandoning the shelf'",
    );
  });

  it("no body still claims cook time cannot be verified — shelf rows carry a measured time now", () => {
    for (const [key, body] of ALL) {
      assert.equal(body.includes("cannot verify exact cook time"), false, key);
      assert.equal(body.includes("not a ceiling"), false, key);
      assert.equal(body.includes("hard ceiling"), false, key);
      assert.ok(
        body.includes("measured from"),
        `${key} must say the shelf time is measured from the meal's steps`,
      );
      assert.ok(
        body.includes('maxCookTimeCoverage: "most"'),
        `${key} must name the 'most' exception (at most one over-cap shelf row)`,
      );
    }
  });

  it("surprise generates ONE candidate and no longer carries the three-candidate distinctness paragraph", () => {
    assert.ok(
      WIZARD_SURPRISE_GENERATE_BODY.includes("1 candidate plan with exactly `planDurationDays` dinners"),
    );
    assert.ok(WIZARD_SURPRISE_GENERATE_BODY.includes("Generate 1 crowd-pleaser candidate now."));
    assert.equal(WIZARD_SURPRISE_GENERATE_BODY.includes("Three candidates that all feel the same is failure"), false);
    assert.equal(WIZARD_SURPRISE_GENERATE_BODY.includes("# Distinctness"), false);
    // And nothing else was added: no rotation section (deliberate, D-WS9-073)
    // and no cross-candidate rule (a single candidate has nothing to repeat).
    assert.equal(WIZARD_SURPRISE_GENERATE_BODY.includes("# Recent history — vary the rotation"), false);
    assert.equal(WIZARD_SURPRISE_GENERATE_BODY.includes("more than one candidate of THIS response"), false);
  });
});
