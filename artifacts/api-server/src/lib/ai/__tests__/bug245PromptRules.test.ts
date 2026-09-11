// WS9 BUG-245 — a fresh dinner under a cap must realistically fit it, asserted
// against the REAL seed source (prisma/seeds/aiPrompts.ts), never the DB.
//
// Measured on the device round of September 11, 2026: under a 30-minute cap
// the title stage composed "birria tacos with consommé" and "sheet pan
// sausage" fresh; the draft showed 30 and 30, the saved meals derived 44 and
// 56. The old sentence called the cap "a soft bias" for fresh titles — a bias
// is exactly what a live model reads past. It now LIMITS what may be chosen,
// stated as a property of the dinner (time from opening the fridge, prep
// included; what braises/roasts/bakes/simmers longer does not fit), not as a
// menu — D-WS9-073 measured that a named list is what the model over-indexes
// on, and it would fight BUG-249's variety rule.
//
// The 'most' clause also names the ceiling D-WS7-166 now enforces on the shelf
// (one row, at most 20 minutes over — Hans: "mostly only 30 minutes should max
// at 50 minutes").
//
// Every expected string here is a hand-written literal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WIZARD_SET_PREFERENCES_GENERATE_BODY,
  WIZARD_DIRECTED_GENERATE_BODY,
  WIZARD_SURPRISE_GENERATE_BODY,
} from "../../../../prisma/seeds/aiPrompts";

const ALL: ReadonlyArray<readonly [string, string]> = [
  ["wizard.set_preferences.generate", WIZARD_SET_PREFERENCES_GENERATE_BODY],
  ["wizard.directed.generate", WIZARD_DIRECTED_GENERATE_BODY],
  ["wizard.surprise.generate", WIZARD_SURPRISE_GENERATE_BODY],
];

describe("BUG-245 — a fresh dinner under a cap must realistically fit it", () => {
  it("every body states the fresh-dinner rule as a limit on what may be chosen", () => {
    for (const [key, body] of ALL) {
      assert.ok(
        body.includes("the cap limits what you may choose"),
        `${key}: the cap must LIMIT fresh choices`,
      );
      assert.ok(
        body.includes(
          "pick only a dinner a home cook can realistically put on the table in that many minutes from opening the fridge, prep included",
        ),
        `${key}: the rule must be stated as a property of the dinner (fridge-to-table, prep included)`,
      );
      assert.ok(
        body.includes("Anything that braises, roasts, bakes or simmers longer than the cap does not fit, however it is named"),
        `${key}: long unattended cooking must be named as not fitting`,
      );
      assert.ok(
        body.includes("If no fresh dinner honestly fits a slot, use a shelf meal."),
        `${key}: the fallback is the shelf, never a lie`,
      );
    }
  });

  it("'soft bias' no longer describes the cap for fresh titles, in any body", () => {
    for (const [key, body] of ALL) {
      assert.equal(body.includes("soft bias"), false, key);
      assert.equal(body.includes("plausibly cook within it"), false, key);
    }
  });

  it("the 'most' clause names the 20-minute ceiling in every body (D-WS7-166)", () => {
    for (const [key, body] of ALL) {
      assert.ok(
        body.includes("at most one shelf row runs over it, by at most 20 minutes"),
        `${key}: the one over-cap shelf row is bounded at +20`,
      );
    }
  });

  it("directed still honors an explicitly named meal regardless of the cap", () => {
    assert.ok(
      WIZARD_DIRECTED_GENERATE_BODY.includes("An explicitly named meal is honored regardless."),
    );
  });

  // The rule describes a PROPERTY, not a menu. One illustrative example per
  // body at most, never the same food twice across bodies (D-WS9-073).
  it("no body carries a menu of quick dinners, and no example food repeats across bodies", () => {
    const menuWords = ["tacos", "quesadilla", "sandwich", "mac and cheese", "hot dog"];
    for (const [key, body] of ALL) {
      const capRule = body.slice(body.indexOf("the cap limits what you may choose"));
      const capSentence = capRule.slice(0, capRule.indexOf("\n"));
      for (const w of menuWords) {
        assert.equal(capSentence.toLowerCase().includes(w), false, `${key}: menu word "${w}" in the cap rule`);
      }
    }
    // The two examples that do exist are different foods.
    assert.ok(WIZARD_DIRECTED_GENERATE_BODY.includes("a whole roast is not a 30-minute dinner"));
    assert.ok(WIZARD_SET_PREFERENCES_GENERATE_BODY.includes("a slow-simmered stew is not a 30-minute dinner"));
    assert.equal(WIZARD_SET_PREFERENCES_GENERATE_BODY.includes("a whole roast is not"), false);
    assert.equal(WIZARD_DIRECTED_GENERATE_BODY.includes("a slow-simmered stew is not"), false);
    assert.equal(WIZARD_SURPRISE_GENERATE_BODY.includes("is not a 30-minute dinner"), false);
  });

  // D-WS9-073 — the rotation sections were not touched. Byte-identity is
  // checked by hash in the block report; this pins the guard phrase each body
  // owns so the cap rewrite cannot have eaten it.
  it("each body's OWN shelf-guard phrase on the rotation section survives", () => {
    assert.ok(WIZARD_SET_PREFERENCES_GENERATE_BODY.includes("never abandoning the shelf"));
    assert.ok(WIZARD_DIRECTED_GENERATE_BODY.includes("not abandoning the shelf"));
    assert.equal(WIZARD_SURPRISE_GENERATE_BODY.includes("# Recent history — vary the rotation"), false);
  });
});
