// [grocery] B3 · Part A — a THROWAWAY copy of what Part C will make
// consolidatePlanIngredients do. Part C changes the real code and this file
// stops mattering.
//
// What it does NOT re-implement: the resolver (lookupIngredientByName + the
// IngredientAlias synonym index), the pack resolution, the ladder, the rounding,
// the merge, the rider and the client render are all shipped functions, called
// unchanged. What is here is the match-or-append rule and R3's two branches.

import type { ConsolidatedItem } from "../../src/lib/groceryList";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import { canonicalUnitToken, isCountUnit } from "../../src/lib/ingredientConversions";

// ── the STABLE pack for a recurring item that resolves to no catalog row ─────
//
// Today every one of these is gap-filled by Haiku on EVERY generation and the
// answer is never stored (groceryListAI.ts skips write-back when ingredientId is
// null). D-WS9-228 says the pack is gap-filled ONCE and stored on the recurring
// item. Until there is somewhere to store it, this table stands in for that
// store, and its values are the MAJORITY answer Haiku gave across the 288
// recurring observations in the census corpus.
export const SYNTHETIC_PACKS: Record<
  string,
  { purchaseUnit: string; purchaseQuantity: number; purchaseDisplay: string; household: boolean }
> = {
  "paper towels": { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (6-pack)", household: true },
  "toilet paper": { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (12-pack)", household: true },
  "pet treats": { purchaseUnit: "box", purchaseQuantity: 1, purchaseDisplay: "1 box", household: true },
  "coffee": { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (12 oz)", household: false },
};

export interface CatalogRow {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string;
  defaultUnit: string;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
  packYieldUnit: string | null;
  packYieldPerPack: number | null;
  conversionRef: unknown;
  sectionKey: ConsolidatedItem["sectionKey"];
}

/** The R3 annotation Part C will put on the wire and block C will render. */
export interface R3Fields {
  /** what the recurring line buys on its own, in its own unit */
  recurringQuantity: number;
  recurringUnit: string;
  /** what the plan's recipes need, in THEIR unit; null when the plan needs none */
  mealQuantity: number | null;
  mealUnit: string | null;
  /**
   * R3's branch. TRUE means one summed line with the split; FALSE means the
   * recurring quantity is the DEFAULT PURCHASE and the meal need rides beside it.
   *
   * ⚠️ COMPARABLE IS NOT "CONVERTIBLE". A gallon and two cups convert perfectly
   * and Hans put that pair in the incomparable branch on purpose — "the app never
   * decides that a gallon covers two cups". So the test is that BOTH sides are the
   * same COUNT unit: five lemons and three lemons are five and three of one thing.
   * Anything measured is the other branch.
   */
  comparable: boolean;
  /** true when the item named no catalog food — paper towels, toilet paper */
  household: boolean;
}

export function r3Comparable(recurringUnit: string, mealUnit: string): boolean {
  if (!recurringUnit || !mealUnit) return false;
  if (!isCountUnit(recurringUnit) || !isCountUnit(mealUnit)) return false;
  return canonicalUnitToken(recurringUnit) === canonicalUnitToken(mealUnit);
}

/** The split text R3 asks for — "5 lemons — 2 recurring + 3 for meals". */
export function r3Annotation(f: R3Fields, noun: string): string {
  if (f.mealQuantity === null) return "recurring";
  if (f.comparable) {
    return `${fmt(f.recurringQuantity)} recurring + ${fmt(f.mealQuantity)} for meals`;
  }
  return `recurring; ${fmt(f.mealQuantity)} ${f.mealUnit} for meals`;
  function noop() { return noun; }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export interface ResolveResult {
  raw: string;
  norm: string;
  row: CatalogRow | null;
  matchedVia: "canonical" | "alias" | null;
}

/**
 * THE MATCH-OR-APPEND, REWRITTEN.
 *
 * Today's rule is `normalizeIngredientName(entry.canonicalName) === norm` — an
 * exact name equality against catalog canonicals, which is why 0 of 96 recurring
 * rows ever met a plan row: there is no catalog row called `milk`.
 *
 * The new rule resolves the free text to an Ingredient FIRST (the caller does
 * that, with the shipped `lookupIngredientByName`), then matches on IDENTITY —
 * `ingredientId`, falling back to the group key, which is the same key the merge
 * and partitionForAI already use.
 *
 * Returns a NEW array; never mutates the input rows.
 */
export function applyRecurringResolution(opts: {
  /** the post-merge rows consolidate produced, WITH today's synthetics removed */
  planRows: ConsolidatedItem[];
  /** one entry per distinct recurring text, already resolved */
  resolutions: ResolveResult[];
  groupKey: (name: string) => string;
}): { rows: ConsolidatedItem[]; fields: Map<ConsolidatedItem, R3Fields> } {
  const rows = opts.planRows.map((r) => ({ ...r }));
  const fields = new Map<ConsolidatedItem, R3Fields>();

  const byIngId = new Map<string, ConsolidatedItem[]>();
  const byKey = new Map<string, ConsolidatedItem[]>();
  for (const r of rows) {
    if (r.ingredientId) {
      const a = byIngId.get(r.ingredientId) ?? []; a.push(r); byIngId.set(r.ingredientId, a);
    }
    const k = opts.groupKey(r.canonicalName);
    const b = byKey.get(k) ?? []; b.push(r); byKey.set(k, b);
  }

  const appendedByKey = new Map<string, ConsolidatedItem>();

  for (const res of opts.resolutions) {
    // ── (a) no catalog row — the SYNTHETIC, with a pack that does not move ──
    if (!res.row) {
      const pack = SYNTHETIC_PACKS[res.norm];
      const key = `__synth__${res.norm}`;
      const already = appendedByKey.get(key);
      if (already) continue;
      const synthetic: ConsolidatedItem = {
        ingredientId: null,
        canonicalName: res.norm,
        displayName: res.raw,
        quantity: pack ? pack.purchaseQuantity : 1,
        unit: pack ? pack.purchaseUnit : "each",
        sectionKey: pack?.household ? "household" : "extras",
        isUniversalStaple: false,
        isUserPantryStaple: false,
        isRecurringItem: true,
        sources: [],
        purchaseUnit: pack ? pack.purchaseUnit : null,
        purchaseQuantity: pack ? pack.purchaseQuantity : null,
        purchaseDisplay: pack ? pack.purchaseDisplay : null,
        conversionRef: null,
        packYieldUnit: null,
        packYieldPerPack: null,
        packFloor: null,
        preparationNote: null,
        sourceDishTitle: null,
      };
      rows.push(synthetic);
      appendedByKey.set(key, synthetic);
      fields.set(synthetic, {
        recurringQuantity: synthetic.quantity,
        recurringUnit: synthetic.unit,
        mealQuantity: null,
        mealUnit: null,
        comparable: false,
        household: pack?.household ?? false,
      });
      continue;
    }

    const row = res.row;
    // the recurring item's OWN purchase basis: the catalog pack. A user who
    // types "Lemons" is asking for lemons, and the pack is the catalog's answer
    // to how many. Falls back to one each when the row carries no pack (the
    // gap-fill then fills it ONCE, and now it has a row to write back to).
    const recQty = row.purchaseQuantity ?? 1;
    const recUnit = row.purchaseUnit ?? row.defaultUnit ?? "each";

    // ── (b) the plan already demands this food — R3's two branches ──────────
    const key = opts.groupKey(row.canonicalName);
    const met = (byIngId.get(row.id) ?? []).concat(
      (byKey.get(key) ?? []).filter((r) => r.ingredientId !== row.id),
    );
    if (met.length > 0) {
      for (const m of met) {
        const comparable = r3Comparable(recUnit, m.unit);
        const f: R3Fields = {
          recurringQuantity: recQty,
          recurringUnit: recUnit,
          mealQuantity: m.quantity,
          mealUnit: m.unit,
          comparable,
          household: false,
        };
        m.isRecurringItem = true;
        if (comparable) {
          // ONE LINE, SUMMED. The split lives in the R3 fields, not in the sum.
          m.quantity = m.quantity + recQty;
        }
        // ⛔ the incomparable branch adds NOTHING to the need. The line's PURCHASE
        // becomes the recurring default (the pack the catalog names), which is
        // what resolvePurchaseFields already produces from purchaseQuantity, and
        // the meal need stays exactly what the recipes asked for. The app never
        // decides the bottle covers the cup, and it never buys twice either.
        fields.set(m, f);
      }
      continue;
    }

    // ── (c) resolved, but this plan demands none — one line, with an identity ─
    const already = appendedByKey.get(key);
    if (already) { already.isRecurringItem = true; continue; }
    const appended: ConsolidatedItem = {
      ingredientId: row.id,
      canonicalName: row.canonicalName,
      displayName: row.displayName,
      quantity: recQty,
      unit: recUnit,
      sectionKey: row.sectionKey,
      isUniversalStaple: false,
      isUserPantryStaple: false,
      isRecurringItem: true,
      sources: [],
      purchaseUnit: row.purchaseUnit,
      purchaseQuantity: row.purchaseQuantity,
      purchaseDisplay: row.purchaseDisplay,
      conversionRef: row.conversionRef,
      packYieldUnit: row.packYieldUnit,
      packYieldPerPack: row.packYieldPerPack,
      packFloor: null,
      preparationNote: null,
      sourceDishTitle: null,
    };
    rows.push(appended);
    appendedByKey.set(key, appended);
    fields.set(appended, {
      recurringQuantity: recQty,
      recurringUnit: recUnit,
      mealQuantity: null,
      mealUnit: null,
      comparable: false,
      household: false,
    });
  }

  return { rows, fields };
}

/** Today's synthetic recurring rows — the ones the resolution replaces. */
export function isTodaysSynthetic(r: ConsolidatedItem): boolean {
  return r.isRecurringItem && r.ingredientId === null && r.sources.length === 0;
}

export function normKey(name: string): string {
  return normalizeIngredientName(name);
}
