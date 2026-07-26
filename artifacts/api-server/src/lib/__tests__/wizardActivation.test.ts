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

import { inferCategory, materializeWizardDraft } from "../wizardActivation";
import type { WizardExpandedPlan } from "../ai/schemas/wizard";
import type { WizardSavePlan } from "../wizardSavePlan";

// D-WS9-038 — materialize now takes a partitioned savePlan, not a flat payload.
// These materializer tests are all-live: wrap the sample plan as all build slots
// with writeBack:false (no store forks, no pool write-back) so behavior matches
// the pre-B2 payload path exactly. Store/fork/write-back paths are covered by
// the dedicated B-2 tests.
function asSavePlan(
  expanded: WizardExpandedPlan,
  householdSize?: number,
): WizardSavePlan {
  return {
    candidateId: expanded.candidateId,
    title: expanded.title,
    tags: expanded.tags,
    whyBullets: expanded.whyBullets,
    // Servings unification (BUG-046) — the per-run household rides the savePlan
    // (undefined = legacy draft → stored fallback at materialize).
    householdSize,
    slots: expanded.meals.map((meal) => ({
      kind: "build" as const,
      meal,
      writeBack: false,
    })),
  };
}

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
            steps: [
              {
                text: "Pat chicken dry and rub with harissa.",
                phaseType: "prep",
                estimatedMinutes: 8,
                isTimingSensitive: false,
              },
              {
                text: "Roast at 425F until 165F internal.",
                phaseType: "cook",
                estimatedMinutes: 30,
                isTimingSensitive: false,
              },
            ],
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
            steps: [
              {
                text: "Simmer until thickened.",
                phaseType: "cook",
                estimatedMinutes: 20,
                isTimingSensitive: false,
              },
            ],
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

interface CapturedStep {
  ownerType: string;
  ownerId: string;
  stepIndex: number;
  stepTextRaw: string;
  // BUG #3 (D-WS7-165) — the materializer now persists these from the widened
  // step object instead of letting them fall to the DB column defaults.
  // BUG-018 (WS7-8b B1) — isTimingSensitive joins them (was stuck at the DB
  // false default before; now written unconditionally).
  phaseType?: string;
  estimatedMinutes?: number;
  isTimingSensitive?: boolean;
}

interface CapturedUpsert {
  canonicalName: string;
  create: Record<string, unknown>;
}

interface CapturedCalls {
  template: CapturedTemplate | null;
  // WS7-5c Block A — track the RecipeInstructionStep create calls so the
  // payload-path test can assert that steps came from `payload`, not from
  // the row's optimizationNotes.
  steps: CapturedStep[];
  // Whether the materializer attempted to read optimizationNotes.
  selectedOptimizationNotes: boolean;
  // WS7-5d Block 2 — capture the Ingredient.upsert create payload so tests
  // can assert that purchase fields are populated for known common
  // ingredients and left absent for genuine unknowns.
  upserts: CapturedUpsert[];
  // WS7-8 BUG-003 — capture meal/dish create payloads to pin the immutable
  // authored-servings anchor (== servingsDefault) at the wizard create seam.
  meals: Record<string, unknown>[];
  dishes: Record<string, unknown>[];
}

