// SEC-2 #4 — every string the client echoes to POST /wizard/expand is capped
// in the request schema. (No echoed text is published regardless: see
// wizardExpansion.ts findServerCandidate and wizardFinalize.ts writeBack.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WizardExpandRequestSchema } from "../ai/schemas/wizard";

function body(over: { candidate?: Record<string, unknown>; candidateContext?: Record<string, unknown> } = {}) {
  return {
    candidate: {
      id: "cand-1",
      title: "A week",
      tags: ["quick"],
      mealTitles: ["Tacos"],
      whyBullets: ["Because"],
      dailyMacros: { calories: 1, proteinG: 1, carbsG: 1, fatG: 1 },
      meals: [{ title: "Tacos", description: "Crispy." }],
      storeSlots: [{ slotIndex: 0, storeMealId: "m-1" }],
      ...over.candidate,
    },
    candidateContext: {
      planDurationDays: 1,
      householdSize: 2,
      wantsLeftovers: false,
      difficulty: "easy",
      allergiesAndAvoidances: [],
      ...over.candidateContext,
    },
  };
}

const long = (n: number) => "x".repeat(n);

describe("SEC-2 #4 — echoed strings are capped", () => {
  it("a normal card parses", () => {
    assert.equal(WizardExpandRequestSchema.safeParse(body()).success, true);
  });
  const over: Array<[string, Parameters<typeof body>[0]]> = [
    ["candidate.id", { candidate: { id: long(101) } }],
    ["a meal title", { candidate: { mealTitles: [long(201)] } }],
    ["a tag", { candidate: { tags: [long(61)] } }],
    ["a why-bullet", { candidate: { whyBullets: [long(301)] } }],
    ["a mealDescriptions entry", { candidate: { mealDescriptions: [long(301)] } }],
    ["meals[].title", { candidate: { meals: [{ title: long(201), description: null }] } }],
    ["meals[].description", { candidate: { meals: [{ title: "T", description: long(301) }] } }],
    ["meals[].imageUrl", { candidate: { meals: [{ title: "T", description: null, imageUrl: long(2049) }] } }],
    ["a storeMealId", { candidate: { storeSlots: [{ slotIndex: 0, storeMealId: long(65) }] } }],
    ["an allergy", { candidateContext: { allergiesAndAvoidances: [long(101)] } }],
    ["the allergy list", { candidateContext: { allergiesAndAvoidances: Array(51).fill("nuts") } }],
    ["an eating style", { candidateContext: { eatingStyles: [long(61)] } }],
    ["saucePreference", { candidateContext: { saucePreference: long(41) } }],
  ];
  for (const [what, o] of over) {
    it(`refuses an over-long ${what}`, () => {
      assert.equal(WizardExpandRequestSchema.safeParse(body(o)).success, false);
    });
  }
});
