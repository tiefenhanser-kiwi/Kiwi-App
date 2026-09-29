// [grocery] B3 (D-WS9-284) — the recurring-item resolver and R3's render fields.
//
// WHY THIS EXISTS. A recurring grocery item is free text on
// `UserPreferences.recurringGroceryItems` — no quantity, no unit, no row. Until
// this module it was matched against the catalog by exact name equality
// (`normalizeIngredientName(entry.canonicalName) === norm`, groceryList.ts), and
// there is no catalog row called `milk`, `bread`, `eggs` or `limes`. So 0 of 96
// recurring rows across the 20 census lists ever met the plan's row for the same
// food: every list carried `Whole milk` beside `milk`, `Large eggs` beside
// `eggs`, and a synthetic whose pack a model re-invented on every generation.
//
// THE RESOLVER IS NOT NEW. It is `lookupIngredientsByName` — canonical first,
// then the `IngredientAlias` synonym index — and the alias table ALREADY carries
// D-WS9-228's grade rule for most of the vocabulary (`milk` → `whole milk`,
// `bread` → `sandwich bread`, `lemons` → `lemon`, `limes` → `lime`). This module
// adds no map for those.
//
// ⚠️ NOT `resolveIngredients`. That one UPSERTS, and pointing it at this
// vocabulary would mint `paper towels`, `toilet paper` and `pet treats` as
// catalog Ingredient rows. `lookupIngredientByName` never creates and never
// throws, which is exactly the contract this path needs.
//
// D-WS9-230: forward-only. Nothing is backfilled; a recurring item is resolved
// at the NEXT list generation. D-WS9-284 ruling 1: nothing is persisted per
// user, so the resolution runs at every generation and is re-derived at read.

import type { Prisma, PrismaClient } from "@prisma/client";

import { normalizeIngredientName } from "./groceryNormalization";
import { lookupIngredientsByName } from "./ingredientLookup";
import {
  canonicalUnitToken,
  isCountUnit,
  lookupPurchaseDefault,
  type IngredientPurchase,
} from "./ingredientConversions";
import { inferCategory } from "./ingredientResolve";

type Db = PrismaClient | Prisma.TransactionClient;

// ── D-WS9-284 ruling 4 — THE RECURRING GRADE MAP, AND WHY IT IS THIS SMALL ──
//
// D-WS9-228, verbatim: "IT IS AN ALIAS-PRECEDENCE CHANGE, NOT A FOLD, AND THE
// `distinct` EDGE STANDS … This ruling changes only WHICH ROW THE RECURRING
// STRING RESOLVES TO. It does NOT authorise deleting the `distinct` edge,
// folding the two rows, or a subsumes pass on graded foods."
//
// Eggs are the one case the alias table cannot express. Two catalog rows exist —
// `egg` (39 recipe rows) and `large eggs` (228) — and the alias table holds BOTH
// `egg → large eggs` and `eggs → egg`. Canonical beats alias unconditionally
// (the ruled precedence in ingredientLookup.ts), so free text `egg` lands on the
// 39-row minority and `eggs` lands there too. The shadowed `egg → large eggs`
// alias is left exactly where it is: removing it would be a catalog decision
// this block was told not to make.
//
// THE ADMISSION TEST FOR A NEW ENTRY HERE IS D-WS9-228'S, BOTH HALVES:
//   1. the food is sold in NAMED GRADES (large / extra-large eggs), and
//   2. the recipe corpus ASSUMES ONE of them.
// A food that fails either half does not belong here. This is not a
// "standard size for everything" table, and it must not become one — that is
// what H2 defaults are for, and D-WS9-228 explicitly declined to authorise a
// subsumes pass on graded foods.
//
// It applies to RECURRING TEXT ONLY, after the lookup. A plan's own `egg`
// demand — 39 recipes — keeps its own row and its own line.
export const RECURRING_GRADE_MAP: Record<string, string> = {
  egg: "large eggs",
  eggs: "large eggs",
};