function makeStubs(opts: {
  expanded: WizardExpandedPlan;
  // When set, the stub returns optimizationNotes=undefined so the
  // payload-required test path is forced to use the provided payload.
  withoutOptimizationNotes?: boolean;
}) {
  const captured: CapturedCalls = {
    template: null,
    steps: [],
    selectedOptimizationNotes: false,
    upserts: [],
    meals: [],
    dishes: [],
  };

  const prismaStub = {
    mealPlanInstance: {
      findUnique: async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        if (args.where.id !== DRAFT_ID) return null;
        if (args.select && args.select.wizardDraftPayload) {
          captured.selectedOptimizationNotes = true;
        }
        return {
          userId: USER_ID,
          isWizardDraft: true,
          // When opts.withoutOptimizationNotes is set, return a sentinel
          // that would fail WizardExpandedPlanSchema if the materializer
          // tried to parse it — the payload path MUST skip the parse.
          // (D-WS9-034: the draft blob now lives on wizardDraftPayload.)
          wizardDraftPayload: opts.withoutOptimizationNotes
            ? { wrong: "shape" }
            : opts.expanded,
        };
      },
    },
    ingredient: {
      upsert: async (args: {
        where: { canonicalName: string };
        create: Record<string, unknown>;
      }) => {
        captured.upserts.push({
          canonicalName: args.where.canonicalName,
          create: args.create,
        });
        return { id: `ing-${args.where.canonicalName}` };
      },
    },
  };

  const txStub = {
    // Servings unification (BUG-046) — materialize resolves effectiveHousehold =
    // savePlan.householdSize ?? stored. These build-slot tests default to NO stored
    // prefs row; combined with an asSavePlan that omits householdSize, effective
    // resolves undefined → build meals fall back to the AI's authored m.servings
    // (the legacy behavior these tests assert). Tests that exercise the unified
    // scaling pass a household via asSavePlan(expanded, N) and/or override this.
    userPreferences: {
      findUnique: async (): Promise<{ householdSize: number } | null> => null,
    },
    meal: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.meals.push(args.data);
        return { id: "meal-x" };
      },
      // WS7-6 Fix-Block 3: meal-row update after the per-dish loop writes
      // the aggregated per-serving macros. No-op in this test — assertions
      // here focus on the Template-pair shape, not macro values.
      update: async () => ({}),
    },
    dish: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.dishes.push(args.data);
        return { id: "dish-x" };
      },
    },
    mealDishLink: {
      create: async () => ({}),
      // WS7-6 Fix-Block 3: recomputeAndPersistMealMacros reads the link
      // table to sum dish macros. The sample payload has macros: null on
      // every dish, so the meal sum is 0 — return an empty list to short-
      // circuit and let the meal.update write a 0-sum.
      findMany: async () => [],
    },
    dishIngredient: { create: async () => ({}) },
    recipeInstructionStep: {
      create: async (args: { data: CapturedStep }) => {
        captured.steps.push(args.data);
        return {};
      },
    },
    mealPlanItem: { create: async () => ({}) },
    mealPlanTemplate: {
      // Block 1 (D-WS7-071 minimal) — dedup-on-write guard queries first;
      // default no existing template so the create path still runs.
      findFirst: async () => null,
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
      savePlan: asSavePlan(expanded),
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

// WS7-8 BUG-003 — the wizard create seam sets the immutable authored anchor
// (authoredServingsDefault) at create so every freshly-wizarded meal/dish is
// born anchored. Servings unification (BUG-046) — the anchor is now the AI's
// authored m.servings, while servingsDefault becomes effectiveHousehold; the
// two are equal ONLY when there is no household signal (this fallback case,
// null prefs + no per-run household → both = m.servings). The divergence case
// (household set → servingsDefault ≠ anchor) is pinned in the block below.
describe("materializeWizardDraft — WS7-8 BUG-003 authored-servings anchor", () => {
  it("no household signal → anchor == servingsDefault == the AI's authored m.servings", async () => {
    const expanded = sampleExpanded(); // both meals have servings: 4
    const { prismaStub, txStub, captured } = makeStubs({ expanded });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded), // no per-run household; stub has no prefs row
    });

    assert.equal(captured.meals.length, 2, "two meals created");
    assert.equal(captured.dishes.length, 2, "two dishes created");
    for (const m of captured.meals) {
      assert.equal(m.servingsDefault, 4);
      assert.equal(m.authoredServingsDefault, 4);
      assert.equal(m.authoredServingsDefault, m.servingsDefault);
    }
    for (const d of captured.dishes) {
      assert.equal(d.servingsDefault, 4);
      assert.equal(d.authoredServingsDefault, 4);
      assert.equal(d.authoredServingsDefault, d.servingsDefault);
    }
  });
});

