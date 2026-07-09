// WS7-8b Block 2 (D-WS7-184) — loadPrepStepSet demoted-step exclusion tests.
//
// Mechanism 2: the AI-free recompute overlays the narration-time `skipSuggested`
// flag read from the cached PrepWeekStructure.structureJson and drops demoted
// steps from the required-set. These tests pin:
//   • the pure extraction (demotedStepKeysFromStructure) incl. the D-WS7-183
//     mixed-blend guard and the degrade-to-KEEP behavior on absence/malformation;
//   • the end-to-end loadPrepStepSet path (real engine + injected loader + a
//     prisma stub) — a genuinely demoted step is excluded while a mixed-blend
//     step in the SAME plan stays required (BUG-013 / server-exclude of BUG-015).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";

import {
  demotedStepKeysFromStructure,
  loadPrepStepSet,
} from "../prepStepSet";
import type { loadPrepWeekInput as productionLoadPrepWeekInput } from "../prepWeekAggregation";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "u-prepstepset";
const MEAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ONION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SPICE_IDS = [
  "f1111111-1111-4111-8111-111111111111",
  "f2222222-2222-4222-8222-222222222222",
  "f3333333-3333-4333-8333-333333333333",
];

const ONION_KEY = `produce#${ONION_ID}`;
// D-WS7-187 per-dish blend keyspace — the current key an isBlend step mints.
const BLEND_KEY = `seasonings_dry#dish#${DISH_ID}`;

// A loader producing, for one meal/dish: one diced-onion produce step + a 3-spice
// seasonings_dry blend step (3+ distinct Pantry dry seasonings on one dish →
// engine tier-3 blend). None of cumin/paprika/coriander are denylisted or sauce-
// hinted, so they land in seasonings_dry as a real blend.
function blendLoaderStub(): typeof productionLoadPrepWeekInput {
  return (async () => ({
    input: {
      planId: PLAN_ID,
      planName: "Blend Test",
      meals: [
        {
          mealId: MEAL_ID,
          mealName: "Meal",
          cuisine: null,
          servingsOverride: null,
          dishes: [
            {
              dishId: DISH_ID,
              dishName: "Dish",
              baseServings: 4,
              authoredBaseServings: 4,
              stepTexts: [],
              ingredients: [
                {
                  ingredientId: ONION_ID,
                  ingredientName: "yellow onion",
                  category: "Produce",
                  quantity: 1,
                  unit: "each",
                  preparationNote: "diced",
                },
                ...["cumin", "paprika", "coriander"].map((name, i) => ({
                  ingredientId: SPICE_IDS[i],
                  ingredientName: name,
                  category: "Pantry",
                  quantity: 1,
                  unit: "tsp",
                  preparationNote: null,
                })),
              ],
            },
          ],
        },
      ],
    },
    planRevisionId: 1,
  })) as never;
}

// Minimal prisma whose prepWeekStructure.findUnique returns the given row.
function prismaWithStructure(structureJson: unknown | null): PrismaClient {
  return {
    prepWeekStructure: {
      findUnique: async () =>
        structureJson === null ? null : { structureJson },
    },
  } as unknown as PrismaClient;
}

// ── demotedStepKeysFromStructure — pure extraction + mixed-blend guard ────────

