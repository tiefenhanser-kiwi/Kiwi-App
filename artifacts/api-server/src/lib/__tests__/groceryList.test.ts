// WS6 6c-4 Block A — consolidatePlanIngredients tests.
// Pure-logic over a stubbed Prisma (no DB). Mirrors the planMacros.test.ts
// duck-typed pattern.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  consolidatePlanIngredients,
  GroceryConsolidationForbiddenError,
  GroceryConsolidationNotFoundError,
  type ConsolidatedItem,
} from "../groceryList";
import { UNIVERSAL_STAPLES } from "../groceryStaples";

const TEST_USER = "user-grocery";
const TEST_PLAN = "plan-grocery";

interface IngStub {
  name: string; // displayName & canonicalName basis
  quantity: number;
  unit: string;
  category?: string; // → StoreSection mapping
  ingredientId?: string | null; // null → simulate dishIngredient with no ingredient row
  canonicalNameOverride?: string;
  purchaseUnit?: string | null;
  purchaseQuantity?: number | null;
  purchaseDisplay?: string | null;
  preparationNote?: string | null;
}

interface DishStub {
  id: string;
  title: string;
  servingsDefault: number;
  // WS7-8 BUG-003 — immutable authored anchor; omit/null = legacy/seed row.
  authoredServingsDefault?: number | null;
  ingredients: IngStub[];
}

interface ItemStub {
  id: string;
  positionIndex?: number;
  servingsOverride?: number | null;
  // WS7-7-A Block 5 — per-instance RecipeOverride (PRD §8.4.3). dishes[] by
  // position index; ingredients[] replace the dish's canonical ingredients.
  recipeOverrideJson?: unknown;
  dishes: DishStub[];
}

interface PlanStub {
  items: ItemStub[];
  pantryStaples?: Array<{ ingredientName: string; isActive?: boolean }>;
  recurringItems?: string[];
  ownerUserId?: string;
}

function buildPlanRow(plan: PlanStub) {
  return {
    id: TEST_PLAN,
    userId: plan.ownerUserId ?? TEST_USER,
    items: plan.items.map((it, idx) => ({
      id: it.id,
      mealPlanInstanceId: TEST_PLAN,
      mealId: `meal-${it.id}`,
      positionIndex: it.positionIndex ?? idx,
      assignedDayOfWeek: null,
      assignedDate: null,
      servingsOverride: it.servingsOverride ?? null,
      ingredientOverrides: null,
      recipeOverrideJson: it.recipeOverrideJson ?? null,
      isBreakfast: false,
      isLunch: false,
      isDinner: true,
      lastCooked: null,
      timesCooked: 0,
      notes: null,
      meal: {
        id: `meal-${it.id}`,
        title: `Meal ${it.id}`,
        dishLinks: it.dishes.map((d, di) => ({
          id: `link-${it.id}-${d.id}`,
          mealId: `meal-${it.id}`,
          dishId: d.id,
          positionIndex: di,
          dish: {
            id: d.id,
            title: d.title,
            servingsDefault: d.servingsDefault,
            authoredServingsDefault: d.authoredServingsDefault ?? null,
            dishIngredients: d.ingredients.map((ing, ii) => {
              const hasIngredient = ing.ingredientId !== null;
              return {
                id: `di-${d.id}-${ii}`,
                dishId: d.id,
                ingredientId: hasIngredient ? (ing.ingredientId ?? `ing-${ing.name}`) : null,
                quantity: ing.quantity,
                unit: ing.unit,
                preparationNote: ing.preparationNote ?? null,
                isOptional: false,
                positionIndex: ii,
                ingredient: hasIngredient
                  ? {
                      id: ing.ingredientId ?? `ing-${ing.name}`,
                      canonicalName: ing.canonicalNameOverride ?? ing.name.toLowerCase(),
                      displayName: ing.name,
                      category: ing.category ?? "Pantry",
                      subcategory: null,
                      defaultUnit: ing.unit,
                      nutritionRefPerUnit: null,
                      aliases: [],
                      isOptionalDefault: false,
                      purchaseUnit: ing.purchaseUnit ?? null,
                      purchaseQuantity: ing.purchaseQuantity ?? null,
                      purchaseDisplay: ing.purchaseDisplay ?? null,
                    }
                  : null,
              };
            }),
          },
        })),
      },
    })),
    user: {
      id: plan.ownerUserId ?? TEST_USER,
      pantryStaples: (plan.pantryStaples ?? []).map((p, i) => ({
        id: `ps-${i}`,
        userId: plan.ownerUserId ?? TEST_USER,
        ingredientName: p.ingredientName,
        restockCadence: "always_stocked",
        isActive: p.isActive ?? true,
        createdAt: new Date(),
      })),
      preferences:
        plan.recurringItems !== undefined
          ? {
              id: "prefs-1",
              userId: plan.ownerUserId ?? TEST_USER,
              // WS7-2 Block A: DB column renamed; local fixture-input field
              // name preserved for caller readability.
              recurringGroceryItems: plan.recurringItems,
            }
          : null,
    },
  };
}