// Servings unification (BUG-046 / D-WS9-070) — the build path applies the
// plan's effectiveHousehold to servingsDefault while preserving the AI's
// authored m.servings as the render anchor, so a plan generated at household=2
// from meals authored at 4 renders at multiplier 0.5 (the symptom fix), and the
// build path stops relying on the model obeying "servings = householdSize".
describe("materializeWizardDraft — BUG-046 servings unification (build path)", () => {
  it("per-run household=2 on meals authored at 4 → servingsDefault=2, anchor=4 (multiplier 0.5)", async () => {
    const expanded = sampleExpanded(); // meals authored at servings: 4
    const { prismaStub, txStub, captured } = makeStubs({ expanded });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded, 2), // per-run household = 2
    });

    for (const m of captured.meals) {
      assert.equal(m.servingsDefault, 2, "meal servingsDefault = effectiveHousehold");
      assert.equal(m.authoredServingsDefault, 4, "meal anchor = authored m.servings");
    }
    for (const d of captured.dishes) {
      assert.equal(d.servingsDefault, 2, "dish servingsDefault = effectiveHousehold");
      assert.equal(d.authoredServingsDefault, 4, "dish anchor = authored m.servings");
    }
  });

  it("per-run household OVERRIDES stored (payload=2, stored=6 → servingsDefault=2)", async () => {
    const expanded = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({ expanded });
    // Stored prefs say 6; the per-run value (2) must win.
    txStub.userPreferences = { findUnique: async () => ({ householdSize: 6 }) };

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded, 2),
    });

    for (const m of captured.meals) assert.equal(m.servingsDefault, 2);
    for (const d of captured.dishes) assert.equal(d.servingsDefault, 2);
  });

  it("per-run ABSENT → falls back to stored household (payload undefined, stored=3 → servingsDefault=3)", async () => {
    const expanded = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({ expanded });
    txStub.userPreferences = { findUnique: async () => ({ householdSize: 3 }) };

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded), // legacy draft: no per-run household
    });

    for (const m of captured.meals) {
      assert.equal(m.servingsDefault, 3, "falls back to stored household");
      assert.equal(m.authoredServingsDefault, 4, "anchor still the authored count");
    }
  });
});

// WS7-5c Block A — payload path. activate/save now run the finalize_steps
// AI call BEFORE the tx, merge per-dish steps into the details-stage draft,
// and hand the merged WizardExpandedPlan to materializeWizardDraft via the
// new `payload` option. The materializer must:
//   1. Skip the Zod parse of optimizationNotes (those are stepless),
//   2. Use the passed payload as the source of truth for the meal graph,
//   3. Still emit RecipeInstructionStep rows for every dish step in payload.

