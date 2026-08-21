// WS6 6c-4 Block A — Deterministic grocery list consolidation helper.
// Walks a MealPlanInstance, sums per-ingredient quantities (per unit),
// flags universal + user staples, applies category→section mapping, and
// folds in user recurring items. No AI calls — Block B wraps this output
// with AI for purchase-pack reconciliation, ambiguity surfacing, and
// purchase-display strings.

import { createHash } from "node:crypto";

import type { PrismaClient, StoreSection } from "@prisma/client";

import { normalizeIngredientName } from "./groceryNormalization";
import { lookupIngredientByName } from "./ingredientLookup";
import { baseStapleName, UNIVERSAL_STAPLES } from "./groceryStaples";
import { lookupConversion, lookupPurchaseDefault } from "./ingredientConversions";
import { mergeConvertibleGroups } from "./groceryMerge";
import { roundNeedQuantity } from "./needQuantity";

// WS7-7-A Block 1 — a single plan source contributing to a consolidated line.
// Tracked as (mealId, dishId) PAIRS (not two independent arrays) so per-row
// provenance survives losslessly into GroceryListItemSource at persist and
// Block 4 can answer "is this row's source set entirely within the unchanged
// meals?" The pair preserves which dish within which meal contributed.
export interface GrocerySource {
  mealId: string;
  dishId: string;
  // WS7-7-A Block 5 (Q1 change-signature) — captured per source so reconcile
  // detects an intra-meal edit on a meal that keeps its mealId. `servings` is
  // the effectiveServings (servingsOverride ?? dish.servingsDefault); the two
  // axes (servings vs ingredient set) are independent so the signature uses
  // base un-multiplied quantities. `ingredientSignature` is a stable hash of
  // this source dish's EFFECTIVE base ingredient set (override-applied).
  servings: number;
  ingredientSignature: string;
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
  // WS7-8b B2 — persisted shared conversion payload (Ingredient.conversionRef),
  // threaded through for the density-aware merge + macro grams path. Null for
  // synthetic recurring entries and rows the backfill left un-populated.
  conversionRef: unknown;
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

// WS7-8b B1 (BUG-025-2) NEED-quantity round-up (PRD §2.8 [LOCKED]) moved to
// needQuantity.ts in B2 so the AI-merge re-sweep rounds identically. See the
// final sweep at the end of consolidatePlanIngredients.

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

// WS7-7-A Block 5 — the effective (override-applied) form of one dish
// ingredient. Unifies the canonical-recipe path and the recipeOverrideJson
// "just this time" path so a single bucketing loop + one signature pass
// handle both. `ingredient` is null when no Ingredient row resolves (a
// brand-new override ingredient or a dish ingredient with no canonical row),
// in which case `canonicalFallback` is the bucket/signature canonical.
interface EffectiveDishIngredient {
  ingredient: {
    id: string;
    canonicalName: string;
    displayName: string;
    category: string;
    purchaseUnit: string | null;
    purchaseQuantity: number | null;
    purchaseDisplay: string | null;
    conversionRef: unknown;
  } | null;
  canonicalFallback: string;
  unit: string;
  quantity: number;
  preparationNote: string | null;
}

interface RecipeOverrideDishLite {
  ingredients: { name: string; quantity: number; unit: string }[];
}

// Defensive read of MealPlanItem.recipeOverrideJson (PRD §8.4.3 RecipeOverride).
// The write path validates via RecipeOverrideSchema (plans.ts), so persisted
// data is well-formed; this stays tolerant of malformed JSON (returns null →
// fall back to the live canonical recipe). Only `dishes[].ingredients[]` is
// read — the field the consolidator needs. ingredientOverrides (the freeform
// Json? sibling) is intentionally NOT read here: "just this time" persists a
// full RecipeOverride, not a delta (D-WS7-090 as-built refinement).
function parseRecipeOverrideDishes(
  json: unknown,
): RecipeOverrideDishLite[] | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const dishes = (json as { dishes?: unknown }).dishes;
  if (!Array.isArray(dishes)) return null;
  return dishes.map((d) => {
    const ings =
      d && typeof d === "object"
        ? (d as { ingredients?: unknown }).ingredients
        : undefined;
    const list: RecipeOverrideDishLite["ingredients"] = [];
    if (Array.isArray(ings)) {
      for (const ig of ings) {
        if (!ig || typeof ig !== "object") continue;
        const { name, quantity, unit } = ig as {
          name?: unknown;
          quantity?: unknown;
          unit?: unknown;
        };
        if (
          typeof name === "string" &&
          typeof quantity === "number" &&
          typeof unit === "string"
        ) {
          list.push({ name, quantity, unit });
        }
      }
    }
    return { ingredients: list };
  });
}