// WS7-7-A Block 5 — the override path resolves ingredient names via
// prisma.ingredient.findFirst. `ingredients` seeds that lookup (by normalized
// canonical name); unseeded names resolve to null (brand-new override item).
function makePrisma(
  plan: PlanStub | null,
  ingredients: Array<{
    canonicalName: string;
    id: string;
    displayName?: string;
    category?: string;
  }> = [],
): PrismaClient {
  const byName = new Map(ingredients.map((i) => [i.canonicalName, i]));
  return {
    mealPlanInstance: {
      findUnique: async () => (plan ? buildPlanRow(plan) : null),
    },
    ingredient: {
      findFirst: async ({
        where,
      }: {
        where: { canonicalName: string };
      }) => {
        const hit = byName.get(where.canonicalName);
        if (!hit) return null;
        return {
          id: hit.id,
          canonicalName: hit.canonicalName,
          displayName: hit.displayName ?? hit.canonicalName,
          category: hit.category ?? "Pantry",
          purchaseUnit: null,
          purchaseQuantity: null,
          purchaseDisplay: null,
        };
      },
    },
  } as unknown as PrismaClient;
}

function findItem(list: ConsolidatedItem[], canonical: string): ConsolidatedItem | undefined {
  return list.find((i) => i.canonicalName === canonical);
}

// ────────────────────────────────────────────────────────────────────────

describe("consolidatePlanIngredients — guards", () => {
  it("throws NotFound when plan does not exist", async () => {
    const prisma = makePrisma(null);
    await assert.rejects(
      () => consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER }),
      GroceryConsolidationNotFoundError,
    );
  });

  it("throws Forbidden when plan belongs to another user", async () => {
    const prisma = makePrisma({ items: [], ownerUserId: "someone-else" });
    await assert.rejects(
      () => consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER }),
      GroceryConsolidationForbiddenError,
    );
  });
});

describe("consolidatePlanIngredients — empty / minimal", () => {
  it("returns empty list when plan has no items and no recurring items", async () => {
    const prisma = makePrisma({ items: [], recurringItems: [] });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.deepEqual(out, []);
  });

  it("returns recurring-only list when plan has no items but user has recurring items", async () => {
    const prisma = makePrisma({ items: [], recurringItems: ["paper towels", "trash bags"] });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 2);
    for (const item of out) {
      assert.equal(item.isRecurringItem, true);
      assert.equal(item.quantity, 1);
      assert.equal(item.unit, "each");
      assert.equal(item.sectionKey, "extras");
    }
  });

  it("returns one line for a single meal with a single ingredient", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "ground beef");
    assert.equal(out[0].quantity, 1);
    assert.equal(out[0].unit, "lb");
    assert.equal(out[0].sectionKey, "meat_seafood");
  });
});

describe("consolidatePlanIngredients — consolidation", () => {
  it("sums quantities when two meals share the same ingredient + unit", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Burgers",
              servingsDefault: 4,
              ingredients: [
                { name: "Ground Beef", quantity: 1.5, unit: "lb", category: "Protein" },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "ground beef");
    assert.equal(out[0].quantity, 2.5);
    // Two meal-plan slots (i1/d1, i2/d2) → two distinct (mealId, dishId) source
    // pairs on the single consolidated "ground beef" line.
    assert.equal(out[0].sources.length, 2);
  });

  it("keeps separate lines when units differ for the same ingredient", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Salad",
              servingsDefault: 4,
              ingredients: [{ name: "Olive Oil", quantity: 2, unit: "tbsp", category: "Pantry" }],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Pasta",
              servingsDefault: 4,
              ingredients: [{ name: "Olive Oil", quantity: 0.25, unit: "cup", category: "Pantry" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const oliveLines = out.filter((i) => i.canonicalName === "olive oil");
    assert.equal(oliveLines.length, 2);
    const units = oliveLines.map((l) => l.unit).sort();
    assert.deepEqual(units, ["cup", "tbsp"]);
  });

  it("applies servingsOverride as a multiplier on dishIngredient quantity", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          servingsOverride: 8, // double the dish default of 4
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 2); // 1 lb * (8/4)
  });

  // ── WS7-8 BUG-003 — authored-servings anchor as the denominator ──────────────

  it("divides by the authored anchor, NOT the live servingsDefault", async () => {
    // Simulate a future canonical promote: servingsDefault moved to 8, but the
    // anchor (where quantities were authored) stays 4. No override → numerator
    // falls back to the live servingsDefault 8, denominator is the anchor 4 → ×2.
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 8,
              authoredServingsDefault: 4,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 2); // 1 lb * (8/4)
  });

  it("null anchor (legacy/seed row) falls back to servingsDefault — no rescale", async () => {
    // Regression guard: a null anchor behaves exactly like today (multiplier 1).
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              authoredServingsDefault: null,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 1); // 1 lb * 1
  });
});

