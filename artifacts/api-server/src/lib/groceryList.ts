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
// WS9 BUG-182 — baseStapleName is no longer imported here. Its two consumers in
// this file were the isUniversalStaple flag sites, and both now test explicit
// membership instead of folding. The function itself is untouched and still
// serves groupConversion (BUG-142) and groceryListAI's conservation guard.
import { isNeverOrdered, UNIVERSAL_STAPLES } from "./groceryStaples";
// [grocery] B3 — `lookupPurchaseDefault` is no longer imported here. Its one
// consumer was the synthetic recurring entry's pack, and the precedence that
// reads it (table, then the resolved row, then nothing) now lives in
// recurringItems.ts where the resolution it belongs to happens.
import {
  canonicalUnitToken,
  lookupConversion,
} from "./ingredientConversions";
import { mergeConvertibleGroups } from "./groceryMerge";
import {
  EMPTY_RELATION_INDEX,
  buildRelationIndex,
  poolComponentNeeds,
  type RelationIndex,
  type RelationRow,
} from "./ingredientRelations";
import { distinguishingTokens } from "./subsumesClasses";
import { roundNeedQuantity } from "./needQuantity";
import {
  recurringComparable,
  recurringFacetsFor,
  resolveRecurringItems,
  type RecurringFacets,
} from "./recurringItems";
import { logger } from "./logger";

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
  // ── [grocery] B1 — the PERSISTED PACK YIELD, threaded like conversionRef ──
  // `Ingredient.packYieldUnit` / `packYieldPerPack`: how much of a measured need
  // ONE PACK gives. Read together with `purchaseUnit` above (the pack noun is
  // not repeated) and layered onto the conversion by `rowConversion`. Null for
  // the ~1,738 catalog rows that need no yield and for synthetic recurring
  // entries, and null means "one whole pack per need", which over-orders and
  // never under-orders (D-WS9-182).
  packYieldUnit: string | null;
  packYieldPerPack: number | null;
  // ── [grocery] B1 — the PACK FLOOR a pooled part left behind ───────────────
  // A coHarvestable part (lemon zest, jalapeño brine, cilantro stems) adds NO
  // need to the row it pools onto — that is what "rides free" means — but it can
  // still mean one more pack. poolComponentNeeds writes the minimum here and
  // resolvePurchaseFields reads it. Null on every row no part pooled onto.
  packFloor: number | null;
  // 6c-5: prep-note + dish-title signals threaded to the AI for form
  // inference and ambiguity flagging. Null when no recipe context is
  // available (e.g. synthetic recurring entries).
  preparationNote: string | null;
  sourceDishTitle: string | null;
  // ── [grocery] B2 H3 — the varieties a folded GENERIC line still owes ───────
  //
  // Set only on a row an H3 fold absorbed a specific into. The RIDER is not
  // composed here: H3 states shares in whole units of the LINE's buy unit, and
  // the pack count that defines that unit is resolved in
  // generateFinalGroceryList. So the need travels and the arithmetic happens
  // where the pack is known.
  varietyShares?: {
    /** the distinguishing words — "red", "san marzano", "large" */
    variety: string;
    /** the specific's own need, in its own unit */
    need: number;
    unit: string;
    /** the specific's catalog display name, for H3's single-variety collapse */
    displayName: string;
  }[];
  // ── [grocery] B3 (D-WS9-284) — the two flags the recurring path adds ───────
  //
  // `skipGapFill` is ruling 2 step 3 and ruling 6 in one word: a recurring row
  // this pass APPENDED is never handed to the gap-fill. Without a pack it renders
  // its name alone (stable, free) instead of asking a model every generation; with
  // one, a gap-fill would WRITE BACK to the shared catalog, and no model-authored
  // write may reach the catalog from a recurring resolution.
  //
  // `recurringFacets` is R3's render data. It is NOT persisted (ruling 1 chose no
  // migration), so the detail read re-derives it with the same pure function.
  skipGapFill?: boolean;
  recurringFacets?: RecurringFacets;
}

