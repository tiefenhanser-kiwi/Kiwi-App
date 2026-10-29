// SERVER-8 B (D-WS9-341) — NO WEIGHT IS THE RECIPE'S WEIGHT. A plan item with no turkey
// weight reads exactly as one set to the recipe's own weight: the roast's minutes (FSIS's
// floor and all), its duration words, Cook Mode's clock, and the bird's other weight words
// ("Pat the 14-lb turkey dry", "A frozen 14-lb turkey thaws 3–4 days").

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { birdWeightWordEdits, editStep, mealBirdOf } from "../birdWeight";
import { applyBirdWeightToRead } from "../birdWeightRead";
import { runCookingSequence } from "../cookingSequence";

const say = (text: string, lb: number) => editStep(text, null, birdWeightWordEdits(text, lb)).text;

describe("SERVER-8 B — the bird's weight words", () => {
  it("'Pat the 14-lb turkey dry' says the weight; the recipe's own weight leaves it as written", () => {
    assert.equal(say("Make ahead (Tuesday night): Pat the 14-lb turkey dry with paper towels.", 16), "Make ahead (Tuesday night): Pat the 16-lb turkey dry with paper towels.");
    assert.equal(say("Pat the 14-lb turkey dry.", 16.5), "Pat the 16½-lb turkey dry.");
    assert.deepEqual(birdWeightWordEdits("Pat the 14-lb turkey dry.", 14), []);
  });

  it("'A frozen 14-lb turkey thaws 3–4 days' says the weight and the thaw rule's days (⌈lb ÷ 4⌉)", () => {
    const t = "A frozen 14-lb turkey thaws 3–4 days in the fridge, so plan accordingly.";
    assert.equal(say(t, 12), "A frozen 12-lb turkey thaws about 3 days in the fridge, so plan accordingly.");
    assert.equal(say(t, 14), "A frozen 14-lb turkey thaws about 4 days in the fridge, so plan accordingly.");
    assert.equal(say(t, 17), "A frozen 17-lb turkey thaws about 5 days in the fridge, so plan accordingly.");
  });

  it("a weight in other words is not the bird's ('2 lb potatoes', 'a 12–14 lb bird' is the roast's)", () => {
    assert.deepEqual(birdWeightWordEdits("Peel 2 lb potatoes; a 12–14 lb bird needs a big pan.", 16), []);
  });
});

type Step = { stepIndex: number; text: string; estimatedMinutes: number; phaseType: string; amountRefs: null; unmatchedAmount: boolean };
const st = (stepIndex: number, text: string, estimatedMinutes = 5, phaseType = "prep"): Step => ({ stepIndex, text, estimatedMinutes, phaseType, amountRefs: null, unmatchedAmount: false });

// Dev's Make-Ahead turkey and the Buttermilk alternate, up to a clause (thx.after.json).
const BIRDS = {
  makeAhead: {
    tags: ["thanksgiving-feast"],
    dishTags: ["thaw-6d", "brine-tue"],
    title: "Dry-Brined Roast Turkey",
    rows: [{ name: "whole turkey", quantity: 14, unit: "pound", preparationNote: "thawed; neck and giblets reserved for gravy" }],
    steps: () => [
      st(0, "Thaw (start Friday): If the turkey is frozen, move it to the fridge on Friday — a 14-lb bird needs 3–4 days to thaw fully."),
      st(1, "Make ahead (Tuesday night): Pat the 14-lb turkey dry with paper towels. Rub the mixture all over the bird.", 10),
      st(2, "On Thursday: Remove the turkey from the fridge 1 hour before roasting.", 60, "rest"),
      st(3, "Roast the turkey at 325°F for about 2¼ hours.", 131, "cook"),
      st(4, "Keep roasting the turkey at 350°F for about 40 more minutes, until the thigh reads 165°F.", 40, "cook"),
    ],
  },
  buttermilk: {
    tags: ["course-turkey"],
    dishTags: [],
    title: "Buttermilk-Brined Roast Turkey",
    rows: [{ name: "whole turkey", quantity: 1, unit: "each", preparationNote: "12–14 lb, neck and giblets removed" }],
    steps: () => [
      st(0, "Pour the brine over the turkey and refrigerate — brine 12 to 24 hours. A frozen 14-lb turkey thaws 3–4 days in the fridge, so plan accordingly.", 4),
      st(1, "Roast at 325°F until the thigh reads 165°F, about 3 to 3½ hours (13–15 minutes per pound) for a 12–14 lb bird.", 210, "cook"),
    ],
  },
} as const;
type Bird = keyof typeof BIRDS;