describe("materializeWizardDraft — WS7-5c Block A payload path", () => {
  it("uses payload.meals[].dishes[].steps for RecipeInstructionStep rows, skipping the stepless optimizationNotes", async () => {
    const payload = sampleExpanded();
    // Hand a malformed optimizationNotes blob — if the materializer parses
    // it, the test fails with a malformed-error. The payload path must
    // skip that parse entirely.
    const { prismaStub, txStub, captured } = makeStubs({
      expanded: payload,
      withoutOptimizationNotes: true,
    });

    const result = await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(payload),
    });

    // Materializer returns the same per-meal accounting whether the shape
    // came from optimizationNotes or payload. With this payload (2 meals,
    // 2 dishes total; dish 0 has 2 steps, dish 1 has 1): mealsCreated=2,
    // dishesCreated=2, 3 RecipeInstructionStep rows.
    assert.equal(result.mealsCreated, 2);
    assert.equal(result.dishesCreated, 2);
    assert.ok(
      captured.steps.length > 0,
      "RecipeInstructionStep create must be invoked at least once",
    );
    assert.equal(
      captured.steps.length,
      3,
      "one step row per step across both dishes (2 + 1)",
    );
    // Steps came from payload's text — confirm the exact source.
    const stepText = captured.steps.map((s) => s.stepTextRaw);
    assert.ok(stepText.includes("Roast at 425F until 165F internal."));
    assert.ok(stepText.includes("Simmer until thickened."));
  });

  // BUG #3 (D-WS7-165) — the materializer must persist phaseType +
  // estimatedMinutes from the widened step object rather than letting them
  // fall to the DB column defaults (cook / 1 min). This is the regression
  // guard for the prep-filter + per-step-duration bug.
  it("persists phaseType + estimatedMinutes from the step object (non-cook, non-1)", async () => {
    const payload = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({
      expanded: payload,
      withoutOptimizationNotes: true,
    });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(payload),
    });

    // The "Pat chicken dry and rub with harissa." step is tagged prep / 8 min
    // in the fixture — proves a non-cook phase and a non-1 duration survive.
    const prepStep = captured.steps.find(
      (s) => s.stepTextRaw === "Pat chicken dry and rub with harissa.",
    );
    assert.ok(prepStep, "prep step row must be created");
    assert.equal(prepStep!.phaseType, "prep");
    assert.equal(prepStep!.estimatedMinutes, 8);

    // Every persisted step carries both fields (none left undefined → none
    // would fall to a column default).
    for (const s of captured.steps) {
      assert.ok(
        s.phaseType !== undefined && s.estimatedMinutes !== undefined,
        `step "${s.stepTextRaw}" must carry phaseType + estimatedMinutes`,
      );
      assert.notEqual(
        s.estimatedMinutes,
        1,
        "no fixture step uses the 1-min default value",
      );
    }
  });

  // BUG-018 (WS7-8b B1) — the materializer must persist isTimingSensitive from
  // the widened step object rather than letting it fall to the DB false
  // default. Before this fix the wizard step contract couldn't express the
  // field at all, so EVERY wizard-authored step reached the DB as false and
  // the Cooking Sequencer had no signal to protect a sear. This is the core
  // regression guard: a wizard-authored TRUE must survive to the create call.
  it("persists isTimingSensitive from the step object (true and false round-trip; no parallelGroup)", async () => {
    const payload = sampleExpanded();
    // Overwrite the first dish's steps with a sear (attention → true) and a
    // chop (hands-off prep → false) so BOTH values are exercised end-to-end.
    payload.meals[0].dishes[0].steps = [
      {
        text: "Sear the steak 3 minutes per side without moving it.",
        phaseType: "cook",
        estimatedMinutes: 6,
        isTimingSensitive: true,
      },
      {
        text: "Chop the parsley for garnish.",
        phaseType: "prep",
        estimatedMinutes: 2,
        isTimingSensitive: false,
      },
    ];
    const { prismaStub, txStub, captured } = makeStubs({
      expanded: payload,
      withoutOptimizationNotes: true,
    });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(payload),
    });

    const searStep = captured.steps.find(
      (s) =>
        s.stepTextRaw === "Sear the steak 3 minutes per side without moving it.",
    );
    const chopStep = captured.steps.find(
      (s) => s.stepTextRaw === "Chop the parsley for garnish.",
    );
    assert.ok(searStep, "sear step row must be created");
    assert.ok(chopStep, "chop step row must be created");
    // The TRUE surviving is the whole point — it was structurally impossible
    // before (the contract couldn't carry the field; it always defaulted false).
    assert.equal(searStep!.isTimingSensitive, true);
    assert.equal(chopStep!.isTimingSensitive, false);

    for (const s of captured.steps) {
      // Explicit on every step → never falls to the DB false default.
      assert.ok(
        s.isTimingSensitive !== undefined,
        `step "${s.stepTextRaw}" must carry isTimingSensitive explicitly`,
      );
      // parallelGroup is retired: no wizard step create may carry it.
      assert.ok(
        !("parallelGroup" in (s as unknown as Record<string, unknown>)),
        `step "${s.stepTextRaw}" must NOT carry a parallelGroup`,
      );
    }
  });

  it("rejects a payload that doesn't satisfy WizardExpandedPlanSchema (steps required)", async () => {
    // Strip steps from one dish — the merged payload contract is "every
    // dish has at least one step". The defensive Zod check inside the
    // materializer must catch this and surface as WizardDraftMalformed.
    const payload = sampleExpanded();
    (payload.meals[0].dishes[0] as { steps: unknown[] }).steps = [];

    const { prismaStub, txStub } = makeStubs({
      expanded: payload,
      withoutOptimizationNotes: true,
    });

    await assert.rejects(
      () =>
        materializeWizardDraft({
          prisma: prismaStub as unknown as PrismaClient,
          tx: txStub as unknown as Prisma.TransactionClient,
          userId: USER_ID,
          draftId: DRAFT_ID,
          savePlan: asSavePlan(payload),
        }),
      /Wizard draft malformed/,
      "payload missing steps must error before any tx write",
    );
  });
});

// WS7-5d Block 2 — wizard-side category inference now emits Canned / Snacks
// / Household so freshly-wizarded ingredients route to the right StoreSection
// via the CATEGORY_TO_SECTION map Block 1 expanded. Without these rules,
// canned items (crushed/diced tomatoes, coconut milk, enchilada sauce) drop
// into Pantry on every wizard activation.

