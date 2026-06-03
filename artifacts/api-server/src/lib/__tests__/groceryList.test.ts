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
  ingredients: IngStub[];
}

interface ItemStub {
  id: string;
  positionIndex?: number;
  servingsOverride?: number | null;
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
      recipeOverrideJson: null,
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

function makePrisma(plan: PlanStub | null): PrismaClient {
  return {
    mealPlanInstance: {
      findUnique: async () => (plan ? buildPlanRow(plan) : null),
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
    assert.equal(out[0].sourceDishIds.length, 2);
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
