// WS6 6c-4 Block A — Deterministic grocery list consolidation helper.
// Walks a MealPlanInstance, sums per-ingredient quantities (per unit),
// flags universal + user staples, applies category→section mapping, and
// folds in user recurring items. No AI calls — Block B wraps this output
// with AI for purchase-pack reconciliation, ambiguity surfacing, and
// purchase-display strings.

import type { PrismaClient, StoreSection } from "@prisma/client";

import { normalizeIngredientName } from "./groceryNormalization";
import { UNIVERSAL_STAPLES } from "./groceryStaples";

// WS7-7-A Block 1 — a single plan source contributing to a consolidated line.
// Tracked as (mealId, dishId) PAIRS (not two independent arrays) so per-row
// provenance survives losslessly into GroceryListItemSource at persist and
// Block 4 can answer "is this row's source set entirely within the unchanged
// meals?" The pair preserves which dish within which meal contributed.
export interface GrocerySource {
  mealId: string;
  dishId: string;
}

export interface ConsolidatedItem {
  ingredientId: string | null;
  canonicalName: string;
  displayName: string;
  quantity: number;
  unit: string;
  sectionKey: StoreSection;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  // WS7-7-A Block 1: deduplicated (mealId, dishId) provenance pairs. Empty for
  // synthetic recurring entries (no plan source).
  sources: GrocerySource[];
  // Block B fills these via AI reconciliation.
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  // 6c-5: prep-note + dish-title signals threaded to the AI for form
  // inference and ambiguity flagging. Null when no recipe context is
  // available (e.g. synthetic recurring entries).
  preparationNote: string | null;
  sourceDishTitle: string | null;
}

export interface ConsolidateOptions {
  prisma: PrismaClient;
  planId: string;
  userId: string;
}

export class GroceryConsolidationNotFoundError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} not found`);
    this.name = "GroceryConsolidationNotFoundError";
  }
}

export class GroceryConsolidationForbiddenError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} not owned by caller`);
    this.name = "GroceryConsolidationForbiddenError";
  }
}

// Ingredient.category → StoreSection. Unknown categories fall back to 'extras'.
// WS7-5d Block 1 Fix B: extended from 6 → 9 explicit categories so canned/
// snacks/household route deterministically instead of dropping into 'extras'
// for the Sonnet final-polish pass to reassign. 'extras' is now a genuine
// last-resort for truly uncategorized input.
const CATEGORY_TO_SECTION: Record<string, StoreSection> = {
  Produce: "produce",
  Protein: "meat_seafood",
  Dairy: "dairy_eggs",
  Pantry: "pantry",
  Bakery: "bakery_bread",
  Canned: "canned",
  Frozen: "frozen",
  Snacks: "snacks",
  Household: "household",
};

function sectionForCategory(category: string | null | undefined): StoreSection {
  if (!category) return "extras";
  return CATEGORY_TO_SECTION[category] ?? "extras";
}

// Normalized canonical names of universal staples — built once, reused across calls.
const UNIVERSAL_STAPLE_KEYS = new Set(
  UNIVERSAL_STAPLES.map((s) => normalizeIngredientName(s.canonicalName)),
);

// WS7-5d Block 4 Fix 1 — bucket key is (normalizedCanonical, unit). Prep is
// intentionally NOT part of the key. The 6c-5 decision to split rows by prep
// ("shredded chicken" vs "diced chicken") contradicted the LOCKED PRD §2.8
// rule that each unique ingredient appears once on the grocery list. For
// shopping, prep is recipe-metadata: you buy one bag of chicken regardless of
// how each recipe wants it cooked. The first-seen prep note still flows on
// ConsolidatedItem.preparationNote for downstream AI form-inference.
//
// Normalization on canonical: applied via normalizeIngredientName (lowercase
// + whitespace + leading-article) as defensive insurance against drift from
// the wizard write path. The wizard's lowercase+trim should already make
// this a no-op in practice; the extra normalization costs nothing and lets
// the bucket survive any future drift.
function bucketKeyOf(canonical: string, unit: string): string {
  return `${normalizeIngredientName(canonical)}|${unit}`;
}

const MAX_SOURCE_DISH_TITLE_LEN = 60;

// Append a distinct dish title to the running list, capping the joined
// result at MAX_SOURCE_DISH_TITLE_LEN chars. Duplicate titles within the
// same bucket are skipped so the AI sees a compact, distinct context.
function extendSourceDishTitle(
  current: string | null,
  next: string | null,
): string | null {
  if (!next) return current;
  if (!current) {
    return next.length > MAX_SOURCE_DISH_TITLE_LEN
      ? next.slice(0, MAX_SOURCE_DISH_TITLE_LEN)
      : next;
  }
  if (current.split(", ").includes(next)) return current;
  const candidate = `${current}, ${next}`;
  if (candidate.length > MAX_SOURCE_DISH_TITLE_LEN) return current;
  return candidate;
}

