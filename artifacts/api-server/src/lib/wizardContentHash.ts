// Block 1 (BUG-030) — content-derived idempotency key for wizard plans.
//
// Phase 0 finding: `candidate.id` is an AI-minted free string — not durable,
// can collide across generate calls, and regenerates on every call. It is
// therefore useless as an idempotency key. Instead we derive a stable key
// from the candidate's CONTENT: its title plus its meal titles (order-
// independent). Two expands of the same candidate — even across a back-out
// and re-tap, or a client that lost the AI id — hash to the same key, so the
// server can reuse the existing unconsumed draft (and the existing
// materialized plan) instead of minting duplicates.
//
// The key is scoped to a user at query time (the caller filters by userId);
// the hash itself intentionally excludes userId so it is a pure function of
// the plan content and trivially unit-testable.

import { createHash } from "node:crypto";

// Normalize a single title so trivial formatting differences (case, padding,
// collapsed internal whitespace, Unicode form) do not defeat the match. This
// is deliberately conservative — it does NOT stem or reorder words, only
// canonicalizes whitespace/case/Unicode, so genuinely different meals stay
// distinct.
function normalizeTitle(s: string): string {
  return s
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Compute the content-derived idempotency key for a wizard plan candidate.
 *
 * Order-independent across meal titles (the array is normalized then sorted),
 * so a candidate whose meals are reordered still yields the same key. Empty /
 * whitespace-only meal titles are dropped before hashing.
 *
 * @param title      the candidate/plan title
 * @param mealTitles the candidate's meal titles (any order)
 * @returns a hex SHA-256 digest — stable, collision-resistant, storable as a
 *          short-ish string in a nullable indexed column.
 */
export function computeWizardContentHash(
  title: string,
  mealTitles: readonly string[],
): string {
  const normTitle = normalizeTitle(title);
  const normMeals = mealTitles
    .map(normalizeTitle)
    .filter((t) => t.length > 0)
    .sort();
  // JSON.stringify over a fixed-shape object gives an unambiguous, delimiter-
  // safe canonical form (a meal title containing the delimiter can't forge a
  // collision the way a naive join("|") would).
  const canonical = JSON.stringify({ t: normTitle, m: normMeals });
  return createHash("sha256").update(canonical).digest("hex");
}
