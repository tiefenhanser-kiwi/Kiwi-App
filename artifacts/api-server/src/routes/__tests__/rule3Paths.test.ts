// [grocery] B3 · Part D (D-WS9-277 Rule 3 / D-WS9-284 ruling 10) — ONE PATH.
//
// Hans: "if no shortcut, or no from scratch, just show that's there. but to your
// specific point, if only shortcut, show shortcut."
//
// The defect (BUG-121 / BUG-322): composeMealDetail applied no path filter, so a
// dish with a swappable component returned its from-scratch steps AND the
// store-bought alternates, interleaved by stepIndex, to every reader. The
// scheduler meanwhile dropped `bought` UNCONDITIONALLY, so the 10 dev components
// that have only a bought path lost the only step that makes them — Classic
// Chicken Noodle Soup timed itself with no broth step at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";

import { composeMealDetail } from "../meals";
import { composeInstacartPayload } from "../../lib/retailers/instacartPayload";

// ── a meal, with the two component shapes that matter ───────────────────────

interface StepFix {
  stepIndex: number;
  text: string;
  componentKey: string | null;
  pathKey: string | null;
}

/** "sauce" has BOTH paths; "broth" has only bought (the 10-component shape). */
const STEPS: StepFix[] = [
  { stepIndex: 0, text: "Chop the aromatics.", componentKey: null, pathKey: null },
  { stepIndex: 1, text: "Simmer the sauce for 40 minutes.", componentKey: "sauce", pathKey: "scratch" },
  { stepIndex: 2, text: "Open the jar of marinara.", componentKey: "sauce", pathKey: "bought" },
  { stepIndex: 3, text: "Pour both cartons of low-sodium chicken broth into the pot.", componentKey: "broth", pathKey: "bought" },
  { stepIndex: 4, text: "Plate and serve.", componentKey: null, pathKey: null },
];

function makePrisma(steps: StepFix[] = STEPS): PrismaClient {
  return {
    meal: {
      findUnique: async () => ({
        id: "meal-1",
        title: "Test meal",
        displayTitle: null,
        description: null,
        cuisineType: "italian",
        estimatedTimeMinutes: 45,
        activeTimeMinutes: null,
        servingsDefault: 4,
        authoredServingsDefault: 4,
        caloriesPerServing: 0,
        proteinGPerServing: 0,
        carbsGPerServing: 0,
        fatGPerServing: 0,
        tags: [],
        imageUrl: null,
        isArchived: false,
        difficulty: "easy",
        mealType: "dinner",
        sourceType: "manual",
        isPublic: false,
        userId: "user-1",
        dishLinks: [
          {
            positionIndex: 0,
            roleLabel: "main",
            dish: {
              id: "dish-1",
              title: "Test dish",
              estimatedTimeMinutes: 45,
              difficulty: "easy",
              servingsDefault: 4,
              authoredServingsDefault: 4,
              dishIngredients: [
                {
                  quantity: 1,
                  unit: "cup",
                  preparationNote: null,
                  isOptional: false,
                  componentKey: null,
                  pathKey: null,
                  ingredient: { displayName: "marinara", category: "Canned" },
                },
              ],
            },
          },
        ],
      }),
    },
    recipeInstructionStep: {
      findMany: async ({ where }: { where: { ownerType: string } }) =>
        where.ownerType === "meal"
          ? []
          : steps.map((s) => ({
              // composeMealDetail groups by ownerId; without it every dish falls
              // back to the (empty) meal-owned list.
              ownerId: "dish-1",
              stepIndex: s.stepIndex,
              stepTextTranslated: s.text,
              stepTextRaw: s.text,
              estimatedMinutes: 5,
              phaseType: "prep",
              requiresPreheat: false,
              requiresRest: false,
              requiresMarination: false,
              isTimingSensitive: false,
              parallelGroup: null,
              amountRefs: null,
              componentKey: s.componentKey,
              pathKey: s.pathKey,
            })),
    },
  } as unknown as PrismaClient;
}