describe("inferCategory — WS7-5d Block 2 expanded category union", () => {
  it("infers Canned for common canned items (multi-token keywords win over the Produce 'tomato' single-token)", () => {
    assert.equal(inferCategory("diced tomatoes"), "Canned");
    assert.equal(inferCategory("crushed tomatoes"), "Canned");
    assert.equal(inferCategory("tomato sauce"), "Canned");
    assert.equal(inferCategory("tomato paste"), "Canned");
    assert.equal(inferCategory("enchilada sauce"), "Canned");
    assert.equal(inferCategory("coconut milk"), "Canned");
    assert.equal(inferCategory("black beans"), "Canned");
    assert.equal(inferCategory("chickpeas"), "Canned");
    assert.equal(inferCategory("canned crushed tomatoes"), "Canned");
  });

  it("infers Snacks for snack items", () => {
    assert.equal(inferCategory("tortilla chips"), "Snacks");
    assert.equal(inferCategory("potato chips"), "Snacks");
    assert.equal(inferCategory("pretzels"), "Snacks");
    assert.equal(inferCategory("popcorn"), "Snacks");
    assert.equal(inferCategory("crackers"), "Snacks");
  });

  it("infers Household for non-food groceries", () => {
    assert.equal(inferCategory("paper towels"), "Household");
    assert.equal(inferCategory("toilet paper"), "Household");
    assert.equal(inferCategory("trash bags"), "Household");
    assert.equal(inferCategory("aluminum foil"), "Household");
    assert.equal(inferCategory("dish soap"), "Household");
  });

  it("still routes fresh produce items containing 'tomato' to Produce (Canned multi-token doesn't poison the single-token match)", () => {
    // Bare "tomato" and "roma tomato" must still land in Produce — Canned
    // keywords are intentionally multi-token ("diced tomato", "crushed
    // tomato", etc.) so the rule ordering doesn't steal fresh produce. The
    // Produce rule's "tomato" single-token match is what catches these.
    assert.equal(inferCategory("tomato"), "Produce");
    assert.equal(inferCategory("roma tomato"), "Produce");
  });

  it("handles irregular -oes plurals (D-WS7-078): tomatoes/potatoes route to Produce", () => {
    // Pre-Block-3 the matcher was `\bkeyword s?\b`, which handles regular -s
    // plurals (lemon→lemons) but not -oes (tomato→tomatoes, potato→potatoes)
    // — surfaced in WS7-5d Block 2 wizard-path categorization. Block 3
    // widens the regex to `(?:es|s)?` (es-first so -oes matches greedily).
    assert.equal(inferCategory("tomatoes"), "Produce");
    assert.equal(inferCategory("potatoes"), "Produce");
    // Regression: regular -s plurals still match.
    assert.equal(inferCategory("lemons"), "Produce");
    // Negative: word-boundary still rejects substrings inside unrelated
    // words ("chip" must NOT match inside "chipotle").
    assert.equal(inferCategory("chipotle"), "Pantry");
  });

  it("unknowns still fall through to Pantry", () => {
    assert.equal(inferCategory("xyzzy"), "Pantry");
    assert.equal(inferCategory(""), "Pantry");
  });

  it("WS7-5d Block 5 Fix 2: broths and stocks route to Canned (ahead of Protein)", () => {
    // Device-test surfaced "chicken broth" / "low-sodium chicken broth"
    // landing in Protein because the bare "chicken" keyword wins ahead of
    // any Canned match. Adding "broth" + "stock" to Canned (ordered before
    // Protein) resolves it — same ordering trick as the pickled fix below.
    assert.equal(inferCategory("chicken broth"), "Canned");
    assert.equal(inferCategory("low-sodium chicken broth"), "Canned");
    assert.equal(inferCategory("beef broth"), "Canned");
    assert.equal(inferCategory("vegetable broth"), "Canned");
    assert.equal(inferCategory("vegetable stock"), "Canned");
    assert.equal(inferCategory("chicken stock"), "Canned");
    assert.equal(inferCategory("bone broth"), "Canned");

    // Negative — whole-protein names must NOT get pulled into Canned. The
    // single-token "broth"/"stock" word-boundary keeps these in Protein
    // where the existing chicken/beef keywords match. Pinning the negative
    // here mirrors the "olive oil" rejection in the pickled test below.
    assert.equal(inferCategory("chicken breast"), "Protein");
    assert.equal(inferCategory("chicken breasts"), "Protein");
    assert.equal(inferCategory("chicken thighs"), "Protein");
    assert.equal(inferCategory("ground chicken"), "Protein");
    assert.equal(inferCategory("beef brisket"), "Protein");
  });

  it("WS7-5d Block 4 Fix 3: pickled items + capers route to Canned (ahead of Produce)", () => {
    // Device-test surfaced "pickled jalapeños" landing in Produce; the bare
    // "jalapeño" Produce keyword was winning. Adding "pickled" as a Canned
    // substring keyword (Canned ordered before Produce) routes the pickled
    // variant correctly while leaving fresh "jalapeño" alone.
    assert.equal(inferCategory("pickled jalapeños"), "Canned");
    assert.equal(inferCategory("pickled jalapeno"), "Canned");
    assert.equal(inferCategory("pickled onions"), "Canned");
    assert.equal(inferCategory("pickled ginger"), "Canned");
    assert.equal(inferCategory("capers"), "Canned");
    // Negative regressions: bare produce variants still land in Produce.
    assert.equal(inferCategory("jalapeño"), "Produce");
    assert.equal(inferCategory("jalapeno"), "Produce");
    assert.equal(inferCategory("yellow onion"), "Produce");
    assert.equal(inferCategory("ginger"), "Produce");
    // "olive" was deliberately NOT added — its single-token regex catches
    // "olive oil" (pantry). This test pins that olive oil stays out of Canned.
    assert.equal(inferCategory("olive oil"), "Pantry");
    assert.equal(inferCategory("extra virgin olive oil"), "Pantry");
  });
});