// Resolve a recipeOverride dish's ingredients into the effective shape,
// looking up each by normalized canonical name. A per-call cache dedupes
// repeated names across dishes. No match → ingredient:null (brand-new
// override ingredient), bucketed under its normalized name.
//
// WS9 BUG-096 — ALIAS-AWARE. A miss here bucket-splits the line under its raw
// name and drops the pack/conversion payload; the 81-pair merge deletes the
// loser rows, and recipeOverride ingredient names are free text the user typed,
// so this is the path most likely to name a merged-away form. Primary key stays
// `normalizeIngredientName` — the alias step is purely additive.
async function resolveOverrideIngredients(
  prisma: PrismaClient,
  overrideDish: RecipeOverrideDishLite,
  cache: Map<string, EffectiveDishIngredient["ingredient"]>,
): Promise<EffectiveDishIngredient[]> {
  const out: EffectiveDishIngredient[] = [];
  for (const ovr of overrideDish.ingredients) {
    const norm = normalizeIngredientName(ovr.name);
    let ingredient = cache.get(norm);
    if (ingredient === undefined) {
      const SELECT = {
        id: true,
        canonicalName: true,
        displayName: true,
        category: true,
        purchaseUnit: true,
        purchaseQuantity: true,
        purchaseDisplay: true,
        conversionRef: true,
      } as const;
      // Canonical first, with the full select — byte-for-byte the pre-BUG-096
      // query, so the hit path costs exactly what it always did.
      ingredient = await prisma.ingredient.findFirst({
        where: { canonicalName: norm },
        select: SELECT,
      });
      if (ingredient === null) {
        // Only a MISS pays for the alias hop. This is the path the merge would
        // otherwise break: the loser row is gone, so a free-text override
        // naming it would bucket with a null ingredient and lose its pack.
        const hit = await lookupIngredientByName(prisma, norm, ovr.name);
        if (hit) {
          ingredient = await prisma.ingredient.findFirst({
            where: { id: hit.id },
            select: SELECT,
          });
        }
      }
      cache.set(norm, ingredient);
    }
    out.push({
      ingredient,
      canonicalFallback: norm,
      unit: ovr.unit ?? "",
      quantity: ovr.quantity,
      preparationNote: null,
    });
  }
  return out;
}