async function read(b: Bird, birdWeightLb: number | null) {
  const f = BIRDS[b];
  const m = {
    tags: [...f.tags],
    dishes: [{ dishId: "bird", title: f.title, servings: 10, authoredServingsDefault: 10, ingredients: f.rows.map((r) => ({ ...r })), steps: f.steps() }],
  };
  const prisma = { dish: { findUnique: async () => ({ tags: [...f.dishTags] }) } } as never;
  const fields = await applyBirdWeightToRead(prisma, m, { birdWeightLb, servingsOverride: null, assignedDayOfWeek: "Thursday" }, new Map([["bird", f.steps().map((s) => s.text)]]));
  return { steps: m.dishes[0].steps, fields };
}
const recipeLb = (b: Bird) => mealBirdOf({ tags: [...BIRDS[b].tags], dishes: [{ dishId: "bird", title: BIRDS[b].title, rows: BIRDS[b].rows.map((r) => ({ ...r, note: r.preparationNote })) }] })!.recipeLb;

describe("SERVER-8 B — the meal read with no weight is the recipe weight's", () => {
  for (const b of Object.keys(BIRDS) as Bird[]) {
    it(`${b}: no weight reads step for step as the recipe's ${recipeLb(b)} lb`, async () => {
      const none = await read(b, null);
      const atRecipe = await read(b, recipeLb(b));
      assert.deepEqual(none.steps, atRecipe.steps);
      assert.equal(none.fields?.birdWeightLb, null);
    });
  }

  it("Make-Ahead: the main roast at 14 lb is FSIS's floor, 131 → 140 minutes, the words as before", async () => {
    const { steps } = await read("makeAhead", null);
    assert.equal(steps[3].estimatedMinutes, 140);
    assert.equal(steps[3].text, "Roast the turkey at 325°F for about 2¼ hours.");
    assert.equal(steps[1].text, "Make ahead (Tuesday night): Pat the 14-lb turkey dry with paper towels. Rub the mixture all over the bird.");
    assert.equal((await read("makeAhead", 16)).steps[1].text, "Make ahead (Tuesday night): Pat the 16-lb turkey dry with paper towels. Rub the mixture all over the bird.");
  });

  it("Buttermilk: the thaw sentence and the roast say the recipe's 14 lb", async () => {
    const { steps } = await read("buttermilk", null);
    assert.equal(steps[0].text, "Pour the brine over the turkey and refrigerate — brine 12 to 24 hours. A frozen 14-lb turkey thaws about 4 days in the fridge, so plan accordingly.");
    assert.equal(steps[1].text, "Roast at 325°F until the thigh reads 165°F, about 3½ hours (13–15 minutes per pound) for a 14-lb bird.");
    assert.match((await read("buttermilk", 12)).steps[0].text, /A frozen 12-lb turkey thaws about 3 days in the fridge/);
  });
});

describe("SERVER-8 B — Cook Mode's clock with no weight is the recipe weight's", () => {
  const USER = "user-s8";
  const prisma = (birdWeightLb: number | null, items = 1) =>
    ({
      meal: {
        findUnique: async () => ({
          id: "meal", userId: USER, isPublic: false, tags: ["course-turkey"],
          dishLinks: [{
            dishId: "bird", positionIndex: 0, roleLabel: null,
            dish: { id: "bird", title: "Dry-Brined Roast Turkey", dishIngredients: [{ quantity: 14, unit: "pound", preparationNote: null, ingredient: { canonicalName: "whole turkey" } }] },
          }],
        }),
      },
      recipeInstructionStep: {
        findMany: async () => [
          { ownerType: "dish", ownerId: "bird", stepIndex: 0, stepTextTranslated: "Rub the turkey with butter.", estimatedMinutes: 10, phaseType: "prep", parallelGroup: null, isTimingSensitive: false },
          { ownerType: "dish", ownerId: "bird", stepIndex: 1, stepTextTranslated: "Roast the turkey at 325°F for about 2¼ hours.", estimatedMinutes: 131, phaseType: "cook", parallelGroup: null, isTimingSensitive: false },
          { ownerType: "dish", ownerId: "bird", stepIndex: 2, stepTextTranslated: "Keep roasting the turkey at 350°F for about 40 more minutes.", estimatedMinutes: 40, phaseType: "cook", parallelGroup: null, isTimingSensitive: false },
        ],
      },
      mealPlanItem: { findMany: async () => Array.from({ length: items }, () => ({ birdWeightLb })) },
    }) as unknown as PrismaClient;
  // The day: how long before serving the first step starts (the sequence serves offsets only).
  const day = async (p: PrismaClient) => -Math.min(...(await runCookingSequence({ mealId: "meal", userId: USER, deps: { prisma: p } })).sequence.map((s) => s.startOffsetMinutes ?? 0));

  it("a plan item with no weight schedules the roast at 14 lb: the same day as 14 lb chosen, 9 minutes past the stored roast", async () => {
    const stored = await day(prisma(null, 0));
    assert.equal(await day(prisma(null)), await day(prisma(14)));
    assert.equal(await day(prisma(null)), stored + 9);
  });

  it("outside a plan item (or with two) the recipe's stored minutes, as before", async () => {
    assert.equal(await day(prisma(null, 2)), await day(prisma(null, 0)));
    assert.notEqual(await day(prisma(null, 0)), await day(prisma(14)));
  });
});