describe("consolidatePlanIngredients — Block 5 overrides + change-signature", () => {
  const flourDish = (qty: number) => ({
    items: [
      {
        id: "i1",
        dishes: [
          {
            id: "d1",
            title: "Bread",
            servingsDefault: 4,
            ingredients: [
              { name: "Flour", quantity: qty, unit: "cup", category: "Pantry" },
            ],
          },
        ],
      },
    ],
  });

  it("recipeOverrideJson replaces a dish's ingredients (quantity reflects override)", async () => {
    const prisma = makePrisma(
      {
        items: [
          {
            id: "i1",
            recipeOverrideJson: {
              dishes: [{ ingredients: [{ name: "Flour", quantity: 5, unit: "cup" }] }],
            },
            dishes: [
              {
                id: "d1",
                title: "Bread",
                servingsDefault: 4,
                ingredients: [
                  { name: "Flour", quantity: 2, unit: "cup", category: "Pantry" },
                ],
              },
            ],
          },
        ],
      },
      [{ canonicalName: "flour", id: "ing-flour", displayName: "Flour" }],
    );
    const out = await consolidatePlanIngredients({
      prisma,
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const flour = findItem(out, "flour")!;
    assert.ok(flour, "override ingredient present");
    assert.equal(flour.quantity, 5); // override value, NOT the canonical 2
    assert.equal(flour.ingredientId, "ing-flour"); // resolved by name
  });

  it("override that adds a brand-new ingredient buckets it with null ingredientId", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          recipeOverrideJson: {
            dishes: [{ ingredients: [{ name: "Saffron", quantity: 1, unit: "pinch" }] }],
          },
          dishes: [
            {
              id: "d1",
              title: "Rice",
              servingsDefault: 4,
              ingredients: [
                { name: "Rice", quantity: 2, unit: "cup", category: "Pantry" },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({
      prisma,
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    assert.equal(out.length, 1); // canonical rice gone, saffron in
    const saffron = findItem(out, "saffron")!;
    assert.ok(saffron);
    assert.equal(saffron.ingredientId, null);
  });

  it("emits servings + a stable ingredientSignature per source; signature moves when the set changes", async () => {
    const seed: Array<{ canonicalName: string; id: string }> = [
      { canonicalName: "flour", id: "ing-flour" },
    ];
    const out2 = await consolidatePlanIngredients({
      prisma: makePrisma(flourDish(2), seed),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const out5 = await consolidatePlanIngredients({
      prisma: makePrisma(flourDish(5), seed),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const src2 = findItem(out2, "flour")!.sources[0];
    const src5 = findItem(out5, "flour")!.sources[0];
    assert.equal(src2.servings, 4); // baseServings, no override
    assert.ok(src2.ingredientSignature.length > 0);
    assert.notEqual(src2.ingredientSignature, src5.ingredientSignature); // 2cup ≠ 5cup
  });

  it("signature is order-independent for the same set (stable carry)", async () => {
    const twoIng = (order: "ab" | "ba") => ({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Mix",
              servingsDefault: 4,
              ingredients:
                order === "ab"
                  ? [
                      { name: "Flour", quantity: 2, unit: "cup" },
                      { name: "Sugar", quantity: 1, unit: "cup" },
                    ]
                  : [
                      { name: "Sugar", quantity: 1, unit: "cup" },
                      { name: "Flour", quantity: 2, unit: "cup" },
                    ],
            },
          ],
        },
      ],
    });
    const ab = await consolidatePlanIngredients({
      prisma: makePrisma(twoIng("ab")),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const ba = await consolidatePlanIngredients({
      prisma: makePrisma(twoIng("ba")),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    assert.equal(
      findItem(ab, "flour")!.sources[0].ingredientSignature,
      findItem(ba, "flour")!.sources[0].ingredientSignature,
    );
  });
});

describe("consolidatePlanIngredients — section mapping", () => {
  it("maps known categories to the correct StoreSection", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Mix",
              servingsDefault: 4,
              ingredients: [
                { name: "Carrot", quantity: 1, unit: "lb", category: "Produce" },
                { name: "Chicken Breast", quantity: 1, unit: "lb", category: "Protein" },
                { name: "Cheddar", quantity: 1, unit: "block", category: "Dairy" },
                { name: "Rice", quantity: 1, unit: "cup", category: "Pantry" },
                { name: "Bread", quantity: 1, unit: "loaf", category: "Bakery" },
                { name: "Diced Tomatoes", quantity: 1, unit: "can", category: "Canned" },
                { name: "Frozen Peas", quantity: 1, unit: "bag", category: "Frozen" },
                { name: "Pretzels", quantity: 1, unit: "bag", category: "Snacks" },
                { name: "Paper Towels", quantity: 1, unit: "roll", category: "Household" },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(findItem(out, "carrot")?.sectionKey, "produce");
    assert.equal(findItem(out, "chicken breast")?.sectionKey, "meat_seafood");
    assert.equal(findItem(out, "cheddar")?.sectionKey, "dairy_eggs");
    assert.equal(findItem(out, "rice")?.sectionKey, "pantry");
    assert.equal(findItem(out, "bread")?.sectionKey, "bakery_bread");
    assert.equal(findItem(out, "diced tomatoes")?.sectionKey, "canned");
    assert.equal(findItem(out, "frozen peas")?.sectionKey, "frozen");
    assert.equal(findItem(out, "pretzels")?.sectionKey, "snacks");
    assert.equal(findItem(out, "paper towels")?.sectionKey, "household");
  });

  it("falls back to 'extras' for unknown categories", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Mystery",
              servingsDefault: 4,
              ingredients: [{ name: "Sparkles", quantity: 1, unit: "pinch", category: "MagicDust" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out[0].sectionKey, "extras");
  });
});

describe("consolidatePlanIngredients — staple flags", () => {
  it("flags all 14 universal staples regardless of input casing", async () => {
    // Variants: lowercase, uppercase, title case — name-matching should be case-insensitive.
    const variants = ["lower", "upper", "title"] as const;
    for (const variant of variants) {
      const prisma = makePrisma({
        items: [
          {
            id: "i1",
            dishes: [
              {
                id: "d1",
                title: "All Staples",
                servingsDefault: 4,
                ingredients: UNIVERSAL_STAPLES.map((s) => {
                  let presented: string = s.canonicalName;
                  if (variant === "upper") presented = s.canonicalName.toUpperCase();
                  if (variant === "title")
                    presented = s.canonicalName
                      .split(" ")
                      .map((w) => w[0].toUpperCase() + w.slice(1))
                      .join(" ");
                  return {
                    name: presented,
                    quantity: 1,
                    unit: "ea",
                    category: "Pantry",
                    canonicalNameOverride: presented,
                  };
                }),
              },
            ],
          },
        ],
      });
      const out = await consolidatePlanIngredients({
        prisma,
        planId: TEST_PLAN,
        userId: TEST_USER,
      });
      assert.equal(out.length, UNIVERSAL_STAPLES.length, `variant=${variant} length`);
      for (const item of out) {
        assert.equal(item.isUniversalStaple, true, `variant=${variant} ${item.canonicalName}`);
      }
    }
  });

  it("flags user pantry staples on matched items", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Stir fry",
              servingsDefault: 4,
              ingredients: [
                { name: "Soy Sauce", quantity: 2, unit: "tbsp", category: "Pantry" },
                { name: "Bok Choy", quantity: 1, unit: "head", category: "Produce" },
              ],
            },
          ],
        },
      ],
      pantryStaples: [{ ingredientName: "Bok Choy" }],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(findItem(out, "bok choy")?.isUserPantryStaple, true);
    assert.equal(findItem(out, "soy sauce")?.isUserPantryStaple, false);
  });

  it("ignores inactive pantry staples", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Stir fry",
              servingsDefault: 4,
              ingredients: [{ name: "Bok Choy", quantity: 1, unit: "head", category: "Produce" }],
            },
          ],
        },
      ],
      pantryStaples: [{ ingredientName: "Bok Choy", isActive: false }],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(findItem(out, "bok choy")?.isUserPantryStaple, false);
  });

  it("flags both staple flags on the same item when both apply", async () => {
    // Soy sauce is both a universal staple AND in this user's pantry.
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Stir fry",
              servingsDefault: 4,
              ingredients: [{ name: "Soy Sauce", quantity: 2, unit: "tbsp", category: "Pantry" }],
            },
          ],
        },
      ],
      pantryStaples: [{ ingredientName: "soy sauce" }],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out[0].isUniversalStaple, true);
    assert.equal(out[0].isUserPantryStaple, true);
  });

  it("WS7-5d Block 5 Fix 1: flags 'water' as a universal staple (recipe 'water' does not become a buyable bottle)", async () => {
    // Device-test surfaced "water" rendering as a buyable grocery row when a
    // recipe called for "1/2 cup water". Staple-flagging routes it to the
    // dimmed default-staple state in the UI (same as salt/pepper) — the user
    // can still opt in if they actually want bottled water on the trip.
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Soup base",
              servingsDefault: 4,
              ingredients: [
                { name: "Water", quantity: 0.5, unit: "cup", category: "Pantry" },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({
      prisma,
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const water = findItem(out, "water");
    assert.ok(water, "water entry should exist on the consolidated list");
    assert.equal(water!.isUniversalStaple, true);
  });
});

describe("consolidatePlanIngredients — recurring items", () => {
  it("flags an existing matched item as recurring without duplicating", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Greek Yogurt Bowl",
              servingsDefault: 4,
              ingredients: [{ name: "Greek Yogurt", quantity: 2, unit: "cup", category: "Dairy" }],
            },
          ],
        },
      ],
      recurringItems: ["greek yogurt"],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "greek yogurt");
    assert.equal(out[0].isRecurringItem, true);
    assert.equal(out[0].quantity, 2); // not overwritten
    assert.equal(out[0].unit, "cup"); // not overwritten
  });

  it("appends an unmatched recurring item with quantity 1 / unit each / section extras", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
      ],
      recurringItems: ["paper towels"],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const towels = findItem(out, "paper towels");
    assert.ok(towels, "recurring item should be appended");
    assert.equal(towels!.isRecurringItem, true);
    assert.equal(towels!.quantity, 1);
    assert.equal(towels!.unit, "each");
    assert.equal(towels!.sectionKey, "extras");
  });
});