// WS7-5d Block 2 — Ingredient.upsert now writes purchase fields on create
// for canonical names in the shared INGREDIENT_PURCHASE_DEFAULTS table.
// Cache-gate proof: a wizard-activated ingredient with all three purchase
// fields non-null passes the gate in fillPurchaseSizesWithWriteBack and
// skips the Haiku gap-fill call — killing the serial-call storm that
// Block 1 measured on freshly-wizarded plans.

describe("materializeWizardDraft — WS7-5d Block 2 purchase-field write-back", () => {
  it("populates purchaseUnit/Quantity/Display on create for ingredients in the shared defaults table", async () => {
    // sampleExpanded uses "Chicken thighs" (canonicalizes to "chicken thighs")
    // — present in INGREDIENT_PURCHASE_DEFAULTS with 2 lb default.
    const expanded = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({ expanded });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded),
    });

    const chickenThighsUpsert = captured.upserts.find(
      (u) => u.canonicalName === "chicken thighs",
    );
    assert.ok(chickenThighsUpsert, "chicken thighs upsert was not captured");
    const create = chickenThighsUpsert.create;
    assert.equal(create.purchaseUnit, "lb");
    assert.equal(create.purchaseQuantity, 2);
    assert.equal(create.purchaseDisplay, "2 lb");
    // Cache-gate proof: all three fields non-null, so
    // fillPurchaseSizesWithWriteBack treats this row as a cache hit and
    // skips the Haiku call.
    assert.notEqual(create.purchaseUnit, null);
    assert.notEqual(create.purchaseQuantity, null);
    assert.notEqual(create.purchaseDisplay, null);
  });

  it("leaves purchase fields absent for ingredients not in the defaults table (gap-fill path still handles unknowns)", async () => {
    // sampleExpanded uses "Harissa paste" and "Canned tomatoes" — neither
    // is in INGREDIENT_PURCHASE_DEFAULTS. The wizard upsert must NOT invent
    // values; gap-fill is the right path for genuine unknowns.
    const expanded = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({ expanded });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded),
    });

    const harissaUpsert = captured.upserts.find(
      (u) => u.canonicalName === "harissa paste",
    );
    assert.ok(harissaUpsert, "harissa paste upsert was not captured");
    // Spread-when-present means the keys are absent (not explicitly null);
    // either is fine for the cache-gate check, but absence is what we wrote.
    assert.equal(harissaUpsert.create.purchaseUnit, undefined);
    assert.equal(harissaUpsert.create.purchaseQuantity, undefined);
    assert.equal(harissaUpsert.create.purchaseDisplay, undefined);
  });

  it("sets the category from inferCategory on create — canned items now route to Canned, not Pantry", async () => {
    // "Canned tomatoes" → canonical "canned tomatoes" → matches the Canned
    // "canned" keyword → category "Canned" (not "Pantry" as pre-Block 2).
    const expanded = sampleExpanded();
    const { prismaStub, txStub, captured } = makeStubs({ expanded });

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan: asSavePlan(expanded),
    });

    const cannedTomatoesUpsert = captured.upserts.find(
      (u) => u.canonicalName === "canned tomatoes",
    );
    assert.ok(cannedTomatoesUpsert, "canned tomatoes upsert was not captured");
    assert.equal(cannedTomatoesUpsert.create.category, "Canned");
  });
});