export async function consolidatePlanIngredients(
  opts: ConsolidateOptions,
): Promise<ConsolidatedItem[]> {
  const { prisma, planId, userId } = opts;

  const plan = await prisma.mealPlanInstance.findUnique({
    where: { id: planId },
    include: {
      items: {
        orderBy: { positionIndex: "asc" },
        include: {
          meal: {
            include: {
              dishLinks: {
                orderBy: { positionIndex: "asc" },
                include: {
                  dish: {
                    include: {
                      dishIngredients: {
                        orderBy: { positionIndex: "asc" },
                        include: { ingredient: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      user: {
        include: {
          pantryStaples: true,
          preferences: true,
        },
      },
    },
  });

  if (!plan) throw new GroceryConsolidationNotFoundError(planId);
  if (plan.userId !== userId) throw new GroceryConsolidationForbiddenError(planId);

  // Bucket: (normalizedCanonical, unit) → consolidated entry.
  const buckets = new Map<string, ConsolidatedItem>();
  // Preserve first-seen order so output is stable.
  const order: string[] = [];

  for (const item of plan.items) {
    for (const link of item.meal.dishLinks) {
      const dish = link.dish;
      const baseServings = dish.servingsDefault > 0 ? dish.servingsDefault : 1;
      const effectiveServings = item.servingsOverride ?? baseServings;
      const multiplier = effectiveServings / baseServings;

      for (const di of dish.dishIngredients) {
        const ing = di.ingredient;
        const canonical = ing?.canonicalName ?? di.id; // unique fallback if no ingredient row
        const display = ing?.displayName ?? canonical;
        const unit = di.unit ?? "";
        const prepRaw = di.preparationNote ?? null;
        const key = bucketKeyOf(canonical, unit);
        const scaledQty = di.quantity * multiplier;

        let entry = buckets.get(key);
        if (!entry) {
          entry = {
            ingredientId: ing?.id ?? null,
            canonicalName: canonical,
            displayName: display,
            quantity: 0,
            unit,
            sectionKey: sectionForCategory(ing?.category),
            isUniversalStaple: UNIVERSAL_STAPLE_KEYS.has(normalizeIngredientName(canonical)),
            isUserPantryStaple: false, // filled below from user.pantryStaples
            isRecurringItem: false, // filled below from preferences.recurringGroceryItems
            sources: [],
            purchaseUnit: ing?.purchaseUnit ?? null,
            purchaseQuantity: ing?.purchaseQuantity ?? null,
            purchaseDisplay: ing?.purchaseDisplay ?? null,
            preparationNote: prepRaw,
            sourceDishTitle: dish.title
              ? dish.title.length > MAX_SOURCE_DISH_TITLE_LEN
                ? dish.title.slice(0, MAX_SOURCE_DISH_TITLE_LEN)
                : dish.title
              : null,
          };
          buckets.set(key, entry);
          order.push(key);
        } else {
          // Extend the source-dish-title list with distinct dishes
          // contributing to this bucket so the AI sees multiple cooking
          // contexts.
          entry.sourceDishTitle = extendSourceDishTitle(
            entry.sourceDishTitle,
            dish.title ?? null,
          );
          // Block 4 Fix 1: same canonical can now arrive with different prep
          // notes (the bucket no longer splits on prep). Keep the first
          // non-null prep observed — that's still useful context for the AI
          // form-inference path, even though it doesn't surface on the
          // shopper-facing list.
          if (entry.preparationNote === null && prepRaw !== null) {
            entry.preparationNote = prepRaw;
          }
        }

        entry.quantity += scaledQty;
        // Dedup on the (mealId, dishId) PAIR — the same ingredient reached via
        // the same dish in the same meal is one source; the same dish across
        // two meal-plan slots, or two dishes in one meal, are distinct sources.
        if (
          !entry.sources.some(
            (s) => s.mealId === item.mealId && s.dishId === dish.id,
          )
        ) {
          entry.sources.push({ mealId: item.mealId, dishId: dish.id });
        }
      }
    }
  }

  // Flag user pantry staples (active only).
  const userPantryKeys = new Set(
    (plan.user?.pantryStaples ?? [])
      .filter((p) => p.isActive)
      .map((p) => normalizeIngredientName(p.ingredientName)),
  );
  if (userPantryKeys.size > 0) {
    for (const entry of buckets.values()) {
      if (userPantryKeys.has(normalizeIngredientName(entry.canonicalName))) {
        entry.isUserPantryStaple = true;
      }
    }
  }

  // Recurring items: match-or-append. Match flips the flag on an existing
  // entry; no match appends a new entry with quantity 1 / unit 'each' /
  // section 'extras' (PRD §3.5 / Phase 1 §10 default).
  const recurringRaw = plan.user?.preferences?.recurringGroceryItems ?? [];
  for (const raw of recurringRaw) {
    const norm = normalizeIngredientName(raw);
    if (!norm) continue;

    let matched = false;
    for (const entry of buckets.values()) {
      if (normalizeIngredientName(entry.canonicalName) === norm) {
        entry.isRecurringItem = true;
        matched = true;
        // Don't break — a recurring item could (rarely) match multiple
        // unit-buckets of the same canonical; flag them all.
      }
    }
    if (matched) continue;

    const key = bucketKeyOf(norm, "each");
    if (buckets.has(key)) {
      // Already added a synthetic bucket for an earlier identical recurring entry.
      const existing = buckets.get(key)!;
      existing.isRecurringItem = true;
      continue;
    }
    const synthetic: ConsolidatedItem = {
      ingredientId: null,
      canonicalName: norm,
      displayName: raw,
      quantity: 1,
      unit: "each",
      sectionKey: "extras",
      isUniversalStaple: UNIVERSAL_STAPLE_KEYS.has(norm),
      isUserPantryStaple: userPantryKeys.has(norm),
      isRecurringItem: true,
      sources: [],
      purchaseUnit: null,
      purchaseQuantity: null,
      purchaseDisplay: null,
      preparationNote: null,
      sourceDishTitle: null,
    };
    buckets.set(key, synthetic);
    order.push(key);
  }

  return order.map((k) => buckets.get(k)!).filter((x): x is ConsolidatedItem => !!x);
}