describe("consolidatePlanIngredients — null ingredient fallback", () => {
  it("groups by displayName when dishIngredient has no ingredient row", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Custom",
              servingsDefault: 4,
              ingredients: [
                { name: "Mystery powder", quantity: 1, unit: "tsp", ingredientId: null },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    // Falls back to dishIngredient.id as a unique canonical when no ingredient row.
    // sectionKey defaults to extras (no category to map).
    assert.equal(out[0].sectionKey, "extras");
    assert.equal(out[0].ingredientId, null);
  });
});

describe("consolidatePlanIngredients — purchase-size pass-through", () => {
  it("passes through populated Ingredient.purchaseUnit/Quantity/Display fields when present", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Chili",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Diced Tomatoes",
                  quantity: 6,
                  unit: "oz",
                  category: "Pantry",
                  purchaseUnit: "can",
                  purchaseQuantity: 1,
                  purchaseDisplay: "1 can (6 oz)",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].purchaseUnit, "can");
    assert.equal(out[0].purchaseQuantity, 1);
    assert.equal(out[0].purchaseDisplay, "1 can (6 oz)");
  });

  it("returns null purchase fields when the Ingredient row has them null (default state)", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              ingredients: [{ name: "Ground Beef", quantity: 1, unit: "lb", category: "Protein" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].purchaseUnit, null);
    assert.equal(out[0].purchaseQuantity, null);
    assert.equal(out[0].purchaseDisplay, null);
  });
});