// ── D-WS9-038 — store fork + write-back + slot order ───────────────────────

// A source meal graph for forkMealForUser / publishMealToStore to deep-copy.
function sourceMealGraph(id: string) {
  return {
    id,
    userId: null,
    title: `Pool ${id}`,
    description: null,
    mealType: "dinner",
    sourceType: "curated",
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    imageUrl: null,
    servingsDefault: 4,
    tags: ["pool"],
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    dishLinks: [
      {
        positionIndex: 0,
        roleLabel: "main",
        dish: {
          id: `${id}-dish`,
          title: `${id} dish`,
          description: null,
          sourceType: "curated",
          estimatedTimeMinutes: 30,
          difficulty: "easy",
          imageUrl: null,
          servingsDefault: 4,
          tags: [],
          caloriesPerServing: 500,
          proteinGPerServing: 30,
          carbsGPerServing: 40,
          fatGPerServing: 20,
          dishIngredients: [
            { ingredientId: "ing-1", quantity: 1, unit: "cup", preparationNote: null, isOptional: false, positionIndex: 0 },
          ],
        },
      },
    ],
  };
}

interface StoreCapture {
  mealCreates: Record<string, unknown>[];
  items: { mealId: string; positionIndex: number }[];
  stepCreateManys: Record<string, unknown>[][];
}

function makeStoreStubs() {
  const captured: StoreCapture = { mealCreates: [], items: [], stepCreateManys: [] };
  let mealCounter = 0;

  const prismaStub = {
    mealPlanInstance: {
      findUnique: async () => ({ userId: USER_ID, isWizardDraft: true }),
    },
    ingredient: {
      upsert: async (args: { where: { canonicalName: string } }) => ({
        id: `ing-${args.where.canonicalName}`,
      }),
    },
  };

  const txStub = {
    // Block 4a — forkMealForUser resolves the acquiring household once per fork.
    // No prefs row here → the store fork keeps the source's authored servings.
    userPreferences: { findUnique: async () => null },
    meal: {
      findUnique: async (args: { where: { id: string } }) => sourceMealGraph(args.where.id),
      create: async (args: { data: Record<string, unknown> }) => {
        captured.mealCreates.push(args.data);
        return { id: `meal-${mealCounter++}` };
      },
      update: async () => ({}),
    },
    dish: { create: async () => ({ id: `dish-${mealCounter}` }) },
    mealDishLink: { create: async () => ({}), findMany: async () => [] },
    dishIngredient: { create: async () => ({}), createMany: async () => ({ count: 1 }) },
    recipeInstructionStep: {
      create: async () => ({}),
      findMany: async (args: { where: { ownerType: string } }) =>
        args.where.ownerType === "dish"
          ? [{ stepIndex: 0, stepTextRaw: "Cook.", stepTextTranslated: "Cook.", estimatedMinutes: 5, phaseType: "cook", requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false }]
          : [],
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        captured.stepCreateManys.push(args.data);
        return { count: args.data.length };
      },
    },
    mealPlanItem: {
      create: async (args: { data: { mealId: string; positionIndex: number } }) => {
        captured.items.push({ mealId: args.data.mealId, positionIndex: args.data.positionIndex });
        return {};
      },
    },
    mealPlanTemplate: {
      findFirst: async () => null,
      create: async () => ({ id: "tpl-store-test" }),
    },
  };

  return { prismaStub, txStub, captured };
}