export interface ConsolidateOptions {
  prisma: PrismaClient;
  planId: string;
  userId: string;
  // WS9 D-WS9-189 A2 — the relation readers, OFF BY DEFAULT.
  //
  // This is the flag. Omitting it yields EMPTY_RELATION_INDEX, whose groupKey
  // is exactly the pre-A2 expression and whose componentParents list is empty,
  // so the consolidator behaves byte-identically to before this block. The A2
  // dry run supplies a real index built from `ingredient_relations`; wiring the
  // production route to load one is a separate, ruled step.
  relations?: RelationIndex;
  // ── [grocery] B2 — THE ROWS, not just the index, and why both ─────────────
  //
  // The subsumes overlay cannot be built by the caller: H3's gate is "did a
  // recipe demand the generic", which is only known after the buckets exist. So
  // the consolidator rebuilds the index itself — and to do that it needs the
  // ROWS the caller already loaded, not the finished index.
  //
  // Omit it and there is no overlay and no subsumes reading at all: the pre-B2
  // path, byte for byte. That is the same opt-in discipline `relations` uses.
  relationRows?: RelationRow[];
  /**
   * Group keys whose H3 fold must not be made — the collapse fallback, set by a
   * caller that has already seen the shares cover the whole count.
   */
  suppressH3?: ReadonlySet<string>;
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
//
// EXPORTED (BUG-165): this key is also the provenance join key. The
// consolidator's per-line (mealId, dishId) source pairs do not fit through
// GenerateListOutputItem, so both persist sites (routes/groceryLists.ts and
// groceryReconcile.ts) re-join `consolidated` to the final items by this exact
// string. That formula used to be hand-inlined at four call sites; it is one
// exported function now so the consolidator and the join can never drift.
//
// WS9 BUG-174 — the UNIT half is canonicalized too, and only now. The name half
// has been normalized since 6c-4; the unit half stayed the raw string, so `tsp`
// and `teaspoon` — the same unit, 11,202 live dish-ingredient rows between them
// — keyed two buckets and shipped two shopping rows for one ingredient.
// canonicalUnitToken reads that equivalence out of the factor tables that
// already spell both (ingredientConversions); it adds no alias data.
//
// ⚠️ INSIDE THE KEY ONLY. The bucket's `unit` field keeps the raw first-seen
// spelling. bucketKeyOf is never persisted — no column holds it, and both join
// sites build and consume it within one request — but GroceryListItem.unit IS,
// and groceryReconcile.matchKey compares a STORED unit against a freshly
// consolidated one. Rewriting the unit here would make every stored `teaspoon`
// row reconcile as delete+add. The key changes; the data does not.
export function bucketKeyOf(canonical: string, unit: string): string {
  return `${normalizeIngredientName(canonical)}|${canonicalUnitToken(unit)}`;
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
    // [grocery] B1 — the pack yield, selected wherever conversionRef is.
    packYieldUnit: string | null;
    packYieldPerPack: number | null;
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
        packYieldUnit: true,
        packYieldPerPack: true,
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
  const { prisma, planId, userId, relations = EMPTY_RELATION_INDEX } = opts;

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
        // WS9 BUG-169 — drop never-order ingredients before they become a
        // bucket. Skipping HERE (rather than filtering a built list later) means
        // the row never exists at any downstream layer: no bucket, no sources,
        // no staple flag, no AI-subset entry, no order line. A recipe's water is
        // an instruction, not a purchase.
        if (isNeverOrdered(normalizeIngredientName(canonical))) continue;
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
            // WS9 BUG-182 — EXPLICIT MEMBERSHIP, NO INHERITANCE. The test is
            // the normalised canonical name itself; the baseStapleName fold is
            // gone from here. A staple flag is now held in an ingredient's own
            // right or not at all. See UNIVERSAL_STAPLES for why.
            isUniversalStaple: UNIVERSAL_STAPLE_KEYS.has(
              normalizeIngredientName(canonical),
            ),
            isUserPantryStaple: false, // filled below from user.pantryStaples
            isRecurringItem: false, // filled below from preferences.recurringGroceryItems
            sources: [],
            purchaseUnit: ing?.purchaseUnit ?? null,
            purchaseQuantity: ing?.purchaseQuantity ?? null,
            purchaseDisplay: ing?.purchaseDisplay ?? null,
            conversionRef: ing?.conversionRef ?? null,
            // [grocery] B1 — the pack yield rides with the pack it is a yield of.
            packYieldUnit: ing?.packYieldUnit ?? null,
            packYieldPerPack: ing?.packYieldPerPack ?? null,
            packFloor: null,
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

  // ── [grocery] B3 (D-WS9-284) — RECURRING ITEMS MEET THE PLAN ──────────────
  //
  // The old rule was `normalizeIngredientName(entry.canonicalName) === norm` —
  // an exact name equality against catalog canonicals — and there is no catalog
  // row called `milk`. That one line is why 0 of 96 recurring rows across the 20
  // census lists carried a plan source, why every list read `Whole milk` beside
  // `milk`, and why 74 of those 96 rows paid a Haiku gap-fill on EVERY
  // generation for an answer nothing stored (write-back skips a null
  // ingredientId).
  //
  // The new rule resolves the free text FIRST (recurringItems.ts, on the shared
  // alias-aware lookup) and then matches on IDENTITY: `ingredientId`, falling
  // back to `relations.groupKey` — the same key the merge and partitionForAI
  // already use, so all three agree about what one food is by construction.
  //
  // D-WS9-230: forward-only. Nothing is backfilled and nothing is persisted per
  // user (D-WS9-284 ruling 1), so this runs at every generation.
  const recurringRaw = plan.user?.preferences?.recurringGroceryItems ?? [];
  const recurringResolutions = recurringRaw.length > 0
    ? await resolveRecurringItems(prisma, recurringRaw)
    : [];
  // The rows THIS pass appended, as opposed to plan rows it merely flagged.
  // They are held out of `demanded` below — see the note there.
  const recurringAppended = new Set<ConsolidatedItem>();

  for (const res of recurringResolutions) {
    const { norm } = res;

    // ── (a) does the plan already demand this food? ────────────────────────
    //
    // Identity first, then the group key. The loop does not break: one food can
    // occupy several unit-buckets, and every one of them is the same food.
    const met: ConsolidatedItem[] = [];
    for (const entry of buckets.values()) {
      const sameId =
        res.ingredientId !== null && entry.ingredientId === res.ingredientId;
      const sameKey =
        res.canonicalName !== null &&
        relations.groupKey(entry.canonicalName) ===
          relations.groupKey(res.canonicalName);
      const sameName =
        res.canonicalName === null &&
        normalizeIngredientName(entry.canonicalName) === norm;
      if (sameId || sameKey || sameName) met.push(entry);
    }

    if (met.length > 0) {
      for (const entry of met) {
        entry.isRecurringItem = true;
        // ── R3, D-WS9-188 ──────────────────────────────────────────────────
        //
        // SAME COUNT UNIT → one line, summed; the split rides in the facets, so
        // the line can say "5 lemons — 2 recurring + 3 for meals".
        //
        // ⛔ ANYTHING ELSE ADDS NOTHING TO THE NEED. The recurring quantity
        // becomes the DEFAULT PURCHASE (which is what `purchaseQuantity`
        // already is) and the meal need stays exactly what the recipes asked
        // for. The app never decides a gallon covers two cups — and it never
        // buys two gallons either.
        const qty = res.purchase?.purchaseQuantity ?? null;
        if (qty !== null && recurringComparable(res.purchase?.purchaseUnit, entry.unit)) {
          entry.quantity += qty;
        } else if (res.purchase) {
          // The default purchase, stated on the row the recipes already own.
          entry.purchaseUnit = res.purchase.purchaseUnit;
          entry.purchaseQuantity = res.purchase.purchaseQuantity;
          entry.purchaseDisplay = res.purchase.purchaseDisplay;
        }
      }
      continue;
    }

    // ── (b) the plan demands none of it — one line, with an identity ───────
    //
    // BUG-164 — key the bucket by the unit it ACTUALLY carries. The map is
    // keyed (normalizedCanonical, unit) everywhere else and this string is also
    // the provenance join key, so a key that disagrees with its row is a latent
    // mis-join, not untidiness.
    const unit = res.purchase?.purchaseUnit ?? "each";
    const name = res.canonicalName ?? norm;
    const key = bucketKeyOf(name, unit);
    const existing = buckets.get(key);
    if (existing) {
      // An earlier recurring text already produced this bucket, or the plan
      // holds it under a name the identity test above did not reach.
      existing.isRecurringItem = true;
      continue;
    }
    const appended: ConsolidatedItem = {
      ingredientId: res.ingredientId,
      canonicalName: name,
      // The CATALOG's name when there is one — "whole milk", not "Milk". The
      // user's text is what they typed, not what the shop calls the food.
      displayName: res.displayName ?? res.text,
      quantity: res.purchase?.purchaseQuantity ?? 1,
      unit,
      // Ruling 5 — household is a CATEGORY, never a lookup failure. Coffee
      // resolves to nothing and is still a food; it stays in the Instacart
      // payload and lands in `pantry`. Everything else keeps `extras`.
      sectionKey: sectionForCategory(res.household ? "Household" : res.category),
      // WS9 BUG-182 — explicit membership, no inheritance.
      isUniversalStaple: UNIVERSAL_STAPLE_KEYS.has(normalizeIngredientName(name)),
      isUserPantryStaple: userPantryKeys.has(normalizeIngredientName(name)),
      isRecurringItem: true,
      sources: [],
      purchaseUnit: res.purchase?.purchaseUnit ?? null,
      purchaseQuantity: res.purchase?.purchaseQuantity ?? null,
      purchaseDisplay: res.purchase?.purchaseDisplay ?? null,
      conversionRef: lookupConversion(name) ?? lookupConversion(norm) ?? null,
      packYieldUnit: null,
      packYieldPerPack: null,
      packFloor: null,
      preparationNote: null,
      sourceDishTitle: null,
      // ── RULING 2, STEP 3: "no pack, and no AI call." ──────────────────────
      //
      // This flag is the whole of it. A recurring row the table and the catalog
      // both miss renders its name with no pack — stable, and free — instead of
      // being handed to Haiku, which is what produced `paper towels` as
      // "(6-pack)" 49 times and "(6 rolls)" 7 across the same corpus.
      //
      // It also enforces ruling 6 from the other side: a RESOLVED recurring row
      // carries a real ingredientId, so a gap-fill on it would WRITE BACK to the
      // shared catalog, and no model-authored write may reach the catalog from a
      // recurring resolution.
      skipGapFill: true,
    };
    buckets.set(key, appended);
    order.push(key);
    recurringAppended.add(appended);
  }

  const ordered = order
    .map((k) => buckets.get(k)!)
    .filter((x): x is ConsolidatedItem => !!x);

  // ── [grocery] B2 R1 (BUG-210) — THE IDENTITY GUARD ────────────────────────
  //
  // R1 said two rows carrying the same `ingredientId` are one food and must fold.
  // Part A measured the population and it is EMPTY, structurally: the bucket
  // above takes its name from the ingredient it resolved (`canonical =
  // ing?.canonicalName`), so one ingredientId can only ever produce one
  // canonicalName, and two buckets carrying it differ by UNIT alone — which
  // `relations.groupKey` already groups. 0 collisions across 1,044 corpus rows at
  // both stages.
  //
  // So this is a GUARD, not a fix. It moves nothing today and it is here because
  // the invariant is worth stating where it can be checked: if a future change
  // ever lets one ingredientId carry two names, the merge would ship two lines
  // for one food and nothing would say so.
  const namesById = new Map<string, Set<string>>();
  for (const it of ordered) {
    if (!it.ingredientId) continue; // synthetic recurring entries have none, by design
    let s = namesById.get(it.ingredientId);
    if (!s) { s = new Set(); namesById.set(it.ingredientId, s); }
    s.add(normalizeIngredientName(it.canonicalName));
  }
  for (const [id, names] of namesById) {
    if (names.size < 2) continue;
    logger.warn(
      { event: "grocery_identity_split", ingredientId: id, names: [...names] },
      "one ingredientId produced two canonical names — R1's invariant is broken",
    );
  }

  // ── [grocery] B2 — THE SUBSUMES OVERLAY, BUILT HERE AND NOWHERE ELSE ──────
  //
  // H3 folds a specific onto its generic only when A RECIPE DEMANDED THE GENERIC,
  // which is a property of this plan and not of the relation table. So the index
  // cannot be built once by the caller: it is rebuilt here, over the same rows,
  // with the demanded set the buckets just produced.
  //
  // ⚠️ `demanded` IS THE RAW BUCKET NAMES, PLUS THEIR GROUP KEYS. "A meal that
  // says bell peppers" is a DishIngredient, which is a bucket — so the buckets
  // are the honest answer to what the recipes asked for. Part A2's dry run used
  // the POST-merge names instead, which is a subset and made the answer depend on
  // which spelling won a synonym contest; a plan whose only parsley row is
  // `fresh parsley` asks for parsley either way.
  //
  // A caller that supplied no relation index gets no overlay and no subsumes
  // reading at all — the pre-B2 path, unchanged.
  //
  // ⚠️ [grocery] B3 — A RECURRING APPEND IS NOT A RECIPE DEMAND. H3's gate is
  // "did a RECIPE ask for the generic", and a row this pass appended because the
  // user types "chicken broth" into their weekly list is not a recipe asking for
  // anything. Before B3 the leak was unreachable in practice — a synthetic
  // carried the user's raw text (`milk`), which matches no generic — but
  // resolution gives these rows real catalog names, so it becomes reachable.
  // Rows the plan itself demanded and this pass merely FLAGGED as recurring stay
  // in: those are recipe demands that happen also to be recurring.
  const demanded = new Set<string>();
  for (const it of ordered) {
    if (recurringAppended.has(it)) continue;
    const n = normalizeIngredientName(it.canonicalName);
    demanded.add(n);
    demanded.add(relations.groupKey(it.canonicalName));
  }
  const packUnitByName = new Map<string, string | null>();
  for (const it of ordered) {
    packUnitByName.set(normalizeIngredientName(it.canonicalName), it.purchaseUnit);
  }
  const effective = opts.relationRows
    ? buildRelationIndex(opts.relationRows, {
        subsumes: {
          demanded,
          // H3 requires the GENERIC to be demanded, so its bucket is always
          // present and its pack unit always known. No second lookup needed.
          packUnitOf: (name) => packUnitByName.get(normalizeIngredientName(name)) ?? null,
          suppress: opts.suppressH3,
        },
      })
    : relations;

  // WS9 D-WS9-189 A2 — COMPONENT POOLING, between the recurring match-or-append
  // above and the merge below. Placed here and not inside mergeConvertibleGroups
  // for a STRUCTURAL reason: mergeGroup's contract is CONSERVATION (BUG-142
  // asserts it), and pooling deliberately violates conservation — one lemon
  // satisfying both a juice need and a zest need destroys quantity by design.
  //
  // No-op unless `relations` was supplied: EMPTY_RELATION_INDEX carries no
  // component parents and the pass returns its input.
  const pooled = poolComponentNeeds(ordered, effective);

  // WS7-8b B2 (BUG-031) — density-aware merge of same-canonical/different-unit
  // rows (parmesan oz+½cup, garlic head+clove) using the conversion table.
  // Runs on RAW (un-rounded) quantities so the merged total is rounded exactly
  // once by the sweep below (merge-then-round-once — never round the parts then
  // merge). A group the table can't convert passes through unmerged (and, see
  // the note at that branch, is NOT routed to the AI).
  const merged = mergeConvertibleGroups(pooled.items, effective);

  // A pin target need NOT be on the list — H2 renames `chicken thighs` to
  // `bone-in chicken thighs` on a plan that carries no bone-in row — so its
  // display name is read from the catalog rather than from a member. One query,
  // and only when there is a pin to resolve.
  const pinTargets = new Set<string>();
  for (const item of merged) {
    const pin = effective.pinnedNameByKey.get(effective.groupKey(item.canonicalName));
    if (pin && pin !== normalizeIngredientName(item.canonicalName)) pinTargets.add(pin);
  }
  const catalogNameByCanonical = new Map<string, string>();
  if (pinTargets.size > 0) {
    const rows = await prisma.ingredient.findMany({
      where: { canonicalName: { in: [...pinTargets] } },
      select: { canonicalName: true, displayName: true },
    });
    for (const r of rows) catalogNameByCanonical.set(r.canonicalName, r.displayName);
  }

  // ── [grocery] B2 H2 + H3 — THE NAME THE FOLDED LINE TAKES, AND WHAT IT OWES ─
  //
  // The merge picked the surviving row by `pickRepresentative` — the shortest
  // name among the members PRESENT — which is right for a synonym fold and wrong
  // for these two. H2 names the line after the DEFAULT; H3 names it after the
  // GENERIC and R5's one hard rule is that it is never renamed to the specific.
  // Both come off the index's pin.
  //
  // The SHARES are computed here, where the members are still known, and are
  // rendered later — the rider states whole units of the LINE's buy unit, and the
  // pack count that defines that unit is only resolved in generateFinalGroceryList.
  for (const item of merged) {
    const key = effective.groupKey(item.canonicalName);
    const pin = effective.pinnedNameByKey.get(key);
    if (pin && pin !== normalizeIngredientName(item.canonicalName)) {
      const named = catalogNameByCanonical.get(pin);
      if (named) item.displayName = named;
    }
    const varieties = effective.varietiesByKey.get(key);
    if (!varieties || varieties.length === 0) continue;
    // Only the varieties THIS plan asked for, and only when the fold actually
    // absorbed something: a lone specific has nothing to reconcile, and
    // "1 yellow onion, at least 1 yellow" is a tautology on a line that never
    // merged (D-WS9-217 from the other side).
    const membersHere = ordered.filter(
      (o) => effective.groupKey(o.canonicalName) === key,
    );
    if (membersHere.length < 2) continue;
    item.varietyShares = varieties
      .filter((v) =>
        membersHere.some((o) => distinguishingTokens(pin ?? key, o.canonicalName).join(" ") === v),
      )
      .map((v) => {
        const row = membersHere.find(
          (o) => distinguishingTokens(pin ?? key, o.canonicalName).join(" ") === v,
        );
        return {
          variety: v,
          need: row?.quantity ?? 0,
          unit: row?.unit ?? item.unit,
          displayName: row?.displayName ?? v,
        };
      });
    if (item.varietyShares.length === 0) delete item.varietyShares;
  }

  // WS7-8b B1 (BUG-025-2) — final need-quantity round-up sweep. Once, AFTER the
  // merge, so merged totals and single-unit rows round identically. Changes only
  // displayed quantity, never the item set. Recurring entries are unaffected.
  for (const item of merged) {
    item.quantity = roundNeedQuantity(item.quantity, item.unit);
  }

  // ── [grocery] B3 (D-WS9-284) — R3's render fields, computed LAST ──────────
  //
  // After the merge and after the rounding sweep, because `mealQuantity` on a
  // summed line is `quantity - recurringQuantity` and `quantity` is not final
  // until both have run. The detail read re-derives these from the persisted row
  // with the same pure function (ruling 1: nothing is persisted), so computing
  // them anywhere earlier would make the two disagree by exactly a rounding.
  if (recurringResolutions.length > 0) {
    for (const item of merged) {
      if (!item.isRecurringItem) continue;
      const facets = recurringFacetsFor(
        {
          ingredientId: item.ingredientId,
          canonicalName: item.canonicalName,
          unit: item.unit,
          quantity: item.quantity,
          hasPlanSources: item.sources.length > 0,
        },
        recurringResolutions,
      );
      if (facets) item.recurringFacets = facets;
    }
  }
  return merged;
}
