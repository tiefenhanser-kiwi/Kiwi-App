// WS9 D-WS9-189 A2b — THE PRODUCTION LOADER FOR `ingredient_relations`.
//
// A2 shipped the readers and left them wired to nothing: `relations` was an
// optional parameter on consolidatePlanIngredients / mergeConvertibleGroups /
// partitionForAI, and all three production call sites passed no argument, so
// every one of them fell through to EMPTY_RELATION_INDEX. A2's commit body
// reported "24 real merges across 20 lists"; that was a DRY-RUN figure measured
// through the harness in scripts/ws9-d189-a2/. Zero of those merges had ever
// reached a shopper. This module is what closes that gap.
//
// Deliberately its own file rather than a function inside ingredientRelations.
// That module is pure — it imports normalizeIngredientName and mergeGroupBaseName
// and nothing else, which is what lets its 600-line test file build indexes from
// literals with no database in sight. The Prisma dependency lives here instead,
// and `import type` keeps even this file free of a runtime client import.
//
// NO CACHE, ON PURPOSE. The table changes only through a migration or an A1-class
// backfill script, so a memo would be correct almost always — and "almost always"
// is the shape of a staleness bug nobody can reproduce. The two callers are a
// grocery GENERATION and a grocery RECONCILE, both of which already make several
// AI round-trips; one findMany of ~1,900 rows is not the cost that matters on
// either path. If that ever stops being true, cache it with an explicit
// invalidation hook, not a TTL.

import type { PrismaClient } from "@prisma/client";

import {
  buildRelationIndex,
  type RelationIndex,
  type RelationRow,
} from "./ingredientRelations";

/**
 * Read `ingredient_relations` and build the runtime index.
 *
 * The admitted set is decided inside {@link buildRelationIndex} and is NOT
 * re-litigated here: `synonym` edges at `high` confidence or `reviewedByHuman`
 * (421 of 482), the 60 `medium` edges held, the coarse-salt cluster veto, and
 * the hand map composing last to a fixpoint. This function's only job is to
 * hand that builder every row, in the shape it expects.
 */
export async function loadRelationRows(
  prisma: PrismaClient,
): Promise<RelationRow[]> {
  const raw = await prisma.ingredientRelation.findMany({
    include: {
      // [grocery] B1 — `purchaseUnit` joins `defaultUnit` as the component
      // basis's FALLBACK. D-WS9-218 said unblocking the rest needed a new
      // `fromUnit` column; it did not — `fresh mint` is defaultUnit "sprig" and
      // packed by the BUNCH, and the pack column was already here. The gate that
      // keeps that from re-admitting `canned tuna in olive oil -> olive oil`
      // lives in buildRelationIndex, on `reviewedByHuman`.
      from: { select: { canonicalName: true, defaultUnit: true, purchaseUnit: true } },
      to: { select: { canonicalName: true } },
    },
  });
  const rows: RelationRow[] = raw.map((r) => ({
    label: r.label as RelationRow["label"],
    fromCanonicalName: r.from.canonicalName,
    toCanonicalName: r.to.canonicalName,
    yieldQuantity: r.yieldQuantity,
    yieldUnit: r.yieldUnit,
    coHarvestable: r.coHarvestable,
    confidence: r.confidence as RelationRow["confidence"],
    reviewedByHuman: r.reviewedByHuman,
    fromDefaultUnit: r.from.defaultUnit,
    fromPurchaseUnit: r.from.purchaseUnit,
  }));
  return rows;
}

/**
 * The index, for the callers that only need one.
 *
 * ⚠️ [grocery] B2 — A CONSUMER OF `subsumes` NEEDS THE ROWS, NOT THIS. H3 folds a
 * specific onto its generic only when a recipe demanded the generic, so the
 * subsumes overlay depends on the PLAN and the index has to be rebuilt once the
 * buckets exist. `consolidatePlanIngredients` does that from its
 * `relationRows` option; this function stays because `partitionForAI` and
 * `groceryReconcile` genuinely want one index with no overlay, and because every
 * pre-B2 caller keeps working untouched.
 */
export async function loadRelationIndex(
  prisma: PrismaClient,
): Promise<RelationIndex> {
  return buildRelationIndex(await loadRelationRows(prisma));
}
