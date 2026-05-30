// WS7-5b-mobile FIX — wizardActivation materializer unit tests.
//
// Pins the Template-pair shape: every wizard plan that flows through
// /activate or /save MUST create a MealPlanTemplate whose title + tags +
// description + sourceType + defaultDaysCount come from the wizard's
// expanded JSON (PRD §2.4). The route-level wizard.test.ts proves the
// route handler writes mealPlanTemplateId into the Instance update; this
// test proves the materializer creates the right Template row to point at.
//
// Stubs prisma + tx tightly — only enough surface to keep the materializer
// flowing through Pass 1 (draft read, ingredient upserts) and Pass 2 (meal
// graph + Template create). The Template-create call argument is captured
// and asserted; other writes are no-ops.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "@prisma/client";

import { materializeWizardDraft } from "../wizardActivation";
import type { WizardExpandedPlan } from "../ai/schemas/wizard";

const USER_ID = "user-mat-test";
const DRAFT_ID = "draft-mat-test";

function sampleExpanded(): WizardExpandedPlan {
  return {
    candidateId: "c-1",
    title: "Cozy Comfort Week",
    tags: ["Comfort", "Easy"],
    whyBullets: [
      "Sheet-pan and one-pot meals minimize cleanup",
      "Garlic shared across 3 meals",
    ],
    meals: [
      {
        title: "Sheet-pan harissa chicken",
        cuisineType: "American",
        difficulty: "easy",
        estimatedTimeMinutes: 35,
        servings: 4,
        dishes: [
          {
            title: "Sheet-pan harissa chicken",
            role: "main",
            positionIndex: 0,
            ingredients: [
              { name: "Chicken thighs", quantity: 2, unit: "lb" },
              { name: "Harissa paste", quantity: 2, unit: "tbsp" },
            ],
            steps: ["Roast at 425F until 165F internal."],
            macros: null,
          },
        ],
      },
      {
        title: "Tomato soup + grilled cheese",
        cuisineType: "American",
        difficulty: "easy",
        estimatedTimeMinutes: 25,
        servings: 4,
        dishes: [
          {
            title: "Tomato soup",
            role: "main",
            positionIndex: 0,
            ingredients: [
              { name: "Canned tomatoes", quantity: 28, unit: "oz" },
            ],
            steps: ["Simmer."],
            macros: null,
          },
        ],
      },
    ],
  };
}

interface CapturedTemplate {
  data: Record<string, unknown>;
}

function makeStubs(opts: { expanded: WizardExpandedPlan }) {
  const captured: { template: CapturedTemplate | null } = { template: null };

  const prismaStub = {
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        if (args.where.id !== DRAFT_ID) return null;
        return {
          userId: USER_ID,
          isWizardDraft: true,
          optimizationNotes: opts.expanded,
        };
      },
    },
    ingredient: {
      upsert: async (args: {
        where: { canonicalName: string };
      }) => ({ id: `ing-${args.where.canonicalName}` }),
    },
  };

  const txStub = {
    meal: { create: async () => ({ id: "meal-x" }) },
    dish: { create: async () => ({ id: "dish-x" }) },
    mealDishLink: { create: async () => ({}) },
    dishIngredient: { create: async () => ({}) },
    recipeInstructionStep: { create: async () => ({}) },
    mealPlanItem: { create: async () => ({}) },
    mealPlanTemplate: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.template = { data: args.data };
        return { id: "tpl-materializer-test" };
      },
    },
  };

  return { prismaStub, txStub, captured };
}

describe("materializeWizardDraft — WS7-5b-mobile FIX Template-pair (PRD §2.4)", () => {
  it("creates a MealPlanTemplate with title + tags + description + sourceType + defaultDaysCount from the expanded plan", async () => {
    const expanded = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({ expanded });

    const result = await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
    });

    // Materializer returns the new Template id so the route handler can
    // link the Instance to it in the same transaction.
    assert.equal(result.mealPlanTemplateId, "tpl-materializer-test");

    // Template create was called exactly once with the right shape.
    assert.ok(captured.template, "tx.mealPlanTemplate.create not invoked");
    const data = captured.template.data;

    // PRD §2.4 line 268: Template owns title, tags, sourceType, description.
    assert.equal(data.userId, USER_ID);
    assert.equal(data.title, expanded.title);
    assert.deepEqual(data.tags, expanded.tags);
    assert.equal(data.sourceType, "wizard");
    assert.equal(data.defaultDaysCount, expanded.meals.length);
    assert.equal(data.isPublic, false);
    assert.equal(data.isArchived, false);

    // imageUrl is explicitly null — WS7-10 owns stock-image integration.
    assert.equal(data.imageUrl, null);

    // Description folds whyBullets into bullet copy so My Plans card
    // subtext renders (blank-card fix). The bullets must be present.
    const description = data.description as string;
    assert.equal(typeof description, "string");
    for (const bullet of expanded.whyBullets) {
      assert.ok(
        description.includes(bullet),
        `description must include whyBullet: ${bullet}`,
      );
    }
  });

});