/** One distinct recurring text, resolved. */
export interface RecurringResolution {
  /** the user's raw text, as typed */
  text: string;
  /** normalizeIngredientName(text) — the identity key for a synthetic */
  norm: string;
  /** the catalog row, when one was found. null → this item names no food row. */
  ingredientId: string | null;
  canonicalName: string | null;
  displayName: string | null;
  /** the store-section input: the catalog row's category, else inferCategory(text). */
  category: string;
  matchedVia: "canonical" | "alias" | "grade" | null;
  /**
   * D-WS9-284 ruling 2 — THE RECURRING DEFAULT QUANTITY, AND ITS PRECEDENCE.
   *
   *   1. the purchase-defaults table entry for the recurring TEXT
   *      (`lookupPurchaseDefault`, PRD §12.8's "proper purchasable
   *      representation"), then
   *   2. the resolved row's catalog pack, then
   *   3. null — no pack, and NO AI CALL.
   *
   * The table stays first on purpose, and bananas is why: the catalog row is
   * `1 each` because D-WS9-221 says a recipe need buys the smallest normal size,
   * so a recipe wanting 2 bananas buys 2. A person who "always gets bananas"
   * means a bunch. Two different questions, two different answers, and the
   * recurring one is the table's.
   */
  purchase: IngredientPurchase | null;
  /**
   * D-WS9-284 ruling 5 — household is `inferCategory(text) === "Household"`,
   * NEVER "did not resolve". Coffee resolves to no catalog row and is a food; it
   * stays in the Instacart food payload. Paper towels do not.
   */
  household: boolean;
}

/**
 * R3's render fields (D-WS9-188). The server computes them; block C renders
 * them. Nothing here is persisted — ruling 1 chose option (c) — so both the
 * generation path and the detail read call `recurringFacetsFor`.
 */
export interface RecurringFacets {
  /** what the recurring item buys on its own, in its own unit */
  recurringQuantity: number | null;
  recurringUnit: string | null;
  /** what this plan's recipes need. null when the plan needs none of it. */
  mealQuantity: number | null;
  mealUnit: string | null;
  /**
   * R3's branch. true → one line, summed, and the split is
   * `recurringQuantity + mealQuantity`. false → the recurring quantity is the
   * DEFAULT PURCHASE and the meal need is shown beside it.
   *
   * ⚠️ COMPARABLE IS NOT "CONVERTIBLE". A gallon and two cups convert perfectly
   * and Hans put that exact pair in the incomparable branch: "we usually get a
   * gallon of milk … we need 2 cups for cooking", with the standing ⛔ that the
   * app never decides a gallon covers two cups. So the test is that BOTH sides
   * are the SAME COUNT UNIT — five lemons and three lemons are five and three of
   * one thing. Anything measured takes the other branch. Reading this as "same
   * dimension" would sum `1 gallon` into `½ cup`, which is the consumption
   * modelling the ruling forbids.
   *
   * Dozen↔each is deliberately NOT converted either (ruling 4): a recurring
   * `1 dozen` against a recipe's `2 each` is two units, so it renders
   * display-both.
   */
  comparable: boolean;
  household: boolean;
}

/** R3's unit test. Both count, and the same count. */
export function recurringComparable(
  recurringUnit: string | null | undefined,
  mealUnit: string | null | undefined,
): boolean {
  if (!recurringUnit || !mealUnit) return false;
  if (!isCountUnit(recurringUnit) || !isCountUnit(mealUnit)) return false;
  return canonicalUnitToken(recurringUnit) === canonicalUnitToken(mealUnit);
}

/**
 * Resolve every distinct recurring text to a catalog row and a default pack.
 * Two queries total regardless of input size (the batched lookup), plus one
 * findMany for the resolved rows' packs and one more when the grade map fires.
 *
 * Deduped on the NORMALIZED text, so "Milk" and "milk" are one resolution, and
 * ORDER-STABLE on first appearance.
 */
