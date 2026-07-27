// Plan-Gen Arc · Block 4b-1 (D-WS9-075) — cuisine normalization for the shortlist
// cuisine quota.
//
// The catalog's `cuisineType` is free-form: ~82 distinct values ("Italian",
// "Italian-American", "American-Italian", "Chinese-American", "American BBQ",
// "American (Cincinnati Chili)"…). The user's cuisine prefs come from a fixed UI
// list (domain.ts CUISINES_TIER_1/2). Exact string equality — the old scoring's
// `+0.35` — almost never fires across those two vocabularies, which is why cuisine
// was effectively inert. We normalize BOTH sides to a shared canonical token set
// at scoring time (no migration, no data rewrite). Canonicalizing `cuisineType` at
// the Zod boundary is the durable fix and is deferred as a WS10 follow-up.
//
// Normalization is MULTI-token and forgiving: "Chinese-American" → {chinese, asian}
// so it matches a user who picked EITHER "Chinese" or "Asian". A raw value that
// maps to nothing (e.g. "British") yields an empty set and simply never matches.

// Ordered root rules: if the lowercased raw contains `needle`, add `tokens`.
// Several needles can fire (multi-token). Specific cuisines are listed before the
// broad "american" so an "X-American" value keeps its specific token too.
const RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["tex-mex", ["tex-mex", "mexican"]],
  ["tex mex", ["tex-mex", "mexican"]],
  ["mexican", ["mexican"]],
  ["italian", ["italian"]],
  ["chinese", ["chinese", "asian"]],
  ["japanese", ["japanese", "asian"]],
  ["thai", ["thai", "asian"]],
  ["vietnamese", ["vietnamese", "asian"]],
  ["korean", ["korean", "asian"]],
  ["filipino", ["asian"]],
  ["asian", ["asian"]],
  ["indian", ["indian"]],
  ["greek", ["greek", "mediterranean"]],
  ["middle eastern", ["middle-eastern", "mediterranean"]],
  ["middle-eastern", ["middle-eastern", "mediterranean"]],
  ["mediterranean", ["mediterranean"]],
  ["french", ["french"]],
  ["spanish", ["spanish"]],
  ["brazilian", ["brazilian", "latin-american"]],
  ["latin", ["latin-american"]],
  ["caribbean", ["caribbean"]],
  ["african", ["african"]],
  ["cajun", ["cajun"]],
  ["creole", ["cajun"]],
  ["soul", ["soul-food", "american"]],
  ["southern", ["soul-food", "american"]],
  ["barbecue", ["bbq", "american"]],
  ["bbq", ["bbq", "american"]],
  ["grill", ["bbq", "american"]],
  ["comfort", ["comfort-food", "american"]],
  ["southwest", ["american"]],
  ["american", ["american"]],
] as const;

/** Canonical cuisine tokens present in a raw label (meal cuisineType OR user pref). */
export function normalizeCuisineTokens(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  const s = raw.toLowerCase();
  for (const [needle, tokens] of RULES) {
    if (s.includes(needle)) for (const t of tokens) out.add(t);
  }
  return out;
}

/** Union of canonical tokens across a user's selected cuisines. */
export function userCuisineTokens(cuisines: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of cuisines) for (const t of normalizeCuisineTokens(c)) out.add(t);
  return out;
}

/**
 * Does a meal's cuisineType satisfy the user's cuisine prefs? True when their
 * canonical token sets intersect. An empty `userTokens` (no prefs given) is
 * treated as "no constraint" by callers — this returns false for it, so callers
 * must special-case the no-prefs path.
 */
export function cuisineMatches(
  mealCuisine: string | null | undefined,
  userTokens: Set<string>,
): boolean {
  if (userTokens.size === 0) return false;
  const mealTokens = normalizeCuisineTokens(mealCuisine);
  for (const t of mealTokens) if (userTokens.has(t)) return true;
  return false;
}
