// WS7-7-A Block 4 — Incremental grocery-list reconcile (D-WS7-079 core).
//
// Plan-meal edits bump MealPlanInstance.revisionId but never propagated to an
// already-generated GroceryList. This service is the consumer: an incremental,
// reconcile-on-READ invoked from GET /grocery-lists/:id. The generate route's
// Case-1 409 path is intentionally untouched (B5 mobile builds against it).
//
// Trigger + staleness (rulings 1-2): compare the list's stored
// lastGeneratedFromPlanRevisionId against the plan's live revisionId. Equal →
// zero work. Stale → reconcile, then stamp the pointer to the live revision
// on success only.
//
// Delta model (Phase-0 ruling, Option A — servings-propagation DEFERRED as
// D-WS7-134): with Meal.id-granularity provenance and no stored per-meal
// quantity, only ADDED and REMOVED meals are detectable. Swaps and recipe-
// promotes manifest as remove-old + add-new (they mint a fresh Meal.id). An
// in-place servingsOverride edit on a meal that stays in the plan is NOT
// detectable and does NOT propagate — that is the reserved D-WS7-134 gap.
//
// Meal sets are derived purely from provenance, no separate plan-items query:
//   • currentMealIds   = union of source (mealId) across the live consolidator
//                        output (every plan meal that contributes an ingredient)
//   • priorMealIds     = union of source (mealId) across the list's existing
//                        plan-derived rows (what generation saw)
//   • unchanged = current ∩ prior   added = current \ prior   removed = prior \ current
//
// Carry-forward (rulings 3-7, D-WS7-124/126): an existing plan-derived row is
// carried UNTOUCHED — preserving every B2 user edit (isChecked, stapleOptedIn,
// quantity, unit, storeSection, displayName, userResolvedTo, deletedAt) — iff
// ALL its source meals are unchanged AND the live consolidated line for its
// bucket also draws only from unchanged meals. Everything else re-resolves.
// Notably (refinements 3-4):
//   • Mixed unchanged+removed row → re-resolve (its quantity went stale-down
//     when the removed meal left; the live consolidated line reflects the lower
//     amount).
//   • Bucket-merge (an unchanged meal's ingredient now shares a consolidated
//     bucket with an added meal) → the whole row re-resolves and prior user
//     state is LOST. Accepted D-WS7-124 boundary, slightly widened.
//   • Carrying a soft-deleted unchanged row keeps it deleted = D-WS7-126
//     suppression; a deleted row whose bucket re-resolves may regenerate fresh
//     = resurrection.
//
// Zero-source rows (Q3 discriminator): isRecurringItem=true → carried (synthetic
// recurring, preserve user state); isRecurringItem=false → AI-renamed/merged
// tail, always re-resolved. isUserAdded=true rows are NEVER read into the delta,
// re-resolved, deleted, or modified.
//
// Failure path (ruling 6): ALL consolidation + AI runs BEFORE any DB write;
// the row mutations + pointer stamp commit in a SINGLE transaction. If an AI
// call throws, it throws before the transaction opens — nothing is written, the
// pointer is not advanced, and the caller serves the prior persisted list. The
// next GET retries.

import { randomUUID } from "node:crypto";

import type { PrismaClient, Prisma, StoreSection } from "@prisma/client";

import type { SectionKey } from "./ai/schemas/grocery";
import {
  consolidatePlanIngredients as productionConsolidatePlanIngredients,
  type ConsolidatedItem,
} from "./groceryList";
import {
  fillPurchaseSizesWithWriteBack as productionFillPurchaseSizesWithWriteBack,
  generateFinalGroceryList as productionGenerateFinalGroceryList,
} from "./groceryListAI";
import { normalizeIngredientName } from "./groceryNormalization";
import { lookupIngredientByName } from "./ingredientLookup";

// Mirrors the route's KNOWN_SECTIONS (same duplication note as
// groceryLists.ts ↔ groceryList.ts: kept local to avoid widening a shared
// surface; consumers diverge as sections grow).
const KNOWN_SECTIONS: StoreSection[] = [
  "produce",
  "meat_seafood",
  "dairy_eggs",
  "bakery_bread",
  "pantry",
  "canned",
  "frozen",
  "snacks",
  "household",
  "extras",
];

export interface ReconcileGroceryListDeps {
  prisma: PrismaClient;
  consolidatePlanIngredients: typeof productionConsolidatePlanIngredients;
  fillPurchaseSizesWithWriteBack: typeof productionFillPurchaseSizesWithWriteBack;
  generateFinalGroceryList: typeof productionGenerateFinalGroceryList;
}

export interface ReconcileResult {
  // false when nothing was stale (revision-equal, no plan, null pointer) — the
  // caller can treat the persisted list as authoritative without any side effect.
  reconciled: boolean;
  // true when the pointer was advanced (a stale list was successfully
  // reconciled, even if the delta was a structural no-op).
  stamped: boolean;
}

