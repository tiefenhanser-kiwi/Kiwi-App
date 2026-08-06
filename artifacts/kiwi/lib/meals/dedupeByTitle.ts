// WS9 3f-4 (Thread E, §5.1) — BUG-058 client half: candidate de-duplication.
//
// Phase 0 concluded the "same meal three times" repro came from the MODEL
// returning one mealId more than once, and ruled out corpus duplicates on the
// grounds that the seeded catalog holds one row per dishFamilyKey. That covers
// the CATALOG. It does NOT cover the user's OWN library: a DB measurement in
// Phase 1 found user-owned `my_meals` sets riddled with DISTINCT records that
// share a normalized title (e.g. four separate "Beef Tacos" rows, different
// ids, dishFamilyKey NULL on every user meal). An id-keyed de-dupe would not
// touch them.
//
// So the client de-dupes on DISH IDENTITY = normalized title, which also
// subsumes the id-repeat case (same id ⇒ same title). `dishFamilyKey` is NOT a
// usable key here: it is null on all user-owned meals (only batch/store rows
// carry it), so title is the only signal both shapes share.
//
// Normalization mirrors the server's storeFill.ts `dedupKey` (lower / trim /
// collapse-whitespace / strip trailing punctuation) so the client and the batch
// job agree on what "the same dish" means.

/** Normalized dish-identity key for a meal title. Mirrors server dedupKey. */
export function normalizeMealTitleKey(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:'"]+$/g, "");
}

/**
 * De-duplicate a list of meals by normalized title.
 *
 * Default (no `pickBest`): KEEP THE FIRST occurrence, drop the rest. Applied to
 * an AI-ranked list, "first" is the highest-ranked instance — so de-duplication
 * never reorders the model's ranking (§5.1). This is the POST-ranking layer.
 *
 * With `pickBest` (the PRE-ranking / pool layer, §6.2): when a duplicate title
 * is seen, the survivor for that title is `pickBest(currentSurvivor, candidate)`,
 * kept AT THE FIRST OCCURRENCE'S POSITION. There is no ranking yet at this layer,
 * so which record survives would otherwise be whatever the merge order produced —
 * `pickBest` makes it deterministic (e.g. prefer the more complete record, so a
 * half-built bug-hunt duplicate never gets swapped into the plan).
 *
 * Pure; order-stable for the survivors either way.
 */
export function dedupeMealsByTitle<T extends { title: string }>(
  meals: readonly T[],
  pickBest?: (currentSurvivor: T, candidate: T) => T,
): T[] {
  const idxByKey = new Map<string, number>();
  const out: T[] = [];
  for (const m of meals) {
    const key = normalizeMealTitleKey(m.title);
    const existing = idxByKey.get(key);
    if (existing === undefined) {
      idxByKey.set(key, out.length);
      out.push(m);
    } else if (pickBest) {
      out[existing] = pickBest(out[existing], m);
    }
    // else: drop — keep the first (highest-ranked) occurrence.
  }
  return out;
}

// ── §6.2 pre-ranking tiebreak ────────────────────────────────────────────────
// The candidate pool is GET /me/meals list shape (MealListItem), which carries
// NEITHER `updatedAt` NOR ingredient/step counts — so "most recently updated" /
// "most ingredients" are not expressible here. The best signal available from
// the list fields is COMPLETENESS: a fully-built meal has an image, real macros,
// a cuisine, and tags; a half-built bug-hunt duplicate typically lacks some.
// This proxy is deterministic and, on ties, breaks by id so the choice is stable
// across runs. (If the list shape later grows an `updatedAt`, prefer that.)

export interface MealCompletenessFields {
  id: string;
  image?: string | null;
  calories?: number;
  cuisine?: string;
  tags?: readonly string[];
}

/** Count of "this record was fully built" signals present in the list fields. */
export function mealCompletenessScore(m: MealCompletenessFields): number {
  let score = 0;
  if (m.image) score += 1;
  if ((m.calories ?? 0) > 0) score += 1;
  if (m.cuisine && m.cuisine.trim().length > 0) score += 1;
  if (m.tags && m.tags.length > 0) score += 1;
  return score;
}

/**
 * Deterministic pre-ranking survivor rule (§6.2): prefer the more complete
 * record; on an equal completeness score, prefer the lexicographically smaller
 * id so the choice is stable regardless of merge order.
 */
export function preferMoreCompleteMeal<T extends MealCompletenessFields>(
  a: T,
  b: T,
): T {
  const sa = mealCompletenessScore(a);
  const sb = mealCompletenessScore(b);
  if (sb > sa) return b;
  if (sa > sb) return a;
  return a.id <= b.id ? a : b;
}