export async function resolveRecurringItems(
  db: Db,
  texts: readonly string[],
): Promise<RecurringResolution[]> {
  const distinct: { text: string; norm: string }[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    const norm = normalizeIngredientName(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    distinct.push({ text: raw, norm });
  }
  if (distinct.length === 0) return [];

  const hits = await lookupIngredientsByName(
    db,
    distinct.map((d) => ({ primaryKey: d.norm, rawName: d.text })),
  );

  // Ruling 4 — the grade map, AFTER the lookup, on recurring text only.
  const gradeTargets = [
    ...new Set(
      distinct
        .map((d) => RECURRING_GRADE_MAP[d.norm])
        .filter((v): v is string => typeof v === "string"),
    ),
  ];
  const gradeRows = gradeTargets.length
    ? await db.ingredient.findMany({
        where: { canonicalName: { in: gradeTargets } },
        select: { id: true, canonicalName: true },
      })
    : [];
  const gradeByName = new Map(gradeRows.map((r) => [r.canonicalName, r]));

  const wantedIds = new Set<string>();
  for (const d of distinct) {
    const graded = RECURRING_GRADE_MAP[d.norm];
    const g = graded ? gradeByName.get(graded) : undefined;
    if (g) { wantedIds.add(g.id); continue; }
    const h = hits.get(d.norm);
    if (h) wantedIds.add(h.id);
  }
  const rows = wantedIds.size
    ? await db.ingredient.findMany({
        where: { id: { in: [...wantedIds] } },
        select: {
          id: true, canonicalName: true, displayName: true, category: true,
          purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
        },
      })
    : [];
  const rowById = new Map(rows.map((r) => [r.id, r]));

  return distinct.map(({ text, norm }) => {
    const graded = RECURRING_GRADE_MAP[norm];
    const gradeHit = graded ? gradeByName.get(graded) : undefined;
    const hit = hits.get(norm);
    const id = gradeHit?.id ?? hit?.id ?? null;
    const row = id ? rowById.get(id) : undefined;

    // Ruling 2's precedence: the TABLE first, then the row's pack, then none.
    const fromTable = lookupPurchaseDefault(norm);
    const fromRow =
      row &&
      row.purchaseUnit != null &&
      row.purchaseQuantity != null &&
      row.purchaseDisplay != null
        ? {
            purchaseUnit: row.purchaseUnit,
            purchaseQuantity: row.purchaseQuantity,
            purchaseDisplay: row.purchaseDisplay,
          }
        : null;

    return {
      text,
      norm,
      ingredientId: id,
      canonicalName: row?.canonicalName ?? null,
      displayName: row?.displayName ?? null,
      // The CATALOG's category when the item resolved, else the rule's verdict
      // on the user's own text. An unresolved item is not section-less: `coffee`
      // names no catalog row and is still Pantry, and leaving it to fall into
      // `extras` would route it to Sonnet on every generation — which is the
      // instability this block exists to remove.
      category: row?.category ?? inferCategory(norm),
      matchedVia: gradeHit ? "grade" : (hit?.matchedVia ?? null),
      purchase: fromTable ?? fromRow,
      household: inferCategory(norm) === "Household",
    };
  });
}

/** The row shape `recurringFacetsFor` needs — satisfied by a ConsolidatedItem
 *  and by a persisted GroceryListItem alike. */
export interface RecurringFacetRow {
  ingredientId: string | null;
  /**
   * The row's NAME, used only as the fallback identity key when `ingredientId`
   * is null. A `ConsolidatedItem` passes its `canonicalName`; a persisted
   * `GroceryListItem` has no canonical column and passes `displayName`, which
   * for a synthetic IS the user's own recurring text. Both normalize to the same
   * key for the rows that need the fallback.
   */
  canonicalName: string;
  unit: string;
  quantity: number;
  /**
   * Does the PLAN contribute to this row? `GroceryListItemSource` rows are the
   * discriminator groceryReconcile already uses (Q3): a plan-derived row has
   * at least one, a recurring append has none. Without this a recurring-only
   * line would claim a meal need it does not have.
   */
  hasPlanSources: boolean;
}

/**
 * R3's fields for one row. Pure. Returns null when the row is not a recurring
 * one, or when no recurring text claims it (a list generated before B3 whose
 * synthetic no longer matches anything the user has typed since).
 */
export function recurringFacetsFor(
  row: RecurringFacetRow,
  resolutions: readonly RecurringResolution[],
): RecurringFacets | null {
  const res = matchResolution(row, resolutions);
  if (!res) return null;
  const recurringUnit = res.purchase?.purchaseUnit ?? null;
  const recurringQuantity = res.purchase?.purchaseQuantity ?? null;
  const comparable = recurringComparable(recurringUnit, row.unit);

  let mealQuantity: number | null = null;
  if (row.hasPlanSources) {
    mealQuantity = comparable && recurringQuantity !== null
      ? Math.max(0, row.quantity - recurringQuantity)
      : row.quantity;
  }
  return {
    recurringQuantity,
    recurringUnit,
    mealQuantity,
    mealUnit: mealQuantity === null ? null : row.unit,
    comparable,
    household: res.household,
  };
}

/**
 * Which recurring text claims this row. Identity first (the whole point of B3),
 * then the normalized name — which is what a SYNTHETIC row is keyed by, and what
 * a pre-B3 list's rows still carry.
 */
export function matchResolution(
  row: { ingredientId: string | null; canonicalName: string },
  resolutions: readonly RecurringResolution[],
): RecurringResolution | null {
  if (row.ingredientId) {
    const byId = resolutions.find((r) => r.ingredientId === row.ingredientId);
    if (byId) return byId;
  }
  const norm = normalizeIngredientName(row.canonicalName);
  return resolutions.find((r) => r.norm === norm) ?? null;
}