// Match key shared between consolidator lines and persisted rows. ingredientId
// is the only field reliably present + stable on BOTH sides: the AI final-pass
// drops ingredientId, so the route re-derives it from the FINAL canonicalName —
// which equals the consolidator's ingredient exactly when the AI preserved the
// canonical (i.e. for every row that kept its provenance join). Rows whose AI
// rename broke the join are zero-source and never reach this matcher. For the
// rare sourced row with a null Ingredient row, fall back to the normalized
// display/canonical name + unit.
function matchKey(
  ingredientId: string | null,
  unit: string,
  name: string,
): string {
  return ingredientId
    ? `id:${ingredientId}|${unit}`
    : `nm:${normalizeIngredientName(name)}|${unit}`;
}

interface ExistingRow {
  id: string;
  ingredientId: string | null;
  displayName: string;
  unit: string;
  isRecurringItem: boolean;
  isUserAdded: boolean;
  // WS7-7-A Block 5 — servings/ingredientSignature are null on rows generated
  // before this column existed (D1 re-resolve-once: null ≠ computed ⇒ the row
  // re-resolves on its first post-deploy reconcile, then self-heals).
  sources: {
    mealId: string;
    dishId: string;
    servings: number | null;
    ingredientSignature: string | null;
  }[];
}

function allMealsIn(mealIds: string[], allowed: Set<string>): boolean {
  for (const m of mealIds) {
    if (!allowed.has(m)) return false;
  }
  return true;
}

