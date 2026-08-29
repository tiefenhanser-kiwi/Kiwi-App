// WS6 6c-4 Block A — consolidatePlanIngredients tests.
// Pure-logic over a stubbed Prisma (no DB). Mirrors the planMacros.test.ts
// duck-typed pattern.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  bucketKeyOf,
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
  // WS9 BUG-096 — aliasKey → canonicalName. Models the POST-MERGE catalog:
  // the loser row is GONE and its name survives only as an alias.
  aliases: Record<string, string> = {},
): PrismaClient {
  const byName = new Map(ingredients.map((i) => [i.canonicalName, i]));
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  return {
    mealPlanInstance: {
      findUnique: async () => (plan ? buildPlanRow(plan) : null),
    },
    // WS9 BUG-096 — the alias-aware lookup consults this after a canonical
    // miss, resolving against the `aliases` fixture so a merged-away name is
    // exercised through consolidatePlanIngredients, not against the helper.
    ingredientAlias: {
      findUnique: async ({ where }: { where: { aliasKey: string } }) => {
        const canonical = aliases[where.aliasKey];
        const hit = canonical ? byName.get(canonical) : undefined;
        return hit ? { ingredient: { id: hit.id, canonicalName: hit.canonicalName } } : null;
      },
      findMany: async () => [],
    },
    ingredient: {
      // Handles BOTH shapes the resolver uses: the canonical-name probe, and
      // the by-id re-read that follows an alias hit.
      findFirst: async ({
        where,
      }: {
        where: { canonicalName?: string; id?: string };
      }) => {
        const hit = where.id ? byId.get(where.id) : byName.get(where.canonicalName!);
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

  // WS7-8b B2 (BUG-031) — same-canonical/different-unit rows the conversion
  // table CAN reconcile now merge deterministically (was: kept separate for the
  // AI to reconcile with no density data — the 3.97 bug). Olive oil is curated
  // (gramsPerCup 216), so 2 tbsp + 0.25 cup merges via grams into one cup line.
  it("merges same-canonical measured units via the conversion table", async () => {
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
    // 2 tbsp (0.125 cup → 27 g) + 0.25 cup (54 g) = 81 g ÷ 216 g/cup = 0.375 cup (⅜).
    assert.equal(oliveLines.length, 1);
    assert.equal(oliveLines[0].unit, "cup");
    assert.ok(Math.abs(oliveLines[0].quantity - 0.375) < 1e-9);
    // Provenance from BOTH source dishes survives the merge.
    assert.equal(oliveLines[0].sources.length, 2);
  });

  it("keeps separate lines when the table can't convert the units", async () => {
    // A canonical NOT in the conversion table with volume + count units — no
    // gramsPerCup and no subUnit, so the merge aborts and both lines survive
    // for the AI reconciliation path.
    const prisma = makePrisma({
      items: [
        {
          id: "i1",
          dishes: [
            {
              id: "d1",
              title: "A",
              servingsDefault: 4,
              ingredients: [{ name: "Mystery Sauce", quantity: 1, unit: "cup", category: "Pantry" }],
            },
          ],
        },
        {
          id: "i2",
          dishes: [
            {
              id: "d2",
              title: "B",
              servingsDefault: 4,
              ingredients: [{ name: "Mystery Sauce", quantity: 2, unit: "each", category: "Pantry" }],
            },
          ],
        },
      ],
    });
    const out = await consolidatePlanIngredients({ prisma, planId: TEST_PLAN, userId: TEST_USER });
    const lines = out.filter((i) => i.canonicalName === "mystery sauce");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.unit).sort(), ["cup", "each"]);
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
  // WS9 BUG-182 grew this list from 14 to 19 entries, and BUG-181 means the
  // output is no longer one row per entry: the three olive-oil spellings fold
  // to one row and the three ground-pepper spellings fold to another, so 19
  // inputs consolidate to 15 rows. The assertion below counts DISTINCT MERGE
  // GROUPS rather than list length for that reason — a hand-written 15, not a
  // second read of the map.
  it("flags every universal staple regardless of input casing", async () => {
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
      assert.equal(out.length, 15, `variant=${variant} length`);
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

  // ⚠️ SUPERSEDED RULING — this test was INVERTED, not fixed. As written in
  // WS7-5d Block 5 Fix 1 (2026-06-03) it asserted `isUniversalStaple === true`
  // for water, and it was correct for the ruling in force then: staple-flag it
  // so it renders dimmed, and let the user opt in "if they actually want
  // bottled water on the trip".
  //
  // Hans has since ruled that opt-in away entirely (BUG-169): "we shouldn't
  // tell someone to order water. I can't think of a need to order water for
  // groceries for a meal." A dimmed row is still a row, so the old assertion
  // now pins behaviour the product no longer wants. Changed because the RULING
  // changed — not because the test was wrong when it was written.
  it("BUG-169 (supersedes WS7-5d Block 5 Fix 1): a recipe's 'water' produces NO row at all", async () => {
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
    assert.equal(
      findItem(out, "water"),
      undefined,
      "water must not reach the consolidated list at all — not even dimmed",
    );
    assert.equal(out.length, 0, "the dish contributed nothing else");
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
// Consolidation multiplies scaled quantities into decimals. Every unit —
// discrete and measured alike — rounds the fractional remainder UP to the
// nearest sensible kitchen fraction on the ⅛ ladder (clean ⅓/⅔ preserved).
//
// WS9 Root B RETITLED THE DISCRETE CASES BELOW. They previously asserted that
// discrete/unknown units CEIL to a whole (5.5 each → 6). That was rounding the
// NEED toward a purchasable amount, which PRD §2.8 [LOCKED] forbids in the same
// sentence this block cites — and it hid real changes, because ½ lemon and
// 1 lemon both displayed as 1. The shopper still "never sees a fractional
// buy-count": BUG-125 moved that round-up to the ORDER line (composePackName
// ceils the pack count), which is where a buy-count belongs. The NEED half is
// decision-support and now stays fine-grained for every unit.

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

  // Root B: was "discrete count ceils to a whole unit (0.75 → 1, 5.5 → 6,
  // 3.75 → 4)". A count need now keeps its fraction; the ORDER line does the
  // ceiling. Half a lemon must read as half a lemon, or adding the other half
  // looks like nothing happened.
  it("a discrete count keeps its fraction on the ⅛ ladder (0.75, 5.5, 3.75)", async () => {
    assert.equal(await qtyOf(0.75, "each"), 0.75);
    assert.equal(await qtyOf(5.5, "each"), 5.5);
    assert.equal(await qtyOf(3.75, "clove"), 3.75);
  });

  // Root B: was "discrete ceil applies to the multiply→decimal path (3 cloves
  // × 1.25 = 3.75 → 4)". The multiply→decimal path is unchanged; only what
  // happens to the decimal afterwards is.
  it("the multiply→decimal path keeps its fraction (3 cloves × 1.25 = 3.75)", async () => {
    // servingsOverride 5 over a default of 4 → multiplier 1.25 → 3 × 1.25 = 3.75.
    assert.equal(await qtyOf(3, "clove", 4, 5), 3.75);
  });

  // Root B: was "unknown / empty units are treated as discrete and ceil to
  // whole". They now take the same ladder as every other unit.
  it("unknown / empty units take the ⅛ ladder like everything else", async () => {
    assert.equal(await qtyOf(2.1, "sprig"), 2.125); // 0.1 → ⅛
    assert.equal(await qtyOf(1.2, ""), 1.25); // 0.2 → ¼
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

  // WS9 BUG-182 — THIS TEST WAS INVERTED, NOT FIXED. As written it asserted
  // that every entry in STAPLE_VARIANT_TO_BASE inherits its base's staple flag,
  // and it was a correct test of the code as shipped: it passed. It changed
  // because the RULING changed, not because it was wrong.
  //
  // Hans's rule is now explicit membership: a staple flag is held in an
  // ingredient's own right or not at all, never inherited through a name fold.
  // So the list below splits in two, and both halves are hand-written literals —
  // nothing here reads UNIVERSAL_STAPLES or STAPLE_VARIANT_TO_BASE.
  it("named variants that ARE staples in their own right still render greyed", async () => {
    // Present in UNIVERSAL_STAPLES by name. `kosher salt` is the load-bearing
    // one: 3,116 dish references, and PRD §2.2 + §12.7 [LOCKED] require it to
    // render greyed rather than land on the buy-list.
    for (const v of [
      "salt",
      "kosher salt",
      "black pepper",
      "ground black pepper",
      "freshly ground black pepper",
      "olive oil",
      "extra-virgin olive oil",
      "extra virgin olive oil",
    ]) {
      assert.equal(await stapleFlag(v), true, `${v} should be flagged a universal staple`);
    }
  });

  it("variants that are NOT staples in their own right no longer inherit one", async () => {
    // The BUG-182 complaint and its neighbours. Each of these folds to a staple
    // under STAPLE_VARIANT_TO_BASE and used to be flagged because of it. None is
    // in UNIVERSAL_STAPLES, so none is a staple now — no judgement about what
    // counts as "specialty" was needed to get here.
    for (const v of [
      "flaky sea salt", // Hans added this by hand; he does not own it
      "flaky salt",
      "sea salt",
      "table salt",
      "coarse sea salt",
      "fine sea salt",
      "fine salt",
      "black peppercorns", // whole, not ground — distinct product (BUG-168)
      "cracked black pepper",
      "cracked pepper",
      "ground pepper",
      "light olive oil",
      "virgin olive oil",
      "evoo",
    ]) {
      assert.equal(await stapleFlag(v), false, `${v} must NOT inherit a staple flag`);
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
    // Root B: the lemon assertion was 6 (5.5 ceiled as a discrete count). The
    // need now keeps its half — 5.5 is already on the ⅛ ladder, so it passes
    // through untouched. Nothing else in this test moved: the point of the
    // test is the item SET and grouping, which are unchanged.
    assert.equal(findItem(out, "lemon")!.quantity, 5.5); // 5.5 stays 5.5
    assert.ok(Math.abs(findItem(out, "flour")!.quantity - 1.5) < 1e-9); // 1.43 → 1½
    const salt = findItem(out, "kosher salt")!;
    assert.equal(salt.isUniversalStaple, true); // greyed, not buyable
    assert.equal(salt.canonicalName, "kosher salt"); // NOT mutated to "salt"
    assert.equal(salt.displayName, "Kosher salt"); // user still sees the variant
  });
});

// ── WS9 BUG-096 — alias resolution through consolidatePlanIngredients ────────
//
// resolveOverrideIngredients (groceryList.ts:234) is one of the three grocery
// name->id paths that fail SILENTLY: a miss yields ingredient:null, the line
// loses its pack size / conversion / store section, and it buckets under the
// raw name instead of the survivor's. 80 of 1,292 live grocery rows already
// carry a null ingredientId, so a fresh batch of them is invisible.
//
// recipeOverride ingredient names are FREE TEXT the user typed, which makes
// this the path most likely to name a form the 81-pair merge deleted.
//
// Asserted through consolidatePlanIngredients, NOT against the helper: a test
// that called lookupIngredientByName directly would stay green even if this
// call site stopped using it.

describe("consolidatePlanIngredients — BUG-096 alias resolution", () => {
  it("an override naming a MERGED-AWAY ingredient resolves to the survivor", async () => {
    const prisma = makePrisma(
      {
        items: [
          {
            id: "i1",
            recipeOverrideJson: {
              dishes: [{ ingredients: [{ name: "Roma tomato", quantity: 5, unit: "each" }] }],
            },
            dishes: [
              {
                id: "d1",
                title: "Salad",
                servingsDefault: 4,
                ingredients: [
                  { name: "Roma tomatoes", quantity: 2, unit: "each", category: "Produce" },
                ],
              },
            ],
          },
        ],
      },
      // POST-MERGE catalog: only the survivor row exists.
      [{ canonicalName: "roma tomatoes", id: "ing-survivor", displayName: "Roma tomatoes" }],
      { "roma tomato": "roma tomatoes" },
    );
    const out = await consolidatePlanIngredients({
      prisma,
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const line = out.find((i) => i.ingredientId === "ing-survivor");
    assert.ok(
      line,
      `the override must resolve to the survivor, not a null FK. got: ${JSON.stringify(
        out.map((i) => ({ n: i.canonicalName, id: i.ingredientId })),
      )}`,
    );
    assert.equal(line.quantity, 5, "override quantity wins");
    assert.ok(
      !out.some((i) => i.ingredientId === null),
      "no line may fall back to a null ingredientId",
    );
  });

  it("an override naming something genuinely unknown STILL gets a null FK", async () => {
    // The alias step is additive. It must not turn a real miss into a hit.
    const prisma = makePrisma(
      {
        items: [
          {
            id: "i1",
            recipeOverrideJson: {
              dishes: [{ ingredients: [{ name: "Dragonfruit", quantity: 1, unit: "each" }] }],
            },
            dishes: [
              {
                id: "d1",
                title: "Salad",
                servingsDefault: 4,
                ingredients: [
                  { name: "Roma tomatoes", quantity: 2, unit: "each", category: "Produce" },
                ],
              },
            ],
          },
        ],
      },
      [{ canonicalName: "roma tomatoes", id: "ing-survivor", displayName: "Roma tomatoes" }],
      { "roma tomato": "roma tomatoes" },
    );
    const out = await consolidatePlanIngredients({
      prisma,
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const saffron = findItem(out, "dragonfruit");
    assert.ok(saffron, "the unknown ingredient is still bucketed under its own name");
    assert.equal(saffron.ingredientId, null);
  });
});

// ── BUG-164 — the synthetic recurring bucket is keyed by the unit it carries ──
//
// The bucket map is keyed (normalizedCanonical, unit) everywhere, and that same
// string is the provenance join key at persist (bucketKeyOf). BUG-025-3 gave the
// synthetic recurring entry a real purchase unit — bananas → 1 bunch, egg →
// 1 dozen — while leaving its key hard-wired to "each", so the map held rows
// filed under a unit they do not have.
//
// SCOPE: this pins the mechanical key/unit agreement only. Whether a recurring
// "milk" SHOULD absorb a plan's "whole milk 3 tbsp" need is D-WS9-188 and is
// unruled; the match-or-append name test is deliberately unchanged.
// ⚠️ HONESTY NOTE — these are REGRESSION guards, not a proof of the BUG-164
// change. The key/unit fix is BEHAVIOUR-NEUTRAL and cannot be turned red from
// outside this module, by construction: `buckets.has(norm|"each")` is only
// reached after the unit-agnostic name loop above found no match, and any
// bucket sitting at `norm|<anything>` necessarily has a canonicalName that
// normalizes to `norm`, so that loop would have matched it and `continue`d.
// Reverting the fix and re-running the consolidator over all 7 live plans
// produced byte-identical output for all 482 rows.
//
// An earlier version of this block asserted
//   bucketKeyOf(row.canonicalName, row.unit) === "bananas|bunch"
// which is a TAUTOLOGY — it recomputes the key from the row's own fields and
// stays green with the fix reverted. It is removed rather than left to look
// like coverage it never had. What follows pins the surrounding behaviour the
// fix must not disturb.
describe("consolidatePlanIngredients — BUG-164 recurring bucket key", () => {
  it("files the synthetic entry under a key that agrees with its unit", async () => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({ items: [], recurringItems: ["bananas"] }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const bananas = findItem(out, "bananas")!;
    // The purchase-default table yields "1 bunch" for bananas — an independent
    // literal, not read back off the row.
    assert.equal(bananas.unit, "bunch");
    assert.equal(bananas.quantity, 1);
    // The key the map used is not observable from out here; see the note above.
    assert.equal(bucketKeyOf("bananas", "bunch"), "bananas|bunch");
  });

  it("still dedupes two spellings of the same recurring item to ONE row", async () => {
    // The dedup that the key guards must survive the key changing.
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({ items: [], recurringItems: ["bananas", "Bananas", " bananas "] }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const all = out.filter((i) => i.canonicalName === "bananas");
    assert.equal(all.length, 1, "three spellings, one row");
    assert.equal(all[0].isRecurringItem, true);
  });

  it("a recurring item with no purchase default still keys and renders as 'each'", async () => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({ items: [], recurringItems: ["paper towels"] }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });
    const towels = findItem(out, "paper towels")!;
    assert.equal(towels.unit, "each");
    assert.equal(
      bucketKeyOf(towels.canonicalName, towels.unit),
      "paper towels|each",
    );
  });
});

// ── WS9 BUG-169 — water is never ordered ──────────────────────────────────
//
// Hans: "we shouldn't tell someone to order water. I can't think of a need to
// order water for groceries for a meal."
//
// The June 2026 attempt (WS7-5d Block 5) added "water" to UNIVERSAL_STAPLES,
// which dims a row but still emits one. BUG-125's order line then printed
// "1 bottle (16.9 oz)" beside it — a ~7.6x under-order against the observed
// 4-quart need, though that half is moot once the row is gone.
//
// The rule is EXACT-STRING. The catalog holds 17 rows whose canonicalName
// contains "water" and a substring rule gets 5 of them wrong, so the
// false-positive tests below matter more than the positive one.
describe("consolidatePlanIngredients — BUG-169 never-order water", () => {
  function planWith(ings: IngStub[]): PlanStub {
    return {
      items: [
        {
          id: "i1",
          dishes: [
            { id: "d1", title: "Pasta", servingsDefault: 4, ingredients: ings },
          ],
        },
      ],
    };
  }

  it("drops a recipe's water entirely — no row, not a dimmed one", async () => {
    const out = await consolidatePlanIngredients({
      prisma: makePrisma(
        planWith([
          { name: "water", quantity: 4, unit: "quart", category: "Pantry" },
          { name: "spaghetti", quantity: 1, unit: "lb", category: "Pantry" },
        ]),
      ),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });

    assert.equal(findItem(out, "water"), undefined, "water must not be a row");
    // The row is GONE, not merely flagged — a staple is still a line on the list.
    assert.ok(
      !out.some((i) => i.isUniversalStaple && i.canonicalName === "water"),
      "water must not survive as a dimmed staple either",
    );
    // The rest of the dish is untouched.
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "spaghetti");
  });

  it("drops the recipe-water variants too, including warm water", async () => {
    // "warm water" is its OWN catalog row and was never staple-flagged, so
    // before this fix it rendered as a fully buyable line with no dimming —
    // worse than the row that prompted the bug.
    const variants = [
      "warm water",
      "cold water",
      "ice water",
      "ice-cold water",
      "boiling water",
      "pasta cooking water",
      "reserved pasta cooking water",
    ];
    const out = await consolidatePlanIngredients({
      prisma: makePrisma(
        planWith([
          ...variants.map((name) => ({
            name,
            quantity: 1,
            unit: "cup",
            category: "Pantry",
          })),
          { name: "spaghetti", quantity: 1, unit: "lb", category: "Pantry" },
        ]),
      ),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });

    for (const v of variants) {
      assert.equal(findItem(out, v), undefined, `${v} must not be a row`);
    }
    assert.equal(out.length, 1, "only the spaghetti survives");
  });

  it("KEEPS water-named products a shopper actually buys", async () => {
    // The false-positive guard, and the reason the rule is exact-string. A
    // substring match on "water" would silently delete all three of these.
    const keep = ["rose water", "kewra water", "cold sparkling water"];
    const out = await consolidatePlanIngredients({
      prisma: makePrisma(
        planWith(
          keep.map((name) => ({
            name,
            quantity: 1,
            unit: "cup",
            category: "Pantry",
          })),
        ),
      ),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });

    assert.equal(out.length, 3);
    for (const k of keep) {
      assert.ok(findItem(out, k), `${k} is purchasable and must survive`);
    }
  });

  it("KEEPS foods that merely contain the word", async () => {
    const keep = [
      "watercress",
      "seedless watermelon",
      "canned tuna in water",
      "solid white albacore tuna in water",
    ];
    const out = await consolidatePlanIngredients({
      prisma: makePrisma(
        planWith(
          keep.map((name) => ({
            name,
            quantity: 1,
            unit: "each",
            category: "Produce",
          })),
        ),
      ),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });

    assert.equal(out.length, 4);
    for (const k of keep) assert.ok(findItem(out, k), `${k} must survive`);
  });

  it("a RECURRING 'water' the user asked for is still appended", async () => {
    // Scope decision: the rule governs PLAN-DERIVED ingredients. A user who
    // types water into their recurring groceries has stated an explicit intent
    // to buy it, and silently dropping that would be a worse bug than the one
    // being fixed.
    const out = await consolidatePlanIngredients({
      prisma: makePrisma({
        items: [
          {
            id: "i1",
            dishes: [
              {
                id: "d1",
                title: "Pasta",
                servingsDefault: 4,
                ingredients: [
                  { name: "water", quantity: 4, unit: "quart", category: "Pantry" },
                ],
              },
            ],
          },
        ],
        recurringItems: ["water"],
      }),
      planId: TEST_PLAN,
      userId: TEST_USER,
    });

    const water = findItem(out, "water");
    assert.ok(water, "the user's recurring water survives");
    assert.equal(water.isRecurringItem, true);
    // ...and it is the SYNTHETIC recurring entry, not the dish's 4 quarts.
    assert.equal(water.sources.length, 0);
    assert.notEqual(water.quantity, 4);
  });
});
