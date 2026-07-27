// Plan-Gen Arc · Block 4b-1 (D-WS9-075) — the catalog allergen HARD filter.
//
// Until now the shortlist filtered only isPublic/isArchived/mealType and did NOT
// consult `Meal.allergens` (stamped by the store-fill harness, 9 canonical
// tokens) — the AI never even saw allergen data and judged safety off tag prose.
// This maps the user's fixed-list allergy labels (domain.ts ALLERGIES_AND_
// AVOIDANCES) to those tokens and excludes any matching meal at retrieval.
//
// Conservative default (safety): when a user has ANY mapped allergy, a meal that
// carries NO allergen stamp is EXCLUDED, not admitted — an unstamped meal is
// unknown, and unknown ≠ safe. Coverage supports this: 61/1124 catalog meals are
// unstamped and the worst-case residual pool (dairy) is still 228 meals, so the
// conservative rule never empties the pool for a single allergy.
//
// ⚠️ Vocabulary residual (data limitation, NOT a filter bug — logged as launch-prep):
// "Gluten-free" maps to the `wheat` token, but the stamp vocabulary has no barley
// or rye token, so a coeliac user can still be served a barley/rye dish that
// carries no wheat stamp. A re-stamp is out of scope for this block.
//
// Free-text picky avoidances (pickyAvoidances, dietaryNotes) are NOT structured
// allergens and are deliberately NOT fed to this hard filter — they remain soft
// signals the AI reasons over.

import type { Prisma } from "@prisma/client";

// UI label (normalized: lowercased, non-alnum → single space) → stamp token(s).
const LABEL_TO_TOKENS: Record<string, readonly string[]> = {
  "dairy free": ["dairy"],
  "gluten free": ["wheat"], // residual: barley/rye not in the stamp vocab
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
    { allergens: { isEmpty: false } },
  ];
}