export async function reconcileGroceryListIfStale(
  listId: string,
  userId: string,
  deps: ReconcileGroceryListDeps,
): Promise<ReconcileResult> {
  const {
    prisma,
    consolidatePlanIngredients,
    fillPurchaseSizesWithWriteBack,
    generateFinalGroceryList,
  } = deps;

  // 1. List meta — ownership-scoped. A missing/cross-user list is the caller's
  //    404 to surface; reconcile just no-ops.
  const list = await prisma.groceryList.findFirst({
    where: { id: listId, userId },
    select: {
      id: true,
      mealPlanInstanceId: true,
      lastGeneratedFromPlanRevisionId: true,
    },
  });
  if (!list || !list.mealPlanInstanceId) {
    // Ruling 7: lists with no plan link never reconcile.
    return { reconciled: false, stamped: false };
  }
  if (list.lastGeneratedFromPlanRevisionId == null) {
    // No generation baseline to diff against — leave untouched.
    return { reconciled: false, stamped: false };
  }

  // 2. Plan revision (+ title for the AI pass). The staleness check happens
  //    BEFORE any consolidator/AI work so a revision-equal GET pays nothing.
  const plan = await prisma.mealPlanInstance.findFirst({
    where: { id: list.mealPlanInstanceId, userId },
    select: {
      revisionId: true,
      titleOverride: true,
      template: { select: { title: true } },
    },
  });
  if (!plan) {
    return { reconciled: false, stamped: false };
  }
  if (plan.revisionId === list.lastGeneratedFromPlanRevisionId) {
    // Equal → serve as-is, zero extra work (no consolidator, no AI).
    return { reconciled: false, stamped: false };
  }

  // 3. Stale. Read the existing rows + provenance (ALL rows incl. soft-deleted
  //    — soft-deletes are the D-WS7-126 suppression signal).
  const existingRaw = await prisma.groceryListItem.findMany({
    where: { groceryListId: list.id },
    select: {
      id: true,
      ingredientId: true,
      displayName: true,
      unit: true,
      isRecurringItem: true,
      isUserAdded: true,
      // WS7-7-A Block 5 — pull the per-source change-signature so the carry
      // test can detect an intra-meal edit (same mealId, changed contribution).
      sources: {
        select: {
          mealId: true,
          dishId: true,
          servings: true,
          ingredientSignature: true,
        },
      },
    },
  });
  const existing: ExistingRow[] = existingRaw as ExistingRow[];
  // isUserAdded rows are never touched: not read into the delta, not carried,
  // not deleted, not re-resolved.
  const planDerived = existing.filter((r) => !r.isUserAdded);

  // 4. Live consolidation (deterministic, no AI). Its source pairs give the
  //    current plan-meal membership; partitioning its output drives re-resolve.
  const consolidated = await consolidatePlanIngredients({
    prisma,
    planId: list.mealPlanInstanceId,
    userId,
  });

  // 5. Meal sets, derived purely from provenance.
  const currentMealIds = new Set<string>();
  for (const line of consolidated) {
    for (const s of line.sources) currentMealIds.add(s.mealId);
  }
  const priorMealIds = new Set<string>();
  for (const r of planDerived) {
    for (const s of r.sources) priorMealIds.add(s.mealId);
  }
  const unchanged = new Set<string>();
  for (const m of currentMealIds) {
    if (priorMealIds.has(m)) unchanged.add(m);
  }

  // 6. Index live consolidated lines by match key. Synthetic recurring lines
  //    carry no sources; they are excluded from re-resolution (existing
  //    recurring rows carry forward) so they don't index here for carry tests.
  const consByKey = new Map<string, ConsolidatedItem>();
  for (const line of consolidated) {
    consByKey.set(
      matchKey(line.ingredientId, line.unit, line.canonicalName),
      line,
    );
  }

  // 6b. Live change-signatures keyed by (mealId, dishId). Every source of the
  //     same dish carries an identical signature, so last-write is harmless.
  //     This is how reconcile detects an INTRA-meal edit: the meal stays in the
  //     plan (mealId unchanged) but its dish's servings or ingredient set moved,
  //     so the stored source signature no longer matches the live one.
  const liveSourceSig = new Map<
    string,
    { servings: number; ingredientSignature: string }
  >();
  for (const line of consolidated) {
    for (const s of line.sources) {
      liveSourceSig.set(`${s.mealId}|${s.dishId}`, {
        servings: s.servings,
        ingredientSignature: s.ingredientSignature,
      });
    }
  }

  // 7. Classify existing plan-derived rows → carry (keep untouched) or delete.
  const carriedKeys = new Set<string>();
  const deleteIds: string[] = [];
  for (const r of planDerived) {
    if (r.sources.length === 0) {
      // Zero-source: recurring synthetic → carry; AI-tail → re-resolve.
      if (r.isRecurringItem) {
        // Carried untouched. Not added to carriedKeys: recurring lines carry
        // no sources and are skipped by the resolution partition anyway.
        continue;
      }
      deleteIds.push(r.id);
      continue;
    }
    const key = matchKey(r.ingredientId, r.unit, r.displayName);
    const line = consByKey.get(key);
    const rowMealIds = r.sources.map((s) => s.mealId);
    // WS7-7-A Block 5 — intra-meal change detection. Every stored source must
    // still exist live (same mealId+dishId) AND match on both axes: servings
    // and ingredientSignature. Any drift (or a null pre-B5 signature) fails the
    // test → the row re-resolves with the recomputed quantity instead of being
    // carried forward with a stale one. This is the load-bearing fix that lets
    // a servings-only or ingredient-only edit reach the list (D-WS7-134).
    const signaturesMatch = r.sources.every((s) => {
      const live = liveSourceSig.get(`${s.mealId}|${s.dishId}`);
      return (
        live != null &&
        live.servings === s.servings &&
        live.ingredientSignature === s.ingredientSignature
      );
    });
    const carry =
      line != null &&
      signaturesMatch &&
      allMealsIn(rowMealIds, unchanged) &&
      allMealsIn(
        line.sources.map((s) => s.mealId),
        unchanged,
      );
    if (carry) {
      carriedKeys.add(key);
    } else {
      // Not carry-eligible: added-meal participation (bucket-merge),
      // mixed unchanged+removed (stale-down), or removed-only (gone).
      deleteIds.push(r.id);
    }
  }

  // 8. Resolution subset = live consolidated lines that carry actual sources
  //    and are NOT covered by a carried row. Recurring synthetic lines (no
  //    sources) are excluded — their existing rows carry forward; brand-new
  //    recurring prefs are out of scope here (they don't bump plan revision).
  const resolutionSubset = consolidated.filter(
    (line) =>
      line.sources.length > 0 &&
      !carriedKeys.has(
        matchKey(line.ingredientId, line.unit, line.canonicalName),
      ),
  );

  // 9. Re-resolve the subset (AI). Skipped entirely when empty. ALL AI work
  //    happens here, before the transaction — a throw aborts with zero writes.
  const planTitle = plan.titleOverride ?? plan.template?.title ?? "";
  let newItems: Prisma.GroceryListItemCreateManyInput[] = [];
  let newSources: Prisma.GroceryListItemSourceCreateManyInput[] = [];
  if (resolutionSubset.length > 0) {
    const withSizes = await fillPurchaseSizesWithWriteBack(resolutionSubset, {
      prisma,
      userId,
    });
    const final = await generateFinalGroceryList(
      planTitle,
      withSizes,
      KNOWN_SECTIONS,
      { prisma, userId },
    );

    // Resolve canonical → ingredientId before the tx (immutable canonical rows;
    // race-free, mirrors the generate route's hoist).
    const resolvedIds = await Promise.all(
      final.items.map((item) => lookupIngredientId(prisma, item.canonicalName)),
    );

    // Re-join final items back to their consolidated sources by bucket key —
    // identical to the generate route's persist-time join. AI-merged/renamed
    // rows that no longer match get no source rows (conservatively re-resolved
    // on the next stale read, same as generation).
    const sourcesByKey = new Map<string, ConsolidatedItem["sources"]>();
    for (const c of resolutionSubset) {
      sourcesByKey.set(
        `${normalizeIngredientName(c.canonicalName)}|${c.unit}`,
        c.sources,
      );
    }

    const ids = final.items.map(() => randomUUID());
    newItems = final.items.map((item, idx) => ({
      id: ids[idx],
      groceryListId: list.id,
      ingredientId: resolvedIds[idx],
      displayName: item.displayName,
      quantity: item.quantity,
      unit: item.unit,
      storeSection: item.sectionKey,
      isUniversalStaple: item.isUniversalStaple,
      isUserPantryStaple: item.isUserPantryStaple,
      isRecurringItem: item.isRecurringItem,
      wasAiInferred: item.wasAiInferred,
      isAmbiguous: item.isAmbiguous,
      ambiguityOptions: item.ambiguityOptions ?? [],
      // Re-resolved rows are plan-derived and start with clean state
      // (D-WS7-124: prior check-state is NOT carried through re-resolution).
      isUserAdded: false,
      notes: item.notes,
      // WS7-8b B2 commit 3 — the pack is DERIVED: reconcile regenerates it from
      // fresh conversion data on every re-resolution (matches the generate path).
      purchaseUnit: item.purchaseUnit ?? null,
      purchaseQuantity: item.purchaseQuantity ?? null,
      purchaseDisplay: item.purchaseDisplay ?? null,
    }));
    newSources = final.items.flatMap((item, idx) => {
      const sources =
        sourcesByKey.get(
          `${normalizeIngredientName(item.canonicalName)}|${item.unit}`,
        ) ?? [];
      return sources.map((s) => ({
        groceryListItemId: ids[idx],
        mealId: s.mealId,
        dishId: s.dishId,
        // WS7-7-A Block 5 — re-resolved rows carry the fresh change-signature.
        servings: s.servings,
        ingredientSignature: s.ingredientSignature,
      }));
    });
  }

  // 10. Commit: delete superseded/removed rows (sources cascade), insert the
  //     re-resolved rows + provenance, and stamp the pointer — atomically. We
  //     stamp even on a structural no-op delta so a no-grocery-effect revision
  //     bump (day/notes/servings-deferred) doesn't re-run the consolidator on
  //     every subsequent GET.
  await prisma.$transaction(
    async (tx) => {
      if (deleteIds.length > 0) {
        await tx.groceryListItem.deleteMany({ where: { id: { in: deleteIds } } });
      }
      if (newItems.length > 0) {
        await tx.groceryListItem.createMany({ data: newItems });
      }
      if (newSources.length > 0) {
        await tx.groceryListItemSource.createMany({ data: newSources });
      }
      await tx.groceryList.update({
        where: { id: list.id },
        data: {
          lastGeneratedFromPlanRevisionId: plan.revisionId,
          lastGeneratedAt: new Date(),
        },
      });
    },
    // BUG-116 (1) — this was the last plan-scale write batch still running on
    // Prisma's DEFAULT 5000ms interactive-transaction budget, and it is reached
    // from grocery READ paths (reconcile-on-read in GET /grocery-lists/:id), so
    // a P2028 here fails a read the user did not know was a write. The same
    // shape produced live P2028s elsewhere and was raised.
    //
    // Matched the me.ts precedent — { timeout: 15000 } — not wizard.ts's
    // { timeout: 60_000, maxWait: 20_000 }. This tx is four bulk statements
    // (deleteMany + two createMany + one update) with no AI and no per-row
    // loop, the same weight class as me.ts's materializeMeal batch; wizard's
    // 60s covers a whole plan materialization plus activation and would be
    // masking rather than sizing. maxWait is deliberately left at its default,
    // as me.ts leaves it — inventing a third value in the codebase is worse
    // than matching an existing one.
    { timeout: 15000 },
  );

  return { reconciled: true, stamped: true };
}

// Best-effort canonical-name → Ingredient.id lookup. Mirrors the generate
// route's private helper (kept local rather than widening that module's API).
//
// WS9 BUG-096 — ALIAS-AWARE via the shared helper. A miss here writes
// `ingredientId: null` on the grocery row, which silently loses the pack size,
// the conversion and the store section; the 81-pair merge deletes the loser
// rows, so without the alias fallback every AI/user mention of a merged-away
// name would start doing exactly that. The primary key stays
// `normalizeIngredientName` — unchanged, so nothing that resolves today stops.
async function lookupIngredientId(
  prisma: PrismaClient,
  canonicalName: string,
): Promise<string | null> {
  const normalized = normalizeIngredientName(canonicalName);
  const hit = await lookupIngredientByName(prisma, normalized, canonicalName);
  return hit?.id ?? null;
}