// ── prep-note + source-dish-title threading ────────────────────────────
//
// WS7-5d Block 4 Fix 1 — bucket key dropped `normalizedPrep` so the
// consolidator now obeys PRD §2.8 (one row per ingredient, summed). The
// 6c-5 split-by-prep behavior was a wrong call; prep is recipe metadata
// that belongs on the recipe page, not the grocery list. The first
// non-null prep observed in a merged bucket still flows on
// ConsolidatedItem.preparationNote for the downstream AI form-inference
// path, but rows no longer split on prep.

describe("consolidatePlanIngredients — prep-note merging + dish title", () => {
  it("merges same canonical + same prep into one row, preserving prep + summing qty", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Chicken Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Chicken Salad",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 0.5,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const chickenLines = out.filter((i) => i.canonicalName === "chicken");
    assert.equal(chickenLines.length, 1);
    assert.equal(chickenLines[0].quantity, 1.5);
    assert.equal(chickenLines[0].preparationNote, "shredded");
  });

  it("MERGES same canonical with different prep notes into one row, summing qty + keeping first prep (Block 4 Fix 1)", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Chicken Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Chicken Soup",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "diced",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const chickenLines = out.filter((i) => i.canonicalName === "chicken");
    assert.equal(chickenLines.length, 1);
    assert.equal(chickenLines[0].quantity, 2);
    // First-seen prep wins ("shredded" from i1; "diced" from i2 is dropped).
    assert.equal(chickenLines[0].preparationNote, "shredded");
  });

  it("MERGES one null prep + one non-null prep into one row, keeping the non-null prep (Block 4 Fix 1)", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Roast Chicken",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: null,
                },
              ],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Chicken Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const chickenLines = out.filter((i) => i.canonicalName === "chicken");
    assert.equal(chickenLines.length, 1);
    assert.equal(chickenLines[0].quantity, 2);
    // i1 sees null first → entry.preparationNote = null; i2 then upgrades it
    // to "shredded" via the null→non-null backfill at groceryList.ts:222.
    assert.equal(chickenLines[0].preparationNote, "shredded");
  });

  it("populates sourceDishTitle from the first contributing dish", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Chicken Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceDishTitle, "Chicken Tacos");
  });

  it("extends sourceDishTitle across distinct dishes that share the same merge bucket", async () => {
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Chicken Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Caesar Salad",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  quantity: 0.5,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceDishTitle, "Chicken Tacos, Caesar Salad");
  });

  it("synthetic recurring entries have null preparationNote and null sourceDishTitle", async () => {
    const prisma = makePrisma({
      items: [],
      recurringItems: ["paper towels"],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    assert.equal(out.length, 1);
    assert.equal(out[0].preparationNote, null);
    assert.equal(out[0].sourceDishTitle, null);
  });

  it("normalizes canonical casing/whitespace when deciding the bucket (Block 4 Fix 1)", async () => {
    // "Chicken" + " chicken " + "the chicken" → all bucket together via the
    // normalizeIngredientName applied at the bucket key. The 6c-5 prep
    // casing test it replaces is moot now that prep is no longer in the key.
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  canonicalNameOverride: "Chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "shredded",
                },
              ],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Salad",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  canonicalNameOverride: "  chicken  ",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: "diced",
                },
              ],
            },
          ],
        },
        {
          id: "i3",
          dishes: [
            {
              id: "d3",
              title: "Soup",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Chicken",
                  canonicalNameOverride: "the chicken",
                  quantity: 1,
                  unit: "lb",
                  category: "Protein",
                  preparationNote: null,
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const chickenLines = out.filter(
      (i) => i.canonicalName.toLowerCase().trim().replace(/^(the |a )/, "") === "chicken",
    );
    assert.equal(chickenLines.length, 1);
    assert.equal(chickenLines[0].quantity, 3);
  });

  it("multi-meal same-ingredient device-test repro: yellow onion across 3 dishes with 3 prep verbs → ONE row (Block 4 Fix 1 acceptance)", async () => {
    // Mirrors the device-test pattern Hans saw: same canonical + unit, three
    // distinct prep verbs across three recipes. Pre-fix this produced 3 rows
    // (the lime/onion/butter duplicates on the device list). Post-fix:
    // one merged row, summed quantity.
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "Steak Skillet",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Yellow onion",
                  quantity: 2,
                  unit: "each",
                  category: "Produce",
                  preparationNote: "diced",
                },
              ],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "Pico de Gallo",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Yellow onion",
                  quantity: 2,
                  unit: "each",
                  category: "Produce",
                  preparationNote: "finely diced",
                },
              ],
            },
          ],
        },
        {
          id: "i3",
          dishes: [
            {
              id: "d3",
              title: "Beef Tacos",
              servingsDefault: 4,
              ingredients: [
                {
                  name: "Yellow onion",
                  quantity: 1,
                  unit: "each",
                  category: "Produce",
                  preparationNote: "sliced",
                },
              ],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const onions = out.filter((i) => i.canonicalName === "yellow onion");
    assert.equal(onions.length, 1, "yellow onion should merge to ONE row regardless of prep variation");
    assert.equal(onions[0].quantity, 5, "summed across all three contributing dishes");
    // First-seen non-null prep is preserved for AI form-inference.
    assert.equal(onions[0].preparationNote, "diced");
  });
});