// Servings unification (BUG-046 / D-WS9-070) — the money check: a MIXED plan
// (store fork + live build) generated at per-run household=2, where both the
// catalog source and the AI-authored live meal are at 4, must land EVERY meal at
// servingsDefault=2 with anchor=4 → multiplier 0.5 on BOTH branches. This is the
// split-source fix: forks no longer read stored household independently — they
// receive the same effectiveHousehold the build slots use.
describe("materializeWizardDraft — BUG-046 servings unification (mixed fork+build)", () => {
  it("household=2 → both a forked slot and a built slot land at servingsDefault=2, anchor=4", async () => {
    const liveMeal = sampleExpanded().meals[0]; // AI-authored at servings: 4
    const savePlan: WizardSavePlan = {
      candidateId: "c1",
      title: "Mixed Plan",
      tags: ["mix"],
      whyBullets: ["b"],
      householdSize: 2, // per-run household
      slots: [
        { kind: "store", sourceStoreMealId: "s1" }, // catalog source at 4
        { kind: "build", meal: liveMeal, writeBack: false },
      ],
    };
    const { prismaStub, txStub, captured } = makeStoreStubs();

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan,
    });

    // Both the fork's cloned meal and the built meal flow through tx.meal.create.
    assert.equal(captured.mealCreates.length, 2, "one fork + one build meal");
    for (const m of captured.mealCreates) {
      assert.equal(m.servingsDefault, 2, "servingsDefault = effectiveHousehold on BOTH branches");
      assert.equal(
        m.authoredServingsDefault,
        4,
        "anchor = authored 4 on BOTH branches → render multiplier 2/4 = 0.5",
      );
    }
  });
});

describe("materializeWizardDraft — D-WS9-038 store fork + write-back", () => {
  it("materializes a 4-store/1-live plan: 5 items in slot order, forks stores, writes back the live meal", async () => {
    const liveMeal = sampleExpanded().meals[0]; // with-steps live meal
    const savePlan: WizardSavePlan = {
      candidateId: "c1",
      title: "Mixed Plan",
      tags: ["mix"],
      whyBullets: ["b"],
      slots: [
        { kind: "store", sourceStoreMealId: "s1" },
        { kind: "build", meal: liveMeal, writeBack: true },
        { kind: "store", sourceStoreMealId: "s2" },
        { kind: "store", sourceStoreMealId: "s3" },
        { kind: "store", sourceStoreMealId: "s4" },
      ],
    };
    const { prismaStub, txStub, captured } = makeStoreStubs();

    const result = await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan,
    });

    // 5 MealPlanItems, positionIndex 0..4 in slot order.
    assert.equal(captured.items.length, 5);
    assert.deepEqual(
      captured.items.map((i) => i.positionIndex),
      [0, 1, 2, 3, 4],
    );
    // Exactly one live_writeback pool meal was created (the write-back).
    const writeBacks = captured.mealCreates.filter(
      (d) => d.sourceType === "live_writeback" && d.isPublic === true,
    );
    assert.equal(writeBacks.length, 1, "one live meal → one live_writeback pool copy");
    // The live-slot's user meal is private + wizard-sourced.
    const wizardOwned = captured.mealCreates.filter(
      (d) => d.sourceType === "wizard" && d.isPublic === false,
    );
    assert.equal(wizardOwned.length, 1);
    // Forked steps survive: at least one dish-step createMany ran (fork copy).
    assert.ok(captured.stepCreateManys.length > 0, "forked store steps must be copied");
    assert.equal(result.itemsCreated, 5);
  });

  it("dedups a store meal used in two slots — forks it once (boundBySource)", async () => {
    const savePlan: WizardSavePlan = {
      candidateId: "c1",
      title: "Dup Plan",
      tags: [],
      whyBullets: ["b"],
      slots: [
        { kind: "store", sourceStoreMealId: "same" },
        { kind: "store", sourceStoreMealId: "same" },
      ],
    };
    const { prismaStub, txStub, captured } = makeStoreStubs();

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan,
    });

    // Both items bind the SAME forked meal id (forked once).
    assert.equal(captured.items.length, 2);
    assert.equal(captured.items[0].mealId, captured.items[1].mealId);
    // Only ONE fork meal.create (no write-back for store slots).
    assert.equal(captured.mealCreates.length, 1);
  });

  it("a demoted build slot (writeBack:false) does NOT write back", async () => {
    const liveMeal = sampleExpanded().meals[0];
    const savePlan: WizardSavePlan = {
      candidateId: "c1",
      title: "Demote Plan",
      tags: [],
      whyBullets: ["b"],
      slots: [{ kind: "build", meal: liveMeal, writeBack: false }],
    };
    const { prismaStub, txStub, captured } = makeStoreStubs();

    await materializeWizardDraft({
      prisma: prismaStub as unknown as PrismaClient,
      tx: txStub as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      draftId: DRAFT_ID,
      savePlan,
    });

    // Built the meal, but no live_writeback pool copy.
    assert.equal(
      captured.mealCreates.filter((d) => d.sourceType === "live_writeback").length,
      0,
    );
  });
});
