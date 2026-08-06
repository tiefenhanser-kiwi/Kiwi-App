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
 * De-duplicate a list of meals by normalized title, KEEPING THE FIRST
 * occurrence and dropping the rest. Applied to an AI-ranked list, "first" is
 * the highest-ranked instance — so de-duplication never silently reorders the
 * model's ranking (§5.1). Pure; order-stable for the survivors.
 */
export function dedupeMealsByTitle<T extends { title: string }>(
  meals: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of meals) {
    const key = normalizeMealTitleKey(m.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
