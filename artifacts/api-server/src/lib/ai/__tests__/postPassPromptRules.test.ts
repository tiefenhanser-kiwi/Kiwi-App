// WS9 Redesign Arc post-pass Part F ([WS9-arc-PS-F]) — two prompt-quality
// rules, asserted against the REAL seed source (prisma/seeds/aiPrompts.ts +
// the catalog composer's cached prefix), never the DB.
//
// BUG-285 — dry staples were over-quantified (2 cups dry rice for four, twice
// on the same example). Every body that AUTHORS ingredient quantities carries
// one per-serving dry-goods rule, stated DRY, package products excepted; the
// import body keeps the source's numbers and portions only what the source
// left blank. The old "carbonara for 4 = 1 lb spaghetti" examples are gone —
// replace, don't layer.
//
// BUG-286 — the import body TOLD the model to write amounts into the step text
// ("MUST contain the quantities", "Don't refer to ingredients by name without
// quantity") and its vague→explicit examples invented amounts ("Season with 1
// tsp salt and 1/2 tsp black pepper"). That paragraph is replaced: name the
// ingredient, the amount stays in the list; temperatures and timings stay.
//
// Every expected string here is a hand-written literal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DISH_BUILDER_MODE_A_PARSE_BODY,
  IMPORT_REFORMAT_FOR_KIWI_BODY,
  MEAL_BUILDER_ASSIST_INGREDIENTS_BODY,
  MEAL_BUILDER_MODE_A_PARSE_BODY,
  WIZARD_CANDIDATE_EXPAND_BODY,
} from "../../../../prisma/seeds/aiPrompts";
import { STABLE_GENERATE_PREFIX } from "../../storeFillPrompts";

const AUTHORING: ReadonlyArray<readonly [string, string]> = [
  ["meal_builder.mode_a_parse", MEAL_BUILDER_MODE_A_PARSE_BODY],
  ["dish_builder.mode_a_parse", DISH_BUILDER_MODE_A_PARSE_BODY],
  ["meal_builder.assist_ingredients", MEAL_BUILDER_ASSIST_INGREDIENTS_BODY],
  ["wizard.candidate.expand", WIZARD_CANDIDATE_EXPAND_BODY],
  ["store.generate_meal (cached prefix)", STABLE_GENERATE_PREFIX],
];

describe("BUG-285 — dry staples are portioned DRY, per serving", () => {
  it("every authoring body carries the rule: ¼ cup dry grain / 2 oz dry pasta / ⅓ cup dried legumes per serving, stated dry", () => {
    for (const [key, body] of AUTHORING) {
      assert.ok(
        body.includes("1 cup uncooked for four, never 2"),
        `${key}: the rice example (1 cup for four, never 2)`,
      );
      assert.ok(
        body.includes("2 oz") || body.includes("2 ounces per serving"),
        `${key}: dry pasta ≈ 2 oz per serving`,
      );
      assert.ok(
        body.includes("Dried legumes (lentils, dried beans, split peas)"),
        `${key}: dried legumes per serving`,
      );
      assert.ok(
        body.includes("never the cooked yield"),
        `${key}: quantities are stated DRY`,
      );
      assert.ok(
        body.includes("package directions instead") || body.includes("follows its package instead"),
        `${key}: a packaged product follows its package`,
      );
    }
  });

  it("the over-portioned '1 lb spaghetti for 4' examples are gone from the builder bodies (replace, don't layer)", () => {
    for (const [key, body] of AUTHORING) {
      assert.equal(body.includes("1 lb spaghetti"), false, `${key} still teaches 1 lb for four`);
    }
    // The two bodies that carried the carbonara example now teach 8 oz.
    for (const [key, body] of [AUTHORING[0], AUTHORING[2]]) {
      assert.ok(body.includes("8 oz spaghetti"), `${key}: the corrected example`);
    }
  });

  it("the import body keeps the SOURCE's quantities and portions only what the source left blank", () => {
    const b = IMPORT_REFORMAT_FOR_KIWI_BODY;
    assert.ok(b.includes("The quantity is the SOURCE's — never re-portion it."));
    assert.ok(b.includes('when the source gives a cooked amount ("2 cups cooked rice"), keep its number'));
    assert.ok(b.includes("when the source gives NO quantity for a dry staple, portion it per serving"));
  });
});

describe("BUG-286 — imported steps name the ingredient; the amount stays in the list", () => {
  it("the 'embed quantities' command is gone and the list-carries-the-amount rule is in", () => {
    const b = IMPORT_REFORMAT_FOR_KIWI_BODY;
    assert.equal(b.includes("Embed quantities + timings inline"), false);
    assert.equal(b.includes("MUST contain the quantities"), false);
    assert.equal(b.includes("Don't refer to ingredients by name without quantity"), false);
    assert.ok(b.includes("**Name the ingredient; the amount stays in the ingredient list.**"));
    assert.ok(b.includes("Do NOT write ingredient quantities into the step text"));
    assert.ok(b.includes("NEVER invent one the source did not state"));
    // The two licensed exceptions and what stays inline.
    assert.ok(b.includes("(a) the source step itself states it"));
    assert.ok(b.includes("(b) the step uses PART of a listed ingredient"));
    assert.ok(b.includes("Temperatures (\"over medium-high heat\", \"at 425°F\") and durations or doneness cues"));
  });

  it("the vague→explicit examples no longer invent amounts", () => {
    const b = IMPORT_REFORMAT_FOR_KIWI_BODY;
    assert.equal(b.includes("Season with 1 tsp salt and 1/2 tsp black pepper"), false);
    assert.ok(b.includes('"Season to taste" → "Season with salt and black pepper; adjust to taste."'));
    assert.equal(b.includes("Heat 2 tbsp olive oil in a skillet"), false);
    assert.ok(b.includes('"Sauté the onions" → "Heat the olive oil in a skillet over medium heat.'));
  });
});