// Q1 change-signature: stable hash of a dish's EFFECTIVE base ingredient set.
// Sorted (canonical|quantity|unit) tuples → order-independent; base quantity
// (servings captured separately on the source). Equal signature ⇒ this source's
// ingredient contribution is unchanged ⇒ reconcile may carry the row untouched.
function signatureOfEffective(effective: EffectiveDishIngredient[]): string {
  const tuples = effective
    .map((e) => {
      const canonical = normalizeIngredientName(
        e.ingredient?.canonicalName ?? e.canonicalFallback,
      );
      return `${canonical}|${e.quantity}|${e.unit}`;
    })
    .sort();
  return createHash("sha1").update(tuples.join("\n")).digest("hex");
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

  // WS7-7-A Block 5 — per-call cache: override ingredient name → Ingredient
  // row, dedup across dishes within this consolidation.
  const ingredientByName = new Map<string, EffectiveDishIngredient["ingredient"]>();

  for (const item of plan.items) {
    // recipeOverrideJson (PRD §8.4.3) replaces the meal's recipe for THIS plan
    // instance only ("just this time"). Matched to dishes by position index.
    const overrideDishes = parseRecipeOverrideDishes(item.recipeOverrideJson);
    let dishIndex = -1;
    for (const link of item.meal.dishLinks) {
      dishIndex += 1;
      const dish = link.dish;
      // WS7-8 BUG-003 — DENOMINATOR is the immutable authored anchor
      // (authoredServingsDefault ?? servingsDefault); the NUMERATOR keeps its
      // no-override fallback of the live servingsDefault. Servings unification
      // (BUG-046): a wizard-built or catalog-forked dish now has servingsDefault =
      // effectiveHousehold while the anchor stays at the authored count, so the
      // multiplier is < 1 for a small household — grocery quantities correctly
      // scale down to what that household buys (e.g. household 2 on a dish authored
      // at 4 → 0.5). The anchor-as-denominator is exactly what makes this right.
      const authoredBase =
        dish.authoredServingsDefault ?? dish.servingsDefault;
      const baseServings = authoredBase > 0 ? authoredBase : 1;
      const effectiveServings = item.servingsOverride ?? dish.servingsDefault;
      const multiplier = effectiveServings / baseServings;

      // Effective (override-applied) ingredient list for this dish. An override
      // dish at this position replaces the canonical ingredients wholesale;
      // absent an override the live canonical ingredients are used unchanged.
      const overrideDish = overrideDishes?.[dishIndex];
      const effective: EffectiveDishIngredient[] = overrideDish
        ? await resolveOverrideIngredients(prisma, overrideDish, ingredientByName)
        : dish.dishIngredients.map((di) => ({
            ingredient: di.ingredient,
            canonicalFallback: di.id, // unique fallback if no ingredient row
            unit: di.unit ?? "",
            quantity: di.quantity,
            preparationNote: di.preparationNote ?? null,
          }));

      // Q1 change-signature for this source dish — base set, servings-independent.
      const ingredientSignature = signatureOfEffective(effective);

      for (const eff of effective) {
        const ing = eff.ingredient;
        const canonical = ing?.canonicalName ?? eff.canonicalFallback;
        const display = ing?.displayName ?? canonical;
        const unit = eff.unit;
        const prepRaw = eff.preparationNote;
        const key = bucketKeyOf(canonical, unit);
        const scaledQty = eff.quantity * multiplier;

        let entry = buckets.get(key);
        if (!entry) {
          entry = {
            ingredientId: ing?.id ?? null,
            canonicalName: canonical,
            displayName: display,
            quantity: 0,
            unit,
            sectionKey: sectionForCategory(ing?.category),
            isUniversalStaple: UNIVERSAL_STAPLE_KEYS.has(
              baseStapleName(normalizeIngredientName(canonical)),
            ),
            isUserPantryStaple: false, // filled below from user.pantryStaples
            isRecurringItem: false, // filled below from preferences.recurringGroceryItems
            sources: [],
            purchaseUnit: ing?.purchaseUnit ?? null,
            purchaseQuantity: ing?.purchaseQuantity ?? null,
            purchaseDisplay: ing?.purchaseDisplay ?? null,
            conversionRef: ing?.conversionRef ?? null,
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
        // The signature is identical for every ingredient of the same dish, so
        // the first push for the pair fixes the source's change-signature.
        if (
          !entry.sources.some(
            (s) => s.mealId === item.mealId && s.dishId === dish.id,
          )
        ) {
          entry.sources.push({
            mealId: item.mealId,
            dishId: dish.id,
            servings: effectiveServings,
            ingredientSignature,
          });
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
    // WS7-8b B1 (BUG-025-3) — give the synthetic recurring entry a proper
    // purchasable representation per PRD §12.8 [LOCKED]. Consult the shared
    // purchase-pack defaults (bananas → "1 bunch", garlic → "1 head"); when
    // the item isn't in the table, fall back to the prior each/1/null shape
    // so genuinely unknown recurring items still render sanely. The bucket
    // key stays ("each") above — this only changes the entry's unit/purchase
    // representation, not grouping.
    const def = lookupPurchaseDefault(norm);
    const synthetic: ConsolidatedItem = {
      ingredientId: null,
      canonicalName: norm,
      displayName: raw,
      quantity: def ? def.purchaseQuantity : 1,
      unit: def ? def.purchaseUnit : "each",
      sectionKey: "extras",
      isUniversalStaple: UNIVERSAL_STAPLE_KEYS.has(baseStapleName(norm)),
      isUserPantryStaple: userPantryKeys.has(norm),
      isRecurringItem: true,
      sources: [],
      purchaseUnit: def ? def.purchaseUnit : null,
      purchaseQuantity: def ? def.purchaseQuantity : null,
      purchaseDisplay: def ? def.purchaseDisplay : null,
      conversionRef: lookupConversion(norm) ?? null,
      preparationNote: null,
      sourceDishTitle: null,
    };
    buckets.set(key, synthetic);
    order.push(key);
  }

  const ordered = order
    .map((k) => buckets.get(k)!)
    .filter((x): x is ConsolidatedItem => !!x);

  // WS7-8b B2 (BUG-031) — density-aware merge of same-canonical/different-unit
  // rows (parmesan oz+½cup, garlic head+clove) using the conversion table.
  // Runs on RAW (un-rounded) quantities so the merged total is rounded exactly
  // once by the sweep below (merge-then-round-once — never round the parts then
  // merge). Groups the table can't convert pass through and still reach the AI.
  const merged = mergeConvertibleGroups(ordered);

  // WS7-8b B1 (BUG-025-2) — final need-quantity round-up sweep. Once, AFTER the
  // merge, so merged totals and single-unit rows round identically. Changes only
  // displayed quantity, never the item set. Recurring entries are unaffected.
  for (const item of merged) {
    item.quantity = roundNeedQuantity(item.quantity, item.unit);
  }
  return merged;
}
