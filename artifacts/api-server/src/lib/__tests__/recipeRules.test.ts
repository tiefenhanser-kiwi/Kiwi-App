// SAFE-1 (D-WS9-315) — every AI path that writes a recipe carries the shared
// food-safety fragment (lib/ai/recipeRules.ts), and import carries its lighter
// version without losing "never re-portion".
//
// The bodies are read the way the database gets them: the seed's own PROMPTS
// list, by key (prisma/seeds/aiPrompts.ts — what `prisma:seed` writes), and the
// two compiled store-fill prefixes runAICall sends as the cached system block.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROMPTS } from "../../../prisma/seeds/aiPrompts";
import { DONENESS_MINIMUMS, IMPORT_SAFETY_RULES, RECIPE_SAFETY_RULES } from "../ai/recipeRules";
import { STABLE_FINALIZE_PREFIX, STABLE_GENERATE_PREFIX, generatePrefixFor } from "../storeFillPrompts";

/** Every live prompt that writes a cookable recipe's ingredients or steps (TRIAGE-0's list, re-verified in SAFE-1). */
const RECIPE_WRITERS = [
  "wizard.candidate.expand",
  "wizard.candidate.finalize_steps",
  "meal_builder.mode_a_parse",
  "dish_builder.mode_a_parse",
  "meal_builder.assist_ingredients",
  "meal_builder.assist_steps",
] as const;

const seeded = (key: string): string => {
  const p = PROMPTS.find((x) => x.key === key);
  assert.ok(p, `${key} is in the seed`);
  return p.body;
};

describe("SAFE-1 — the shared fragment is in every recipe writer", () => {
  for (const key of RECIPE_WRITERS) {
    it(`${key} (seeded body) carries the fragment`, () => {
      assert.ok(seeded(key).includes(RECIPE_SAFETY_RULES), `${key} lacks RECIPE_SAFETY_RULES`);
    });
  }
  for (const [name, prefix] of [
    ["store.generate_meal (STABLE_GENERATE_PREFIX)", STABLE_GENERATE_PREFIX],
    ["store.finalize_steps (STABLE_FINALIZE_PREFIX)", STABLE_FINALIZE_PREFIX],
    ["THX-2G's 8-dish generate prefix", generatePrefixFor({ maxDishes: 8 })],
  ] as const) {
    it(`${name} carries the fragment`, () => {
      assert.ok(prefix.includes(RECIPE_SAFETY_RULES));
    });
  }
  it("each writer carries it exactly once (replace, don't layer)", () => {
    for (const body of [...RECIPE_WRITERS.map(seeded), STABLE_GENERATE_PREFIX, STABLE_FINALIZE_PREFIX]) {
      assert.equal(body.split(RECIPE_SAFETY_RULES).length - 1, 1);
    }
  });
  it("the fragment states D-WS9-315's numbers and the other three rules", () => {
    for (const s of ["165°F", "160°F", "145°F, then rest", "medium-rare at 130–135°F is fine", "flakes easily", "come-up", "Don't rinse", "12-inch skillet", "whole lemons"]) {
      assert.ok(RECIPE_SAFETY_RULES.includes(s), s);
    }
  });
});

describe("SAFE-1 — import is lighter: the user's recipe, never re-portioned", () => {
  const body = seeded("import.reformat_for_kiwi");
  it("carries the import rules and the minimums, not the full fragment", () => {
    assert.ok(body.includes(IMPORT_SAFETY_RULES));
    assert.ok(body.includes(DONENESS_MINIMUMS));
    assert.equal(body.includes(RECIPE_SAFETY_RULES), false, "the produce rule would rewrite the user's lines");
  });
  it("keeps 'never re-portion' as written", () => {
    assert.ok(body.includes("The quantity is the SOURCE's — never re-portion it."));
  });
  it("the old 165°F-for-anything example is gone", () => {
    assert.equal(body.includes("Cook for 8-10 minutes, or until the internal temperature reaches 165°F."), false);
    assert.ok(body.includes('"Cook the chicken until done"'));
  });
  it("adds no rinse and keeps the source's own doneness", () => {
    assert.ok(IMPORT_SAFETY_RULES.includes("Add no rinsing step"));
    assert.ok(IMPORT_SAFETY_RULES.includes("a steak cooked medium-rare stays medium-rare"));
  });
});
