// Plan-Gen Arc · Block 4b-1 (D-WS9-075) — the catalog allergen HARD filter.
//
// Until now the shortlist filtered only isPublic/isArchived/mealType and did NOT
// consult `Meal.allergens` (10 canonical tokens — see lib/allergens.ts, which
// owns the vocabulary and is called from every path into the shared pool)
// — the AI never even saw allergen data and judged safety off tag prose.
// This maps the user's fixed-list allergy labels (domain.ts ALLERGIES_AND_
// AVOIDANCES) to those tokens and excludes any matching meal at retrieval.
//
// Conservative default (safety): when a user has ANY mapped allergy, a meal that
// carries NO allergen stamp is EXCLUDED, not admitted — an unstamped meal is
// unknown, and unknown ≠ safe. The conservative rule never empties the pool for
// a single allergy — worst case (dairy) still leaves a few hundred meals.
//
// ⚠️ THE COVERAGE FIGURE THAT USED TO SIT HERE ("61/1124 unstamped") WAS STALE
// AND THE STALENESS WAS THE POINT. By 2026-09-04 it was 129 of 1,192, because
// only the batch harness ever stamped: the live write-back published 55 pool
// meals with `allergens: []`, every one of them excluded from every allergic
// user's shelf. Do not re-hardcode a coverage number here — it decays silently
// and reads as reassurance. The stamping paths are the invariant; count from the
// database when you need the figure.
//
// ✅ CLOSED (2026-09-04) — the gluten residual. "Gluten-free" used to map to the
// `wheat` token alone, and the stamp vocabulary had no barley or rye, so a
// coeliac could be served a barley/farro/rye dish carrying no wheat stamp
// (measured: 3 such meals passed the filter). The stamp vocabulary now carries a
// separate `gluten` token for the non-wheat gluten grains, and the mapping below
// resolves "Gluten-free" to BOTH.
//
// ⚠️ WHY TWO TOKENS AND NOT A WIDER `wheat`. Gluten ⊋ wheat, and the two chips
// are different questions. Someone avoiding WHEAT may eat barley; a coeliac may
// not. Folding barley into `wheat` would exclude barley dishes from the
// wheat-avoider too — a reach loss with no safety gain — and there would be no
// way to express the difference. Two tokens make "Wheat-free" ⊂ "Gluten-free"
// exactly, which is the real relationship.
//
// Free-text picky avoidances (pickyAvoidances, dietaryNotes) are NOT structured
// allergens and are deliberately NOT fed to this hard filter — they remain soft
// signals the AI reasons over.

import type { Prisma } from "@prisma/client";

// UI label (normalized: lowercased, non-alnum → single space) → stamp token(s).
const LABEL_TO_TOKENS: Record<string, readonly string[]> = {
  "dairy free": ["dairy"],
  // Gluten-free excludes BOTH; Wheat-free excludes `wheat` alone. That
  // asymmetry is the point — see the header note.
  "gluten free": ["wheat", "gluten"],
  "wheat free": ["wheat"],
  "egg free": ["egg"],
  "soy free": ["soy"],
  "peanut free": ["peanut"],
  "tree nut free": ["tree_nut"],
  "nut free": ["peanut", "tree_nut"],
  "sesame free": ["sesame"],
  "fish free": ["fish"],
  "shellfish free": ["shellfish"],
};

function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Map a user's `allergiesAndAvoidances` to the canonical stamp tokens to exclude.
 * Unrecognized entries (free-text avoidances, picky items) are dropped — they are
 * not hard allergens. De-duplicated.
 */
export function allergenTokensForUser(labels: string[]): string[] {
  const out = new Set<string>();
  for (const raw of labels) {
    const tokens = LABEL_TO_TOKENS[normalizeLabel(raw)];
    if (tokens) for (const t of tokens) out.add(t);
  }
  return [...out];
}

/**
 * Prisma `where` conditions for the allergen hard filter. Returns an empty array
 * when the user has no mapped allergy (no constraint). Otherwise: exclude any meal
 * whose stamped allergens intersect the user's tokens, AND require a non-empty
 * stamp (conservative — unstamped is excluded).
 */
export function allergenWhereConditions(tokens: string[]): Prisma.MealWhereInput[] {
  if (tokens.length === 0) return [];
  return [
    { NOT: { allergens: { hasSome: tokens } } },
    // D-WS9-214 — was `{ allergens: { isEmpty: false } }`.
    //
    // The conservative rule is unchanged: unknown is still excluded. What
    // changed is how "unknown" is spelled. An empty `allergens` array meant BOTH
    // "we derived this meal and it contains none of the ten allergens" and "we
    // never looked", so the safe reading of the second sense silently condemned
    // the first: 64 verified-clean public dinners were invisible to every
    // allergic user, among them a Coconut Chickpea Curry — precisely the meal a
    // dairy-free user opens the app for.
    //
    // `allergensStampedAt` separates the two. NULL means never evaluated and is
    // still excluded; non-NULL with an empty array means evaluated and clean,
    // and is now admitted. Note this is strictly SAFER than what it replaces as
    // well as more generous: a row whose stamp was cleared by a bad write used
    // to look "clean and empty" and pass, and now reads as never-stamped.
    { allergensStampedAt: { not: null } },
  ];
}
