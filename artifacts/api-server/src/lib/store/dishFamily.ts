// Plan-Gen Arc · Block 4b-1 (D-WS9-075) — parent-dish recovery for the shortlist
// diversity cap.
//
// The catalog's `dishFamilyKey` is the slug of the VERSION name and is UNIQUE
// per meal (1124/1124 distinct — measured), so it CANNOT group the ~5-6 versions
// of one parent dish ("Baked Chicken Breast" → 6 rows with 6 different keys).
// The intended parent grouping lives in the frozen spine `storeFillDishes.ts`:
// every TARGET_DISHES row carries both `key` (== the stamped dishFamilyKey) and
// `parentDish` (+ `rank`, the parent's popularity rank 1..562). So the parent is
// fully recoverable by an EXACT join on dishFamilyKey — verified 100% (1124/1124)
// against the live catalog. No heuristic, no positional adjacency.
//
// We resolve this in-app from the generated constant rather than persisting a
// `dishParentKey` column: the constant is the catalog's source of truth and
// regenerates WITH the catalog, so the mapping never drifts. A backfilled column
// would carry the same refresh-staleness the positional fallback would have — the
// exact fragility we set out to avoid. (Persisting it becomes worthwhile only when
// a cross-entity query needs it — e.g. repeat-avoidance resolving a user fork back
// to its parent family — which is a later block.)

import { TARGET_DISHES } from "../storeFillDishes";

export interface DishFamilyInfo {
  /** Slug of the parent dish — the grouping key for the 1-version-per-dish cap. */
  parentKey: string;
  /** The parent dish's popularity rank (1 = most commonly cooked … 562 = tail). */
  rank: number;
}

// Rank assigned to pool meals with no TARGET_DISHES match (the ~27 non-batch
// curated / live_writeback / manual meals — they carry no dishFamilyKey, so there
// is no popularity rank for them). We give them the MEDIAN catalog rank, not the
// tail: a `live_writeback` meal is one a real user actually cooked and the system
// wrote back, so bottom-weighting it below the entire catalog would starve the
// write-back loop (a written-back meal would almost never be served again). Median
// makes them sample like a typical catalog dish — reachable, not prioritized.
// (562 parent ranks → median ≈ 281. A future real-usage signal could let a proven
// written-back meal earn a head rank; none exists today — all useCount are 0.)
// Each unmapped meal is also its own singleton parent (see parentKeyForMeal) so
// they never cap each other.
export const NON_CATALOG_RANK = 281;

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// versionKey (== dishFamilyKey) → { parentKey, rank }. Built once at module load.
const byVersionKey: Map<string, DishFamilyInfo> = (() => {
  const m = new Map<string, DishFamilyInfo>();
  for (const t of TARGET_DISHES) {
    m.set(t.key, { parentKey: slug(t.parentDish), rank: t.rank });
  }
  return m;
})();

/**
 * Resolve a catalog meal's parent dish + rank from its `dishFamilyKey`. Returns
 * `null` for a meal whose key doesn't join (non-batch pool meals with a null/
 * unknown key) — callers treat those as singleton parents at NON_CATALOG_RANK.
 */
export function lookupDishFamily(dishFamilyKey: string | null): DishFamilyInfo | null {
  if (!dishFamilyKey) return null;
  return byVersionKey.get(dishFamilyKey) ?? null;
}

/**
 * The grouping key for the diversity cap: the parent slug for a catalog meal, or
 * a per-meal singleton key (`x:<id>`) for a non-catalog meal so it is never
 * capped against any other meal.
 */
export function parentKeyForMeal(mealId: string, dishFamilyKey: string | null): string {
  const info = lookupDishFamily(dishFamilyKey);
  return info ? info.parentKey : `x:${mealId}`;
}

/** Exposed for tests / diagnostics — how many distinct parent dishes the spine holds. */
export function distinctParentCount(): number {
  return new Set(TARGET_DISHES.map((t) => slug(t.parentDish))).size;
}
