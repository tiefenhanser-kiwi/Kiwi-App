// WS9 Redesign Arc Block 1 — prompt-body rules, asserted against the REAL
// seed source (prisma/seeds/aiPrompts.ts), never the DB.
//
// (1) D-WS9-245 — "discovery" means meals NEW TO THIS USER that still match
//     their preferences. The old paragraph in both generate bodies read
//     "outside the preferred cuisines" and was a no-op without a cuisine
//     steer; Hans (September 16): "good every time, which makes it great" —
//     no random or out-of-preference picks. The paragraph is REPLACED, not
//     layered (§10), and the count the bodies read is the integer the resolver
//     derives from the level (levelToCount), so the bodies must not pin 0..2.
//
// (2) The brand-name rule in meal_builder.mode_a_parse, modelled on
//     storeFillPrompts.ts "# Shortcut mode": a named product IS the ingredient
//     line; package directions govern what it needs; never a from-scratch
//     recipe for it.
//
// Every expected string here is a hand-written literal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEAL_BUILDER_MODE_A_PARSE_BODY,
  WIZARD_DIRECTED_GENERATE_BODY,
  WIZARD_SET_PREFERENCES_GENERATE_BODY,
} from "../../../../prisma/seeds/aiPrompts";

const GENERATE_BODIES: ReadonlyArray<readonly [string, string]> = [
  ["wizard.set_preferences.generate", WIZARD_SET_PREFERENCES_GENERATE_BODY],
  ["wizard.directed.generate", WIZARD_DIRECTED_GENERATE_BODY],
];

describe("D-WS9-245 — discovery is new-to-this-user, inside their preferences", () => {
  it("both generate bodies state the new meaning and drop the old one", () => {
    for (const [key, body] of GENERATE_BODIES) {
      assert.ok(
        body.includes(
          "must be meals this user has NOT been served before — not in `recentRotation`, and not a dish family they have already had — while still inside their stated cuisines and preferences",
        ),
        `${key}: new discovery meaning missing`,
      );
      assert.ok(
        body.includes("never a random pick, never one outside their preferences"),
        `${key}: the no-random / no-out-of-preference clause missing`,
      );
      // REPLACED, not layered: the old phrasing must be gone entirely.
      assert.equal(
        body.includes("outside the preferred cuisines"),
        false,
        `${key}: old "outside the preferred cuisines" survives`,
      );
      assert.equal(
        body.includes("outside the user's preferred cuisines"),
        false,
        `${key}: old "outside the user's preferred cuisines" survives`,
      );
      assert.equal(
        body.includes("discovery is a no-op"),
        false,
        `${key}: old no-op-without-cuisine-steer clause survives`,
      );
      assert.equal(
        body.includes("additive novelty"),
        false,
        `${key}: old "additive novelty" framing survives`,
      );
    }
  });

  it("the bodies read the integer the resolver derives, not a 0..2 pin", () => {
    for (const [key, body] of GENERATE_BODIES) {
      assert.ok(
        body.includes("`preferencesContext.discoveryMealsPerWeek` (an integer, 0 or more)"),
        `${key}: count is no longer described as an open integer`,
      );
      assert.equal(body.includes("(0, 1, or 2)"), false, `${key}: 0..2 pin survives`);
    }
  });

  it("a named meal is still never displaced by discovery", () => {
    assert.ok(
      WIZARD_DIRECTED_GENERATE_BODY.includes(
        "NEVER overrides an explicitly-named meal (a named meal is locked regardless)",
      ),
    );
  });
});

describe("meal_builder.mode_a_parse — the brand-name rule", () => {
  const body = MEAL_BUILDER_MODE_A_PARSE_BODY;

  it("has its own section and names the product as the ingredient line", () => {
    assert.ok(body.includes("# Brand-name and boxed products"));
    assert.ok(
      body.includes(
        "the product IS the ingredient line: carry it as ONE bought ingredient",
      ),
    );
    assert.ok(body.includes('"Near East rice pilaf", "DiGiorno cheese pizza"'));
  });

  it("forbids the from-scratch path and follows package directions", () => {
    assert.ok(body.includes("there is NO from-scratch path"));
    assert.ok(
      body.includes(
        "never author the product's own recipe — no rice + broth + spices for a pilaf box",
      ),
    );
    assert.ok(
      body.includes(
        "the water a pilaf box calls for (not stock)",
      ),
    );
    assert.ok(body.includes("follow the PACKAGE DIRECTIONS"));
  });

  it("leaves unnamed components from scratch and precedes the edge cases", () => {
    assert.ok(
      body.includes(
        "Components the user did NOT name as a product follow the rules above unchanged",
      ),
    );
    assert.ok(
      body.indexOf("# Brand-name and boxed products") < body.indexOf("# Edge cases"),
      "the brand-name section must come before the edge cases",
    );
  });
});

// WS9 Redesign Arc Block 2 (Part E) — the Playlist dial on the generate path.
// Block 1 gave the dial a count but neither body read it and the shelf never
// carried the playlist; the count is now placed against rows the shelf marks.
describe("Block 2 — the Playlist dial names marked shelf rows in both generate bodies", () => {
  it("both generate bodies read the count and the shelf mark", () => {
    for (const [key, body] of GENERATE_BODIES) {
      assert.ok(
        body.includes("Playlist — `preferencesContext.playlistMealsPerWeek` (an integer, 0 or more)"),
        `${key}: playlist paragraph missing`,
      );
      assert.ok(
        body.includes("the `storeShortlist` entries marked `\"isPlaylist\": true`"),
        `${key}: the shelf mark is not named`,
      );
      assert.ok(
        body.includes("Pick the N that fit the plan best"),
        `${key}: pick-the-N instruction missing`,
      );
      assert.ok(
        body.includes("if fewer than N are marked, use every marked one"),
        `${key}: the short-playlist case is unstated`,
      );
      assert.ok(
        body.includes("A playlist meal is never a discovery meal"),
        `${key}: the two counts must claim different slots`,
      );
      // Beside Discovery, before the shelf section (inside the cached head).
      assert.ok(
        body.indexOf("Discovery — `preferencesContext.discoveryMealsPerWeek`") <
          body.indexOf("Playlist — `preferencesContext.playlistMealsPerWeek`"),
        `${key}: playlist paragraph must follow the discovery paragraph`,
      );
      assert.ok(
        body.indexOf("Playlist — `preferencesContext.playlistMealsPerWeek`") <
          body.indexOf("{{storeShortlist}}"),
        `${key}: playlist paragraph must precede the shelf slot`,
      );
    }
  });
});