// ── WS7-8b B1 (BUG-025-2) — fractional round-up per PRD §2.8 [LOCKED] ────────
//
// Consolidation multiplies scaled quantities into decimals; the shopper must
// never see a fractional buy-count. Discrete/unknown units ceil to a whole
// unit; measured (volume/weight) units round the fractional remainder UP to
// the nearest sensible kitchen fraction on the ¼/⅓/½/⅔/¾ ladder.

describe("consolidatePlanIngredients — BUG-025-2 quantity round-up", () => {
  const oneIng = (
    quantity: number,
    unit: string,
    servingsDefault = 4,
    servingsOverride: number | null = null,
  ) => ({
    items: [
      {
        id: "i1",
        servingsOverride,
        dishes: [
          {
            id: "d1",
            title: "Dish",
            servingsDefault,
            ingredients: [
              { name: "Thing", quantity, unit, category: "Pantry" },
            ],
          },
        ],
      },
    ],
  });

  const qtyOf = async (
    quantity: number,
    unit: string,
    servingsDefault = 4,
    servingsOverride: number | null = null,
  ) => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma(oneIng(quantity, unit, servingsDefault, servingsOverride)),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    return out[0].quantity;
  };

  it("discrete count ceils to a whole unit (0.75 → 1, 5.5 → 6, 3.75 → 4)", async () => {
    assert.equal(await qtyOf(0.75, "each"), 1);
    assert.equal(await qtyOf(5.5, "each"), 6);
    assert.equal(await qtyOf(3.75, "clove"), 4);
  });

  it("discrete ceil applies to the multiply→decimal path (3 cloves × 1.25 = 3.75 → 4)", async () => {
    // servingsOverride 5 over a default of 4 → multiplier 1.25 → 3 × 1.25 = 3.75.
    assert.equal(await qtyOf(3, "clove", 4, 5), 4);
  });

  it("unknown / empty units are treated as discrete and ceil to whole", async () => {
    assert.equal(await qtyOf(2.1, "sprig"), 3); // sprig not measured
    assert.equal(await qtyOf(1.2, ""), 2); // empty unit
  });

  it("measured need quantities round UP on the ⅛ ladder — fine-grained, NOT toward a purchase size", async () => {
    assert.equal(await qtyOf(1.1, "cup"), 1.125); // 0.1 → ⅛, NOT ¼ and NOT ½
    assert.equal(await qtyOf(1.43, "cup"), 1.5); // 0.43 → ½ (⅜=0.375 < 0.43)
    assert.equal(await qtyOf(0.2, "cup"), 0.25); // 0.2 → ¼ (⅛=0.125 < 0.2)
    // 1.3 → ⅓ (0.3333…): the ladder keeps clean thirds where a value rounds up
    // to land essentially on them (0.3 is below ⅓, above ¼).
    assert.ok(Math.abs((await qtyOf(1.3, "cup")) - (1 + 1 / 3)) < 1e-9);
    // 1.7 → ¾ (0.75), the ladder step above ⅔ (0.6667).
    assert.equal(await qtyOf(1.7, "cup"), 1.75);
  });

  it("round-UP holds where clean thirds sit between eighths — a value just above ⅓/⅔ never rounds DOWN to them", async () => {
    // 0.34 is just above ⅓ (0.3333) → must round UP to ⅜ (0.375), not down to ⅓.
    assert.equal(await qtyOf(1.34, "cup"), 1 + 3 / 8);
    // 0.68 is just above ⅔ (0.6667) → must round UP to ¾ (0.75), not down to ⅔.
    assert.equal(await qtyOf(1.68, "cup"), 1.75);
  });

  it("whole-number inputs pass through unchanged (measured and discrete)", async () => {
    assert.equal(await qtyOf(2, "cup"), 2);
    assert.equal(await qtyOf(3, "each"), 3);
    assert.equal(await qtyOf(1, "lb"), 1);
  });

  it("a value already on the ⅛ ladder is not inflated", async () => {
    assert.equal(await qtyOf(2.5, "cup"), 2.5); // exactly ½
    assert.equal(await qtyOf(1.25, "cup"), 1.25); // exactly ¼
    assert.equal(await qtyOf(1.125, "cup"), 1.125); // exactly ⅛
    assert.ok(Math.abs((await qtyOf(1 + 1 / 3, "cup")) - (1 + 1 / 3)) < 1e-9); // exactly ⅓
  });
});