describe("demotedStepKeysFromStructure (D-WS7-184)", () => {
  it("collects only stepKeys with skipSuggested === true", () => {
    const set = demotedStepKeysFromStructure({
      phases: [
        {
          phase: "produce",
          steps: [
            { stepKey: "produce#onion", skipSuggested: true },
            { stepKey: "produce#carrot", skipSuggested: false },
            { stepKey: "produce#celery" }, // absent flag → kept
          ],
        },
      ],
    });
    assert.deepEqual([...set].sort(), ["produce#onion"]);
  });

  it("D-WS7-183 mixed-blend guard: a non-demoted blend key stays OUT of the set even alongside a genuinely demoted step", () => {
    // The narrator never sets skipSuggested on an isBlend step; the structure
    // therefore carries the blend key WITHOUT the flag. Extraction must not
    // sweep it into the demoted-set (which would drop it from the required-set
    // and let a mixed-blend meal falsely reach prepped).
    const set = demotedStepKeysFromStructure({
      phases: [
        {
          phase: "seasonings_dry",
          steps: [{ stepKey: BLEND_KEY /* no skipSuggested */ }],
        },
        {
          phase: "proteins",
          steps: [{ stepKey: "proteins#beef", skipSuggested: true }],
        },
      ],
    });
    assert.ok(!set.has(BLEND_KEY), "blend key must not be demoted");
    assert.ok(set.has("proteins#beef"), "the real demoted step is collected");
  });

  it("degrades to KEEP-default (empty set) on absence — null/undefined/no phases", () => {
    assert.equal(demotedStepKeysFromStructure(null).size, 0);
    assert.equal(demotedStepKeysFromStructure(undefined).size, 0);
    assert.equal(demotedStepKeysFromStructure({}).size, 0);
    assert.equal(demotedStepKeysFromStructure({ phases: null }).size, 0);
  });

  it("degrades to KEEP-default on malformed shapes — never throws", () => {
    assert.equal(demotedStepKeysFromStructure("nope").size, 0);
    assert.equal(demotedStepKeysFromStructure(42).size, 0);
    assert.equal(
      demotedStepKeysFromStructure({ phases: [{ steps: "bad" }] }).size,
      0,
    );
    assert.equal(
      demotedStepKeysFromStructure({ phases: [null, { steps: [null] }] }).size,
      0,
    );
    // skipSuggested must be a strict boolean true — a truthy string is ignored.
    assert.equal(
      demotedStepKeysFromStructure({
        phases: [{ steps: [{ stepKey: "x", skipSuggested: "true" }] }],
      }).size,
      0,
    );
    // A flagged step with no/empty stepKey is ignored.
    assert.equal(
      demotedStepKeysFromStructure({
        phases: [{ steps: [{ skipSuggested: true }, { stepKey: "", skipSuggested: true }] }],
      }).size,
      0,
    );
  });
});

// ── loadPrepStepSet — end-to-end exclusion over the real engine ───────────────

describe("loadPrepStepSet — demoted-step exclusion (BUG-013 / BUG-015)", () => {
  it("with NO structure row, both the onion step and the blend step are required (degrade-to-KEEP)", async () => {
    const refs = await loadPrepStepSet({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: prismaWithStructure(null),
      loadPrepWeekInput: blendLoaderStub(),
    });
    const keys = refs.map((r) => r.stepKey);
    assert.ok(keys.includes(ONION_KEY), "onion produce step present");
    assert.ok(keys.includes(BLEND_KEY), "blend step present");
  });

  it("excludes a genuinely demoted step while the mixed-blend step stays required (D-WS7-183 guard)", async () => {
    // Structure demotes the onion (skipSuggested: true); the blend carries NO
    // flag (as the narrator guarantees). loadPrepStepSet must drop the onion and
    // keep the blend — so a meal whose only remaining required step is the blend
    // still gates on it (guard holds), and the demoted-and-unchecked onion can
    // never nag forever (the BUG-013 fix).
    const refs = await loadPrepStepSet({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: prismaWithStructure({
        phases: [
          { phase: "produce", steps: [{ stepKey: ONION_KEY, skipSuggested: true }] },
          { phase: "seasonings_dry", steps: [{ stepKey: BLEND_KEY }] },
        ],
      }),
      loadPrepWeekInput: blendLoaderStub(),
    });
    const keys = refs.map((r) => r.stepKey);
    assert.ok(!keys.includes(ONION_KEY), "demoted onion excluded from required-set");
    assert.ok(keys.includes(BLEND_KEY), "mixed-blend step stays required");
  });

  it("a structure-read failure degrades to KEEP-default (no throw, nothing excluded)", async () => {
    const throwingPrisma = {
      prepWeekStructure: {
        findUnique: async () => {
          throw new Error("db down");
        },
      },
    } as unknown as PrismaClient;
    const refs = await loadPrepStepSet({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: throwingPrisma,
      loadPrepWeekInput: blendLoaderStub(),
    });
    const keys = refs.map((r) => r.stepKey);
    assert.ok(keys.includes(ONION_KEY) && keys.includes(BLEND_KEY));
  });
});
