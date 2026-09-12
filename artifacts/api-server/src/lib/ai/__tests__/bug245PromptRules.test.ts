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
import { createHash } from "node:crypto";

import {
  WIZARD_SET_PREFERENCES_GENERATE_BODY,
  WIZARD_DIRECTED_GENERATE_BODY,
  WIZARD_SURPRISE_GENERATE_BODY,
  WIZARD_CANDIDATE_EXPAND_BODY,
} from "../../../../prisma/seeds/aiPrompts";
import { MOST_COVERAGE_OVERAGE_MINUTES } from "../../store/storeShortlist";

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
      // D-WS7-166 (v9) — the cap is a CEILING. The September 11 round measured
      // every live authored estimate landing exactly at the cap (30 · 28 · 30 ·
      // 30) under the old "put on the table in that many minutes" wording,
      // which Hans read as "aim for meals that take as long as the cap".
      assert.ok(
        body.includes(
          "The cap is a ceiling, not a target: every dinner must be on the table within it, from opening the fridge with prep included, and comfortably under is better than close to it. A 20-minute dinner is a good answer to a 30-minute limit, not a missed one — do not stretch a plan's dinners to fill the time allowed.",
        ),
        `${key}: the cap must read as a ceiling, not a target`,
      );
      assert.equal(
        body.includes("in that many minutes"),
        false,
        `${key}: the duration-to-hit wording must be gone`,
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

  // D-WS7-166 (v9) — the rotation sections are pinned BY HASH, sliced by
  // heading (the section runs from its "# Recent history" heading to the next
  // "\n# " heading), so a cap rewrite anywhere in the body cannot drift them.
  // The literals are the sections' sha256 as measured before the v9 edit; a
  // deliberate D-WS9-073 change re-measures and replaces them.
  it("the D-WS9-073 rotation sections are byte-identical to their pre-v9 hashes", () => {
    const heading = "# Recent history — vary the rotation";
    const section = (body: string): string => {
      const i = body.indexOf(heading);
      assert.ok(i >= 0, "rotation heading missing");
      const j = body.indexOf("\n# ", i + heading.length);
      return body.slice(i, j < 0 ? undefined : j);
    };
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    assert.equal(
      sha(section(WIZARD_SET_PREFERENCES_GENERATE_BODY)),
      "5d73d3c1348820fdb8bd4f2aa3c519949882076806681a4649e2b55b5db35f49",
      "set_preferences rotation section drifted",
    );
    assert.equal(
      sha(section(WIZARD_DIRECTED_GENERATE_BODY)),
      "d2b9d421a8161ea8b59e55d23b51d78b2d8dda7a635ded93197069e5495b66fb",
      "directed rotation section drifted",
    );
  });
});

// D-WS7-166 (expand v9) — the one body aa13fc6 did not reach. The v8 cap
// section told the expand pass to "aim every meal at the cap" — the prompt
// that authored 30 · 28 · 30 · 30 on the September 11 round. Hans: "it's not
// saying 'anything under that cap is eligible' it's 'aim for meals that take
// as long as the cap' where it really should be the first version and honor
// the cap." The two coverage bullets are REPLACED; the outline section v8
// added (its round passed) is pinned by hash so a cap rewrite cannot drift it.
describe("D-WS7-166 (expand v9) — the cap is a ceiling in wizard.candidate.expand too", () => {
  const body = WIZARD_CANDIDATE_EXPAND_BODY;

  it("neither 'aim at the cap' bullet survives", () => {
    assert.equal(body.includes("aim every meal at the cap"), false, "'all' bullet still aims at the cap");
    assert.equal(body.includes("aim every other meal at the cap"), false, "'most' bullet still aims at the cap");
  });

  it("the cap is stated as a ceiling, not a target, with the 20-for-30 example", () => {
    assert.ok(body.includes("The cap is a ceiling, not a target"), "ceiling sentence missing");
    assert.ok(
      body.includes("a 20-minute dinner is a good answer to a 30-minute limit, not a missed one"),
      "the under-the-cap example is what makes 'ceiling' concrete",
    );
  });

  it("the 'most' overage in the prose is the constant the shelf enforces", () => {
    assert.equal(MOST_COVERAGE_OVERAGE_MINUTES, 20);
    assert.ok(
      body.includes(`may run over the cap, and never by more than ${MOST_COVERAGE_OVERAGE_MINUTES} minutes`),
      "the prose must state the same overage storeShortlist enforces",
    );
  });

  // The literal is the section's sha256 measured before the v9 edit (v8's
  // outline text, BUG-245 d5cd6b3); a deliberate outline change re-measures it.
  it("the v8 outline section is byte-identical to its pre-v9 hash", () => {
    const heading = "# The timed outline (no step text)";
    const i = body.indexOf(heading);
    assert.ok(i >= 0, "outline heading missing");
    const j = body.indexOf("\n# ", i + heading.length);
    const section = body.slice(i, j < 0 ? undefined : j);
    assert.equal(
      createHash("sha256").update(section).digest("hex"),
      "ef2a67584e680536379fd0d4b0d2f201e92d4538c1e67ac6b7c471b8423ff815",
      "expand outline section drifted",
    );
  });
});