describe("[grocery] B3 — Rule 3 on the wire", () => {
  it("a component with BOTH paths returns SCRATCH only", async () => {
    const meal = (await composeMealDetail(makePrisma(), "meal-1"))!;
    const idx = meal.dishes[0].steps.map((s) => s.stepIndex);
    assert.ok(idx.includes(1), "the scratch step is the default");
    assert.ok(!idx.includes(2), "and its bought alternate is not on the wire");
  });

  it("a component with ONLY bought returns BOUGHT — the fix, not a leak", async () => {
    const meal = (await composeMealDetail(makePrisma(), "meal-1"))!;
    const idx = meal.dishes[0].steps.map((s) => s.stepIndex);
    assert.ok(
      idx.includes(3),
      "the only way the broth happens must reach the reader; dropping it is BUG-121",
    );
  });

  it("base steps are untouched, and the order is the persisted one", async () => {
    const meal = (await composeMealDetail(makePrisma(), "meal-1"))!;
    assert.deepEqual(meal.dishes[0].steps.map((s) => s.stepIndex), [0, 1, 3, 4]);
  });

  it("the wire CARRIES componentKey and pathKey, null on an untagged step", async () => {
    const meal = (await composeMealDetail(makePrisma(), "meal-1"))!;
    const byIndex = new Map(meal.dishes[0].steps.map((s) => [s.stepIndex, s]));
    assert.equal(byIndex.get(0)!.componentKey, null);
    assert.equal(byIndex.get(0)!.pathKey, null);
    assert.equal(byIndex.get(1)!.componentKey, "sauce");
    assert.equal(byIndex.get(1)!.pathKey, "scratch");
    assert.equal(byIndex.get(3)!.componentKey, "broth");
    assert.equal(byIndex.get(3)!.pathKey, "bought");
  });

  it("ingredients carry the two tags too — null on every row today (0 of 43,041 tagged)", async () => {
    const meal = (await composeMealDetail(makePrisma(), "meal-1"))!;
    const ing = meal.dishes[0].ingredients[0];
    assert.equal(ing.componentKey, null);
    assert.equal(ing.pathKey, null);
  });

  it("a dish whose every component is bought-only keeps ALL its steps", async () => {
    const onlyBought: StepFix[] = [
      { stepIndex: 0, text: "Open the jar.", componentKey: "sauce", pathKey: "bought" },
      { stepIndex: 1, text: "Warm the beans.", componentKey: "beans", pathKey: "bought" },
    ];
    const meal = (await composeMealDetail(makePrisma(onlyBought), "meal-1"))!;
    assert.deepEqual(meal.dishes[0].steps.map((s) => s.stepIndex), [0, 1]);
  });
});

// ── the Instacart food payload — D-WS9-284 ruling 5 ─────────────────────────
//
// The payload is CLIENT-DRIVEN: nothing reaches it that the phone did not send
// (row 8's "ten-second check"). So the server's job is to make household
// LEGIBLE — `storeSection: "household"` and `recurringFacets.household` — and to
// compose whatever the user did include. Both halves are asserted here.

function row(id: string, displayName: string) {
  return {
    id,
    displayName,
    userResolvedTo: null,
    quantity: 1,
    unit: "each",
    deletedAt: null,
    purchaseQuantity: 1,
    purchaseUnit: "bag",
    purchaseDisplay: "1 bag (1 lb)",
    purchaseUnitOverride: null,
    purchaseQuantityOverride: null,
    purchaseDisplayOverride: null,
  };
}

describe("[grocery] B3 — the Instacart food payload", () => {
  const rows = [row("it-coffee", "coffee"), row("it-towels", "paper towels")];

  it("coffee IS in the payload — it names no catalog row and is still a food", () => {
    const { payload } = composeInstacartPayload(
      rows,
      [{ groceryListItemId: "it-coffee" }],
      { title: "Groceries" },
    );
    assert.equal(payload.line_items.length, 1);
    assert.equal(payload.line_items[0].name, "coffee");
  });

  it("a household row the user did NOT include never reaches the payload", () => {
    const { payload } = composeInstacartPayload(
      rows,
      [{ groceryListItemId: "it-coffee" }],
      { title: "Groceries" },
    );
    assert.ok(
      !payload.line_items.some((i) => i.name.includes("towel")),
      "nothing the phone did not send is ordered",
    );
  });

  it("…and one the user DID include is ordered, because that is the ruling", () => {
    // D-WS9-228: household never reaches the food items "unless the user
    // included it". The flag defaults the phone's checkbox off; it does not
    // overrule a person who ticked it.
    const { payload } = composeInstacartPayload(
      rows,
      [{ groceryListItemId: "it-coffee" }, { groceryListItemId: "it-towels" }],
      { title: "Groceries" },
    );
    assert.equal(payload.line_items.length, 2);
  });
});