// ── WS7-8b B1 (BUG-025-3) — recurring-item purchase representation (§12.8) ────

describe("consolidatePlanIngredients — BUG-025-3 recurring purchase default", () => {
  it("an unmatched recurring item WITH a purchase default renders the default unit (bananas → 1 bunch)", async () => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({ items: [], recurringItems: ["bananas"] }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const bananas = findItem(out, "bananas")!;
    assert.ok(bananas, "recurring bananas appended");
    assert.equal(bananas.isRecurringItem, true);
    assert.equal(bananas.unit, "bunch");
    assert.equal(bananas.quantity, 1);
    assert.equal(bananas.purchaseUnit, "bunch");
    assert.equal(bananas.purchaseQuantity, 1);
    assert.equal(bananas.purchaseDisplay, "1 bunch");
  });

  it("a recurring produce item pulls its own default (garlic → 1 head)", async () => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({ items: [], recurringItems: ["garlic"] }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const garlic = findItem(out, "garlic")!;
    assert.equal(garlic.unit, "head");
    assert.equal(garlic.purchaseDisplay, "1 head");
  });

  it("an unmatched recurring item WITHOUT a purchase default falls back to each/1/null", async () => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({ items: [], recurringItems: ["paper towels"] }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const towels = findItem(out, "paper towels")!;
    assert.equal(towels.unit, "each");
    assert.equal(towels.quantity, 1);
    assert.equal(towels.purchaseUnit, null);
    assert.equal(towels.purchaseQuantity, null);
    assert.equal(towels.purchaseDisplay, null);
  });

  it("a recurring name matching a real plan line does NOT get a synthetic entry (match-flag path unchanged)", async () => {
    // "garlic" is a purchase-default item, but here it already appears from a
    // dish — the match path must flag the existing line, NOT append a synthetic
    // bunch/head entry. Guards the no-add invariant for 025-3.
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({
        items: [
          {
            id: "i1",
            dishes: [
              {
                id: "d1",
                title: "Aglio e Olio",
                servingsDefault: 4,
                ingredients: [{ name: "Garlic", quantity: 4, unit: "clove", category: "Produce" }],
              },
            ],
          },
        ],
        recurringItems: ["garlic"],
      }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const garlicLines = out.filter((i) => i.canonicalName === "garlic");
    assert.equal(garlicLines.length, 1, "no synthetic duplicate appended");
    assert.equal(garlicLines[0].isRecurringItem, true);
    assert.equal(garlicLines[0].unit, "clove"); // real line's unit, not overwritten
    assert.equal(garlicLines[0].quantity, 4);
  });
});

// ── WS7-8b B1 (BUG-025-5) — staple variant → base normalization (§2.2/§12.7) ──

describe("consolidatePlanIngredients — BUG-025-5 staple variants", () => {
  const stapleFlag = async (canonical: string) => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({
        items: [
          {
            id: "i1",
            dishes: [
              {
                id: "d1",
                title: "Dish",
                servingsDefault: 4,
                ingredients: [
                  {
                    name: canonical,
                    canonicalNameOverride: canonical,
                    quantity: 1,
                    unit: "tsp",
                    category: "Pantry",
                  },
                ],
              },
            ],
          },
        ],
      }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    return out[0].isUniversalStaple;
  };

  it("salt / pepper / oil variants match the base staple (render greyed)", async () => {
    for (const v of [
      "kosher salt",
      "sea salt",
      "table salt",
      "coarse sea salt",
      "flaky salt",
      "cracked black pepper",
      "ground black pepper",
      "freshly ground black pepper",
      "extra-virgin olive oil",
      "extra virgin olive oil",
      "light olive oil",
    ]) {
      assert.equal(await stapleFlag(v), true, `${v} should be flagged a universal staple`);
    }
  });

  it("must NOT sweep in seasonings/near-misses that merely contain a staple word", async () => {
    for (const v of [
      "salted butter", // contains "salt" — is not table salt
      "garlic salt", // seasoning
      "celery salt", // seasoning
      "onion salt", // seasoning
      "seasoned salt", // seasoning
      "bell pepper", // produce
      "white pepper", // distinct spice
      "red pepper flakes", // distinct spice
    ]) {
      assert.equal(await stapleFlag(v), false, `${v} must NOT be treated as a universal staple`);
    }
  });

  it("the plain base staples still match (no regression from the variant map)", async () => {
    assert.equal(await stapleFlag("salt"), true);
    assert.equal(await stapleFlag("black pepper"), true);
    assert.equal(await stapleFlag("olive oil"), true);
  });
});

// ── WS7-8b B1 — no-add / no-drop invariant across all three fixes ────────────

describe("consolidatePlanIngredients — B1 no-add/no-drop invariant", () => {
  it("item set + consolidation grouping unchanged; only quantity/unit/staple-flag differ", async () => {
    // A representative plan that exercises all three fixes at once:
    //   - fractional decimals (5.5 lemons discrete; 1.43 cup flour measured)
    //   - a staple variant (kosher salt) that must grey, not buy
    //   - a recurring item with a purchase default (bananas → bunch)
    // The consolidator must emit exactly one line per (canonical, unit) bucket
    // plus the one appended recurring line — no item added or dropped.
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({
        items: [
          {
            id: "i1",
            dishes: [
              {
                id: "d1",
                title: "Lemon Bars",
                servingsDefault: 4,
                ingredients: [
                  { name: "Lemon", quantity: 5.5, unit: "each", category: "Produce" },
                  { name: "Flour", quantity: 1.43, unit: "cup", category: "Pantry" },
                  {
                    name: "Kosher salt",
                    canonicalNameOverride: "kosher salt",
                    quantity: 0.5,
                    unit: "tsp",
                    category: "Pantry",
                  },
                ],
              },
            ],
          },
        ],
        recurringItems: ["bananas"],
      }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });

    // Exactly the four expected buckets — nothing added, nothing dropped.
    const bucketKeys = out.map((i) => `${i.canonicalName}|${i.unit}`).sort();
    assert.deepEqual(bucketKeys, [
      "bananas|bunch", // recurring, purchase-default unit applied
      "flour|cup",
      "kosher salt|tsp", // canonical NAME preserved (rendered greyed, not renamed)
      "lemon|each",
    ]);

    // Quantities rounded up; staple flagged; canonical/display names untouched.
    assert.equal(findItem(out, "lemon")!.quantity, 6); // 5.5 → 6 discrete
    assert.ok(Math.abs(findItem(out, "flour")!.quantity - 1.5) < 1e-9); // 1.43 → 1½
    const salt = findItem(out, "kosher salt")!;
    assert.equal(salt.isUniversalStaple, true); // greyed, not buyable
    assert.equal(salt.canonicalName, "kosher salt"); // NOT mutated to "salt"
    assert.equal(salt.displayName, "Kosher salt"); // user still sees the variant
  });
});
